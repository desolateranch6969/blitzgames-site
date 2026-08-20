/**
 * Build a voice profile from real messages.
 *
 * This is the file that makes the whole design pay off. Everything else in the
 * engine already reads its voice from a profile object; this turns a folder of
 * his actual DMs into one. When the corpus lands, nothing else changes.
 *
 * What it measures:
 *   - style       how he capitalizes, punctuates, abbreviates, uses emoji, and
 *                 whether he sends one message or three
 *   - tics        repeated phrases that show up across many messages
 *   - phrases     his real wording, bucketed by what the message was doing
 *   - exemplars   lead/agent pairs used as few-shot material for the LLM realizer
 *
 * Corpus formats accepted (JSONL, one object per line):
 *   {"lead": "...", "agent": "..."}          <- best: gives phrases AND exemplars
 *   {"role": "agent", "text": "..."}         <- style and tics only
 *   {"role": "lead",  "text": "..."}         <- context for the pair above it
 *
 * A Meta data export can be converted first with `fromInstagramExport()`.
 *
 * A note on sample size: style statistics stabilize around 200 messages, phrase
 * banks want 20+ examples per act, and anything under ~50 messages should be
 * merged over the baseline profile rather than used alone. `report()` says which
 * of those thresholds the corpus actually cleared instead of leaving it to guess.
 */
import { readFileSync } from 'node:fs';
import { createVoiceProfile, mergeVoiceProfiles, FALLBACK_PHRASES } from './profile.js';

const EMOJI_RE = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{1F900}-\u{1F9FF}]/gu;

/**
 * Which speech act an outgoing message was performing. Deliberately
 * conservative: an unrecognized message contributes to style and tics but never
 * pollutes a phrase bank, because a miscategorized phrase gets said at the wrong
 * moment forever.
 */
