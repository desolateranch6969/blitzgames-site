/**
 * The template realizer: plan (what to say) + voice profile (how it sounds) -> text.
 *
 * This backend never touches the network, so it is always available and always
 * fast. It is also the fallback for the LLM realizer, which means a model
 * outage degrades the voice, never the service.
 *
 * Variant selection is seeded by the thread and turn, and remembers what it has
 * already used in this conversation, so a lead never gets the same sentence
 * twice while a retried webhook always gets the same reply.
 */
import { createRng, pickFresh } from '../core/rng.js';
import { groupIntoBubbles, stylize, computeDelays } from './humanize.js';

/**
 * @param {number} n
 */
export function formatMoney(n) {
  if (n == null) return '';
  return `$${Math.round(n).toLocaleString('en-US')}`;
}

/** @param {{min?: number, max?: number}} budget */
export function formatBudget(budget) {
  if (!budget) return '';
  if (budget.min && budget.max) return `${formatMoney(budget.min)}-${formatMoney(budget.max)}`;
  if (budget.max) return `up to ${formatMoney(budget.max)}`;
  if (budget.min) return `starting around ${formatMoney(budget.min)}`;
  return '';
}

/** @param {number} beds */
export function formatBeds(beds) {
  if (beds == null) return '';
  if (beds === 0) return 'studio';
  return `${beds} bed`;
}

/** @param {{iso?: string, text?: string, flexible?: boolean}} moveIn */
export function formatMoveIn(moveIn) {
  if (!moveIn) return '';
  if (moveIn.text && /asap|flexible|next month|end of|lease/.test(moveIn.text)) return moveIn.text;
  if (moveIn.iso) {
    const [y, m, d] = moveIn.iso.split('-').map(Number);
    const month = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'][m - 1];
    return `${month} ${d}`;
  }
  return moveIn.text ?? '';
}

/** @param {string[]} areas */
export function formatAreas(areas) {
  const list = (areas ?? []).filter(Boolean);
  if (!list.length) return '';
  if (list.length === 1) return list[0];
  if (list.length === 2) return `${list[0]} or ${list[1]}`;
  return `${list.slice(0, -1).join(', ')}, or ${list.at(-1)}`;
}

/** @param {{has: boolean, kind?: string, count?: number, weightLb?: number}} pets */
export function formatPets(pets) {
  if (!pets) return '';
  if (!pets.has) return 'no pets';
  const count = pets.count && pets.count > 1 ? `${pets.count} ` : '';
  const kind = pets.kind === 'assistance_animal' ? 'assistance animal' : pets.kind ?? 'pet';
  const plural = pets.count && pets.count > 1 ? 's' : '';
  const weight = pets.weightLb ? ` (${pets.weightLb}lb)` : '';
  return `${count}${kind}${plural}${weight}`;
}

/**
 * Reflect back only what the lead just said. Repeating facts they gave three
 * messages ago sounds like a database read; repeating what they just typed
 * sounds like listening.
 * @param {string[]} changed
 * @param {import('../core/types.js').Slots} slots
 */
export function summarizeCriteria(changed, slots) {
  const parts = [];
  const has = (k) => changed.includes(k);

  if (has('beds') || has('baths')) {
    const beds = formatBeds(slots.beds);
    const baths = slots.baths != null && slots.beds != null ? `/${slots.baths}` : '';
    if (beds) parts.push(baths ? `${slots.beds}${baths}` : beds);
  }
  if (has('areas') && slots.areas?.length) parts.push(`in ${formatAreas(slots.areas)}`);
  if (has('budget') && slots.budget) parts.push(formatBudget(slots.budget));
  if (has('moveIn') && slots.moveIn) parts.push(`moving ${formatMoveIn(slots.moveIn)}`);
  if (has('occupants') && slots.occupants) {
    parts.push(slots.occupants === 1 ? 'just you' : `${slots.occupants} on the lease`);
  }
  if (has('pets') && slots.pets) parts.push(formatPets(slots.pets));

  if (!parts.length) return '';
  // One fact reads as an aside; several read as a recap.
  return parts.length === 1 ? `, ${parts[0]}` : ` — ${parts.join(', ')}`;
}

/**
 * Build the placeholder context for a phrase template.
 * @param {import('../core/types.js').PlanStep} step
 * @param {import('../core/types.js').Conversation} convo
 * @param {import('../domain/business.js').BusinessProfile} business
 */
