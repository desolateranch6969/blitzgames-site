/**
 * Prompt construction for the model-backed realizer.
 *
 * The model is deliberately given a narrow job: rewrite an already-decided reply
 * in the agent's voice. It does not choose what to say, what to promise, or what
 * to ask next — the planner did that, and the planner is testable. This is what
 * keeps a model in the loop from becoming a liability: it can change the words,
 * never the commitments.
 *
 * Everything the model knows about how the agent sounds comes from the voice
 * profile, so the same prompt builder works for the interim standard voice and
 * for a profile learned from real DM exports.
 */

/**
 * @param {import('../voice/profile.js').VoiceProfile} profile
 * @param {import('../domain/business.js').BusinessProfile} business
 */
export function buildSystemPrompt(profile, business) {
  const style = profile.style;
  const tics = (profile.tics ?? []).map((t) => `"${t.phrase}"`).join(', ');
  const emoji = (style.emojiPalette ?? []).join(' ');
  const abbrevs = Object.entries(style.abbreviations ?? {})
    .map(([long, short]) => `${long} -> ${short}`)
    .join(', ');

  return [
    `You write Instagram DM replies as ${business.agentName}, an apartment locator who works with renters and gets paid by the properties.`,
    '',
    'YOUR ONLY JOB is to rewrite a reply that has already been decided, so it sounds like this person typed it on their phone.',
    'You never decide what to say. You never add information. You never remove a question that was planned.',
    '',
    '## How this person writes',
    `- Capitalization: ${describeCasing(style.casing)}`,
    `- Ends messages with punctuation about ${pct(style.terminalPunctuationRate)} of the time; uses "!" about ${pct(style.exclamationRate)} of the time.`,
    `- Uses emoji in roughly ${pct(style.emojiRate)} of messages, at most ${style.maxEmojiPerMessage} per message${emoji ? `, only from: ${emoji}` : ''}.`,
    abbrevs ? `- Abbreviates casually (${abbrevs}) about ${pct(style.abbreviationRate)} of the time.` : '',
    `- Typical message is around ${style.bubbles.targetWordsPerBubble} words. Often sends ${style.bubbles.maxBubbles > 1 ? `up to ${style.bubbles.maxBubbles} short messages back to back` : 'one message'} instead of one long paragraph.`,
    tics ? `- Recurring habits: ${tics}. Use at most one, and only when it fits.` : '',
    '',
    '## Hard rules — these override the voice',
    '1. Fair housing: never describe a neighborhood, building, or the people who live there. Never mention crime, safety, schools, children, religion, race, national origin, disability, or whether somewhere suits a "type" of person. If the planned reply declines such a question, keep that decline intact and do not soften it.',
    '2. Never promise approval, guarantee a price, or commit to availability. Properties decide those.',
    '3. Never invent a property name, address, rent, special, fee, or availability date. If it is not in the planned reply, it does not exist.',
    '4. Never reveal that this is automated, and never mention being an assistant or a model.',
    '5. Keep every question that was planned, and do not add new ones.',
    profile.banned?.length ? `6. Never use these phrases: ${profile.banned.map((b) => `"${b}"`).join(', ')}.` : '',
    '',
    '## Output format',
    `Return ONLY a JSON array of ${style.bubbles.maxBubbles} or fewer strings — one per DM bubble, in send order. No markdown, no commentary, no keys.`,
    'Example: ["ok cool 2 bed in uptown", "when are you trying to move?"]',
  ]
    .filter(Boolean)
    .join('\n');
}

function describeCasing(casing) {
  if (casing === 'lower') return 'almost always lowercase, even at the start of a sentence';
  if (casing === 'sentence') return 'standard sentence case';
  return 'natural, mixed';
}

function pct(rate) {
  return `${Math.round((rate ?? 0) * 100)}%`;
}

/**
 * Few-shot turns drawn from the voice profile's exemplars. When a learned
 * profile is built from real DM exports, these become real message pairs, and
 * the model's imitation gets sharply better without any prompt changes.
 *
 * @param {import('../voice/profile.js').VoiceProfile} profile
 * @param {number} limit
 */
export function buildFewShot(profile, limit = 6) {
  const messages = [];
  for (const example of (profile.exemplars ?? []).slice(0, limit)) {
    if (!example?.lead || !example?.agent) continue;
    messages.push(
      { role: 'user', content: `LEAD SAID: ${example.lead}\n\nPLANNED REPLY: (write it the way he would)` },
      { role: 'assistant', content: JSON.stringify([example.agent]) },
    );
  }
  return messages;
}

/**
 * The per-turn instruction: recent history, the plan, and the deterministic
 * draft the model is rewriting.
 *
 * @param {{conversation: import('../core/types.js').Conversation,
 *          plan: import('../core/types.js').Plan,
 *          draft: string[],
 *          historyLimit?: number}} input
 */
export function buildTurnMessage({ conversation, plan, draft, historyLimit = 8 }) {
  const history = conversation.turns
    .slice(-historyLimit)
    .map((t) => `${t.role === 'lead' ? 'LEAD' : 'YOU'}: ${t.text}`)
    .join('\n');

  const acts = plan.steps.map((s) => `- ${s.act}${describeActData(s)}`).join('\n');

  return [
    '## Conversation so far',
    history || '(this is the first message)',
    '',
    '## What this reply must do (do not add to this list, do not drop from it)',
    acts,
    '',
    '## Draft to rewrite in his voice',
    draft.map((d, i) => `${i + 1}. ${d}`).join('\n'),
    '',
    'Rewrite the draft so it sounds like him. Same meaning, same questions, same commitments. Return only the JSON array.',
  ].join('\n');
}

/** Surface only the facts the model is allowed to restate. */
function describeActData(step) {
  const data = step.data ?? {};
  if (step.act === 'answer.listings.results' && data.results?.length) {
    return ` (list exactly these: ${data.results.map((r) => r.name ?? r.title).join(', ')})`;
  }
  if (step.act === 'ack.criteria' && data.changed?.length) {
    return ` (reflect back: ${data.changed.join(', ')})`;
  }
  if (step.act === 'handoff.human' && data.reason) return ` (reason: ${data.reason})`;
  return '';
}

/**
 * Parse whatever the model returned into message parts, defensively.
 * A malformed response must never take the reply down — the caller falls back
 * to the deterministic draft.
 *
 * @param {string} text
 * @returns {string[]|null}
 */
export function parseModelParts(text) {
  if (!text) return null;
  const trimmed = text.trim().replace(/^```(?:json)?\s*|\s*```$/g, '');

  try {
    const parsed = JSON.parse(trimmed);
    if (Array.isArray(parsed) && parsed.every((p) => typeof p === 'string')) {
      const parts = parsed.map((p) => p.trim()).filter(Boolean);
      return parts.length ? parts : null;
    }
  } catch {
    // fall through to salvage
  }

  const match = trimmed.match(/\[[\s\S]*\]/);
  if (match) {
    try {
      const parsed = JSON.parse(match[0]);
      if (Array.isArray(parsed)) {
        const parts = parsed.filter((p) => typeof p === 'string').map((p) => p.trim()).filter(Boolean);
        return parts.length ? parts : null;
      }
    } catch {
      // fall through
    }
  }

  // Last resort: treat non-empty lines as bubbles.
  const lines = trimmed.split('\n').map((l) => l.replace(/^\s*[-*\d.)\s]+/, '').trim()).filter(Boolean);
  return lines.length ? lines.slice(0, 3) : null;
}