const ACT_DETECTORS = [
  ['ask.budget', /\b(budget|price range|how much (are you|do you want to) (looking to )?(spend|pay)|what.*stay under|max.*rent)\b.*\?/],
  ['ask.moveIn', /\b(when.*(move|move in|need to be in)|move in date|timeline|how soon)\b.*\?/],
  ['ask.beds', /\b(how many (bed|bedroom)|1 bed.*2 bed|bedroom count|studio.*1 bed)\b.*\?/],
  ['ask.areas', /\b(what (area|part of town)|where (do|are) you (want|looking)|which (area|neighborhood)|where.*work)\b.*\?/],
  ['ask.occupants', /\b(how many (people|adults)|just you|on the lease)\b.*\?/],
  ['ask.pets', /\b(any pets|pets\?|you got any pets|pet or)\b/],
  ['ask.screening', /\b(broken lease|eviction|background|anything on your (record|rental history))\b.*\?/],
  ['ask.income', /\b(income|make (monthly|a month)|gross)\b.*\?/],
  ['ask.contact', /\b(best (number|#)|good number|whats your number|number to (text|reach|call))\b/],
  ['answer.fee', /\b(free (for|to) you|dont pay|don.t pay|no (cost|charge)|costs? you nothing|property pays|they pay me|i get paid by)\b/],
  ['answer.process', /\b(how it works|i (pull|send) (you )?a list|then we tour|i set up the tours|my process)\b/],
  ['answer.screening', /\b(3x|three times|credit (and|\+) background|income requirement|most places want)\b/],
  ['answer.pets', /\b(pet (friendly|fee|rent|deposit)|breed restriction|weight limit)\b/],
  ['answer.specials', /\b(special|concession|(weeks?|months?) free|move in deal|look and lease)\b/],
  ['answer.application', /\b(app(lication)? fee|admin fee|deposit|application is online)\b/],
  ['answer.listings.promise', /\b(let me (pull|put together|grab)|i.ll (pull|send|shoot|put)|send (you |over )?(a few|some|a list))\b/],
  ['answer.tour.promise', /\b(tour|showing|get you out there|set (it|them|some) up|what days? work)\b.*\?/],
  ['ack.tour.availability', /\b(works for me|that works|ill line|lock (in|it) (the )?times?|back to back)\b/],
  ['greet', /^(hey|yo|hi|hello|whats up|what.s up|good (morning|afternoon|evening))\b/],
  ['ack.thanks', /^(anytime|of course|no problem|you got it|happy to help|for sure)\b[\s!.]*$/],
];

/**
 * @typedef {Object} CorpusMessage
 * @property {'lead'|'agent'} role
 * @property {string} text
 * @property {string} [context]   The lead message this replies to, when known.
 */

/**
 * @param {string} path
 * @returns {CorpusMessage[]}
 */
export function loadCorpus(path) {
  const raw = readFileSync(path, 'utf8');
  /** @type {CorpusMessage[]} */
  const messages = [];

  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('#')) continue;
    let record;
    try {
      record = JSON.parse(trimmed);
    } catch {
      continue; // A bad line should never sink a whole corpus.
    }

    if (typeof record.agent === 'string') {
      if (typeof record.lead === 'string') messages.push({ role: 'lead', text: record.lead });
      messages.push({ role: 'agent', text: record.agent, context: record.lead });
    } else if (record.role && typeof record.text === 'string') {
      messages.push({ role: record.role === 'agent' ? 'agent' : 'lead', text: record.text });
    }
  }
  return messages;
}

/**
 * Convert a Meta/Instagram data export into corpus lines.
 * @param {string} path  A message_1.json file from the export.
 * @param {string} meName  The display name of the account being modeled.
 * @returns {CorpusMessage[]}
 */
export function fromInstagramExport(path, meName) {
  const data = JSON.parse(readFileSync(path, 'utf8'));
  const messages = [...(data.messages ?? [])].reverse(); // exports are newest-first
  /** @type {CorpusMessage[]} */
  const out = [];
  let lastLead = null;

  for (const message of messages) {
    const text = decodeExportText(message.content ?? '');
    if (!text || message.is_unsent) continue;
    const isAgent = (message.sender_name ?? '') === meName;
    if (isAgent) {
      out.push({ role: 'agent', text, context: lastLead ?? undefined });
    } else {
      lastLead = text;
      out.push({ role: 'lead', text });
    }
  }
  return out;
}

/** Instagram exports are UTF-8 bytes stored as latin-1 escapes. */
function decodeExportText(text) {
  try {
    return Buffer.from(text, 'latin1').toString('utf8');
  } catch {
    return text;
  }
}

/**
 * Measure how someone writes.
 * @param {CorpusMessage[]} corpus
 */
export function analyzeStyle(corpus) {
  const agentMessages = corpus.filter((m) => m.role === 'agent' && m.text.trim());
  const n = agentMessages.length || 1;

  let lowercaseStarts = 0;
  let terminalPunct = 0;
  let exclamations = 0;
  let withEmoji = 0;
  let totalWords = 0;
  /** @type {Map<string, number>} */
  const emojiCounts = new Map();
  /** @type {Map<string, number>} */
  const abbrevHits = new Map();
  /** @type {Map<string, number>} */
  const abbrevMisses = new Map();

  for (const { text } of agentMessages) {
    const t = text.trim();
    const firstAlpha = t.match(/[a-zA-Z]/)?.[0];
    if (firstAlpha && firstAlpha === firstAlpha.toLowerCase()) lowercaseStarts++;
    if (/[.!?]$/.test(t)) terminalPunct++;
    if (/!$/.test(t)) exclamations++;

    const emoji = t.match(EMOJI_RE) ?? [];
    if (emoji.length) {
      withEmoji++;
      for (const e of emoji) emojiCounts.set(e, (emojiCounts.get(e) ?? 0) + 1);
    }

    totalWords += t.split(/\s+/).filter(Boolean).length;

    for (const [long, short] of Object.entries(CANDIDATE_ABBREVIATIONS)) {
      const lower = t.toLowerCase();
      if (new RegExp(`\\b${escapeRe(short)}\\b`).test(lower)) abbrevHits.set(long, (abbrevHits.get(long) ?? 0) + 1);
      if (new RegExp(`\\b${escapeRe(long)}\\b`).test(lower)) abbrevMisses.set(long, (abbrevMisses.get(long) ?? 0) + 1);
    }
  }

  /** @type {Record<string, string>} */
  const abbreviations = {};
  let abbrevRateSum = 0;
  let abbrevRateCount = 0;
  for (const [long, short] of Object.entries(CANDIDATE_ABBREVIATIONS)) {
    const hits = abbrevHits.get(long) ?? 0;
    const misses = abbrevMisses.get(long) ?? 0;
    if (hits === 0) continue;
    abbreviations[long] = short;
    abbrevRateSum += hits / (hits + misses);
    abbrevRateCount++;
  }

  const bubbles = analyzeBursts(corpus);
  const emojiPalette = [...emojiCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([e]) => e);

  return {
    casing: lowercaseStarts / n > 0.6 ? 'lower' : lowercaseStarts / n < 0.2 ? 'sentence' : 'as-written',
    terminalPunctuationRate: round(terminalPunct / n),
    exclamationRate: round(exclamations / n),
    emojiRate: round(withEmoji / n),
    emojiPalette,
    maxEmojiPerMessage: emojiPalette.length ? 1 : 0,
    abbreviationRate: abbrevRateCount ? round(abbrevRateSum / abbrevRateCount) : 0,
    abbreviations,
    bubbles: {
      splitRate: bubbles.splitRate,
      maxBubbles: bubbles.maxBubbles,
      targetWordsPerBubble: Math.max(4, Math.round(totalWords / n)),
    },
  };
}

/** How often consecutive agent messages come in bursts rather than one block. */
function analyzeBursts(corpus) {
  let runs = 0;
  let multiRuns = 0;
  let longest = 1;
  let current = 0;

  for (const message of corpus) {
    if (message.role === 'agent') {
      current++;
    } else if (current > 0) {
      runs++;
      if (current > 1) multiRuns++;
      longest = Math.max(longest, current);
      current = 0;
    }
  }
  if (current > 0) {
    runs++;
    if (current > 1) multiRuns++;
    longest = Math.max(longest, current);
  }

  return {
    splitRate: runs ? round(multiRuns / runs) : 0.3,
    maxBubbles: Math.min(Math.max(longest, 1), 4),
  };
}

const CANDIDATE_ABBREVIATIONS = {
  you: 'u',
  your: 'ur',
  please: 'pls',
  with: 'w/',
  without: 'w/o',
  about: 'abt',
  apartment: 'apt',
  apartments: 'apts',
  number: '#',
  tomorrow: 'tmrw',
  tonight: 'tn',
  because: 'bc',
  thanks: 'thx',
};

/**
 * Recurring multi-word habits. Filtered against phrases that are just ordinary
 * English, so what survives is actually characteristic of this writer.
 * @param {CorpusMessage[]} corpus
 * @param {{min?: number, max?: number, minContexts?: number}} [opts]
 */
export function findTics(corpus, opts = {}) {
  const agentMessages = corpus.filter((m) => m.role === 'agent');
  if (agentMessages.length < 20) return [];

  /** @type {Map<string, number>} */
  const counts = new Map();
  /**
   * The set of distinct sentences each phrase turned up in. A habit shows up
   * across different messages; a sentence fragment only ever appears inside the
   * one sentence it was cut from, and that is the difference between "for sure"
   * and "me pull".
   * @type {Map<string, Set<string>>}
   */
  const contexts = new Map();

  for (const { text } of agentMessages) {
    const normalized = text.toLowerCase().replace(/[^\w\s']/g, ' ').replace(/\s+/g, ' ').trim();
    const words = normalized.split(' ').filter(Boolean);
    /** @type {Set<string>} */
    const seenHere = new Set();
    for (let size = opts.min ?? 2; size <= (opts.max ?? 4); size++) {
      for (let i = 0; i + size <= words.length; i++) {
        const gram = words.slice(i, i + size).join(' ');
        if (seenHere.has(gram)) continue;
        seenHere.add(gram);
        counts.set(gram, (counts.get(gram) ?? 0) + 1);
        if (!contexts.has(gram)) contexts.set(gram, new Set());
        contexts.get(gram).add(normalized.replace(gram, '').replace(/\s+/g, ' ').trim().slice(0, 40));
      }
    }
  }

  const total = agentMessages.length;
  const minContexts = opts.minContexts ?? 3;
  const ranked = [...counts.entries()]
    .filter(([gram, count]) => count / total >= 0.04 && count >= 4 && !isGenericPhrase(gram))
    .filter(([gram]) => (contexts.get(gram)?.size ?? 0) >= minContexts)
    .sort((a, b) => b[1] - a[1]);

  // Drop grams that are just fragments of a longer one we already kept, so a
  // four-word habit does not also show up as its own two-word prefix.
  /** @type {[string, number][]} */
  const distinct = [];
  for (const [gram, count] of ranked) {
    if (distinct.some(([kept]) => kept.includes(gram) || gram.includes(kept))) continue;
    distinct.push([gram, count]);
  }

  return distinct.slice(0, 6).map(([phrase, count]) => ({
    phrase,
    rate: round(Math.min(count / total, 0.25)),
    position: LEAD_MARKERS.test(phrase) ? 'lead' : 'trail',
  }));
}

const LEAD_MARKERS = /^(so|and|but|ok|okay|yeah|alright|for sure|no worries|honestly|real quick|listen)\b/;

/**
 * Discourse markers that are characteristic even though they start with an
 * ordinary word. Without this list the filter below throws away exactly the
 * phrases that make someone sound like themselves.
 */
const DISCOURSE_MARKERS = new Set([
  'for sure', 'no worries', 'i got you', 'of course', 'sounds good', 'let me know',
  'no problem', 'real quick', 'right now', 'no doubt', 'say less', 'my bad',
  'heads up', 'on it', 'for real', 'either way', 'to be honest', 'at all',
  'you good', 'we good', 'i gotchu', 'all good', 'in a bit', 'hang tight',
]);

const GENERIC_STARTS = /^(the|a|an|to|of|in|on|at|for|is|are|it|that|this|with|you|i|we|they|and|but|or|if|will|would|can|do|does|have|has|be|as|from)\b/;

function isGenericPhrase(gram) {
  if (DISCOURSE_MARKERS.has(gram)) return false;
  if (/\d/.test(gram)) return true;

  const words = gram.split(' ');
  if (words.every((w) => w.length <= 2)) return true;
  // A phrase that both starts and ends on filler is a sentence fragment
  // ("let me pull a"), not a habit.
  if (GENERIC_STARTS.test(gram)) return true;
  if (GENERIC_STARTS.test(words.at(-1))) return true;
  return false;
}

/**
 * Bucket his real messages by speech act.
 * @param {CorpusMessage[]} corpus
 * @param {{maxPerAct?: number}} [opts]
 */
export function extractPhraseBank(corpus, opts = {}) {
  const maxPerAct = opts.maxPerAct ?? 8;
  /** @type {Record<string, string[]>} */
  const phrases = {};
  /** @type {Record<string, number>} */
  const seen = {};

  for (const message of corpus) {
    if (message.role !== 'agent') continue;
    const text = message.text.trim();
    if (!text || text.length > 240) continue;

    const lower = text.toLowerCase();
    const act = ACT_DETECTORS.find(([, re]) => re.test(lower))?.[0];
    if (!act) continue;

    seen[act] = (seen[act] ?? 0) + 1;
    phrases[act] ??= [];
    // Keep distinct wordings only; ten copies of one sentence is not variety.
    const normalized = lower.replace(/[^\w\s]/g, '').replace(/\s+/g, ' ');
    if (phrases[act].some((p) => p.toLowerCase().replace(/[^\w\s]/g, '').replace(/\s+/g, ' ') === normalized)) continue;
    if (phrases[act].length < maxPerAct) phrases[act].push(text);
  }

  return { phrases, counts: seen };
}

/**
 * Lead/agent pairs for few-shot prompting, spread across as many different acts
 * as possible so the model sees his range rather than ten fee answers.
 * @param {CorpusMessage[]} corpus
 * @param {number} limit
 */
export function extractExemplars(corpus, limit = 20) {
  /** @type {{lead: string, agent: string, act: string}[]} */
  const candidates = [];

  for (const message of corpus) {
    if (message.role !== 'agent' || !message.context) continue;
    const lower = message.text.toLowerCase();
    const act = ACT_DETECTORS.find(([, re]) => re.test(lower))?.[0] ?? 'other';
    if (message.text.length > 300 || message.context.length > 300) continue;
    candidates.push({ lead: message.context, agent: message.text, act });
  }

  /** @type {Map<string, {lead: string, agent: string}[]>} */
  const byAct = new Map();
  for (const c of candidates) {
    if (!byAct.has(c.act)) byAct.set(c.act, []);
    byAct.get(c.act).push({ lead: c.lead, agent: c.agent });
  }

  const out = [];
  let round = 0;
  while (out.length < limit && round < 8) {
    let added = false;
    for (const list of byAct.values()) {
      if (list[round]) {
        out.push(list[round]);
        added = true;
        if (out.length >= limit) break;
      }
    }
    if (!added) break;
    round++;
  }
  return out;
}

/**
 * Build a complete voice profile from a corpus, merged over a base profile so
 * gaps in the corpus are still covered.
 *
 * @param {CorpusMessage[]} corpus
 * @param {{id: string, displayName?: string, base?: import('./profile.js').VoiceProfile, builtAt?: string}} opts
 */
export function buildProfileFromCorpus(corpus, opts) {
  const agentCount = corpus.filter((m) => m.role === 'agent').length;
  const style = analyzeStyle(corpus);
  const tics = findTics(corpus);
  const { phrases, counts } = extractPhraseBank(corpus);
  const exemplars = extractExemplars(corpus);

  const learned = createVoiceProfile({
    id: opts.id,
    displayName: opts.displayName ?? `${opts.id} (learned)`,
    version: '1.0.0',
    provenance: {
      source: 'learned-from-corpus',
      sampleCount: agentCount,
      builtAt: opts.builtAt,
      note: 'Generated by src/voice/learn.js. Review the phrase bank before going live — anything the corpus did not cover falls back to the base profile.',
    },
    style,
    tics,
    phrases,
    exemplars,
  });

  const profile = opts.base ? mergeVoiceProfiles(opts.base, learned) : learned;
  return { profile, report: report(agentCount, counts, style, tics, exemplars) };
}

/**
 * An honest account of what the corpus could and could not support. Saying "12
 * acts still use baseline wording" is far more useful than a profile that looks
 * complete and quietly is not.
 */
function report(agentCount, counts, style, tics, exemplars) {
  const allActs = Object.keys(FALLBACK_PHRASES);
  const learnedActs = Object.keys(counts);
  const thin = learnedActs.filter((a) => counts[a] < 3);
  const missing = allActs.filter((a) => !learnedActs.includes(a));

  return {
    sampleCount: agentCount,
    confidence:
      agentCount >= 200 ? 'good' : agentCount >= 50 ? 'usable, merge over baseline' : 'too thin, treat as a hint',
    learnedActs: learnedActs.sort(),
    thinActs: thin.sort(),
    actsUsingBaseline: missing.sort(),
    ticsFound: tics.map((t) => t.phrase),
    exemplarCount: exemplars.length,
    style,
    recommendations: [
      agentCount < 50 ? 'Collect more messages: style stats settle around 200, phrase banks want 20+ per act.' : null,
      missing.length ? `${missing.length} speech acts have no real examples and will use baseline wording.` : null,
      !tics.length && agentCount >= 20 ? 'No repeated phrases stood out — the voice will rely on style alone.' : null,
      !exemplars.length ? 'No lead/agent pairs found; the LLM realizer works far better with paired data.' : null,
    ].filter(Boolean),
  };
}

function round(n) {
  return Math.round(n * 100) / 100;
}

function escapeRe(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