export function buildRenderContext(step, convo, business) {
  const slots = convo.slots ?? {};
  const data = step.data ?? {};
  const firstName = (convo.contact?.name ?? '').trim().split(/\s+/)[0] ?? '';

  return {
    name: firstName ? ` ${firstName.toLowerCase()}` : '',
    agentName: business.agentName,
    brand: business.brand ?? business.agentName,
    multiple: String(business.screening?.incomeMultiple ?? 3),
    criteriaSummary: summarizeCriteria(data.changed ?? [], slots),
    beds: formatBeds(slots.beds),
    budget: formatBudget(slots.budget),
    areas: formatAreas(slots.areas),
    moveIn: formatMoveIn(slots.moveIn),
    pets: formatPets(slots.pets),
    when: data.when ?? slots.tourAvailability ?? '',
    listings: formatListings(data.results),
    tourSlots: formatTourSlots(data.slots),
    bookingUrl: business.service?.bookingUrl ?? '',
    phone: business.service?.phone ?? '',
  };
}

/** @param {any[]} results */
function formatListings(results) {
  if (!results?.length) return '';
  return (
    '\n' +
    results
      .map((r, i) => {
        const price = r.rentMin && r.rentMax ? `${formatMoney(r.rentMin)}-${formatMoney(r.rentMax)}` : formatMoney(r.rent ?? r.rentMax ?? r.rentMin);
        const bits = [r.name ?? r.title, r.area, price, r.special].filter(Boolean);
        return `${i + 1}) ${bits.join(' — ')}`;
      })
      .join('\n')
  );
}

/** @param {any[]} slots */
function formatTourSlots(slots) {
  if (!Array.isArray(slots) || !slots.length) return '';
  return '\n' + slots.map((s) => `- ${typeof s === 'string' ? s : s.label ?? s.start}`).join('\n');
}

/**
 * @param {string} template
 * @param {Record<string, string>} ctx
 */
export function renderPhrase(template, ctx) {
  return template
    .replace(/\{(\w+)\}/g, (_, key) => ctx[key] ?? '')
    .replace(/ {2,}/g, ' ')
    .replace(/\s+([,.!?])/g, '$1')
    .trim();
}

/**
 * Placeholders without which a phrase is nonsense ("here are a few that fit:"
 * followed by nothing). If the data is missing the fragment is dropped rather
 * than sent half-finished.
 * @type {Record<string, string[]>}
 */
export const REQUIRED_PLACEHOLDERS = {
  'answer.listings.results': ['listings'],
  'answer.tour.options': ['tourSlots'],
  'ack.tour.availability': ['when'],
};

/**
 * Choose a phrase variant, avoiding ones already used in this thread.
 * @param {import('./profile.js').VoiceProfile} profile
 * @param {string} act
 * @param {() => number} rng
 * @param {Set<string>} used
 */
export function pickVariant(profile, act, rng, used) {
  const variants = profile.phrases[act];
  if (!variants?.length) return null;
  return pickFresh(rng, variants, used, (v) => `${act}::${v}`);
}

/**
 * @param {{profile: import('./profile.js').VoiceProfile, business: import('../domain/business.js').BusinessProfile}} deps
 */
export function createTemplateRealizer({ profile, business }) {
  return {
    name: 'template',
    profileId: profile.id,

    /**
     * @param {{plan: import('../core/types.js').Plan, conversation: import('../core/types.js').Conversation, seed?: string}} input
     * @returns {Promise<{parts: string[], delaysMs: number[], fragments: {act: string, text: string}[]}>}
     */
    async realize({ plan, conversation, seed }) {
      const turnIndex = conversation.turns.length;
      const rng = createRng(seed ?? `${conversation.threadId}:${turnIndex}:${profile.id}`);

      // Per-thread memory of phrasings already used, so the voice does not loop.
      const ext = (conversation.ext ??= {});
      const voiceState = (ext.voice ??= { usedVariants: [] });
      const used = new Set(voiceState.usedVariants ?? []);

      /** @type {{act: string, text: string}[]} */
      const fragments = [];
      for (const step of plan.steps) {
        const template = pickVariant(profile, step.act, rng, used);
        if (!template) continue;

        const ctx = buildRenderContext(step, conversation, business);
        const required = REQUIRED_PLACEHOLDERS[step.act] ?? [];
        if (required.some((key) => !String(ctx[key] ?? '').trim())) continue;

        const text = renderPhrase(template, ctx);
        if (text) fragments.push({ act: step.act, text });
      }

      voiceState.usedVariants = [...used].slice(-60);

      if (!fragments.length) return { parts: [], delaysMs: [], fragments: [] };

      const bubbles = groupIntoBubbles(fragments, profile.style, rng);
      const styleState = {}; // shared so at most one verbal tic lands per reply
      const parts = bubbles.map((b) => stylize(b, profile, rng, styleState)).filter(Boolean);
      return { parts, delaysMs: computeDelays(parts, profile.style, rng), fragments: bubbles };
    },
  };
}
