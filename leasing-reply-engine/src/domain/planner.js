/**
 * The planner decides WHAT to say. The realizer decides HOW IT SOUNDS.
 *
 * Keeping those apart is the single most important decision in this module.
 * The plan is a short list of speech acts — auditable, unit-testable, and
 * identical no matter whose voice is loaded. Swap the voice profile and the
 * same lead gets the same commitments in different words. Fix a policy here and
 * every voice inherits the fix.
 *
 * The planner is also capability-aware. It asks the module host whether anyone
 * can search listings or book a tour yet. Today nobody can, so it plans a
 * promise ("I'll pull some and send them over"). The day a listings module
 * registers `listings.search`, the same conversation starts returning real
 * units — with no edit to this file.
 */
import { STAGES, advanceStage, isQualified, nextMissingSlot, recordAsk, incomeCheck, screeningRisks } from './conversation.js';

/** Every act the realizer must be able to voice. Voice profiles key off these. */
export const SPEECH_ACTS = /** @type {const} */ ([
  'greet',
  'ack.criteria',
  'ack.thanks',
  'ack.smalltalk',
  'answer.fee',
  'answer.process',
  'answer.screening',
  'answer.pets',
  'answer.specials',
  'answer.application',
  'answer.location',
  'answer.listings.promise',
  'answer.listings.results',
  'answer.tour.promise',
  'answer.tour.options',
  'ack.tour.availability',
  'ask.moveIn',
  'ask.areas',
  'ask.beds',
  'ask.budget',
  'ask.occupants',
  'ask.pets',
  'ask.screening',
  'ask.income',
  'ask.contact',
  'compliance.steering',
  'compliance.assistance_animal',
  'compliance.accessibility',
  'compliance.voucher',
  'handoff.human',
  'optout.ack',
  'fallback.unknown',
]);

/**
 * @typedef {Object} PlannerDeps
 * @property {import('./business.js').BusinessProfile} business
 * @property {(name: string) => boolean} hasCapability
 * @property {(name: string) => any} capability
 */

/**
 * @param {import('../core/types.js').Conversation} convo
 * @param {import('../core/types.js').Classification} classification
 * @param {{changedSlots?: string[]}} turnInfo
 * @param {PlannerDeps} deps
 * @returns {Promise<import('../core/types.js').Plan>}
 */
export async function plan(convo, classification, turnInfo, deps) {
  const intents = new Set(classification.all ?? []);
  const changed = turnInfo.changedSlots ?? [];
  /** @type {import('../core/types.js').PlanStep[]} */
  const steps = [];
  const notes = [];
  let handoff = false;

  // --- Hard stops. Nothing else in the message matters. --------------------
  if (intents.has('optout')) {
    return { steps: [{ act: 'optout.ack' }], note: 'lead asked to stop', handoff: false };
  }
  if (intents.has('spam')) {
    return { steps: [], note: 'classified as spam; no reply', silent: true };
  }
  if (convo.status === 'opted_out') {
    return { steps: [], note: 'thread is opted out', silent: true };
  }
  if (convo.status === 'awaiting_human') {
    return { steps: [], note: 'a human owns this thread', silent: true };
  }

  // --- Compliance outranks sales. ------------------------------------------
  // These get a neutral, factual answer and a human, every time. An automated
  // reply is exactly the wrong tool for a fair-housing question.
  if (intents.has('compliance.steering')) {
    return {
      steps: [{ act: 'compliance.steering' }, { act: 'handoff.human', data: { reason: 'fair_housing' } }],
      note: 'steering-risk question: neutral response + human handoff',
      handoff: true,
    };
  }
  if (intents.has('compliance.assistance_animal')) {
    steps.push({ act: 'compliance.assistance_animal' });
    handoff = true;
    notes.push('assistance animal disclosed');
  }
  if (intents.has('compliance.accessibility')) {
    steps.push({ act: 'compliance.accessibility' });
    handoff = true;
    notes.push('accessibility need disclosed');
  }
  if (intents.has('compliance.voucher')) {
    steps.push({ act: 'compliance.voucher' });
    handoff = true;
    notes.push('housing voucher mentioned');
  }
  if (intents.has('human.request')) {
    steps.push({ act: 'handoff.human', data: { reason: 'requested' } });
    return { steps, note: 'lead asked for a person', handoff: true };
  }

  const firstContact = !convo.turns.some((t) => t.role === 'agent');
  if (firstContact) steps.push({ act: 'greet', data: { name: convo.contact?.name } });

  // --- Acknowledge what they just told us. ---------------------------------
  // Reflecting the criteria back is what makes a reply feel heard rather than
  // processed, and it silently confirms we parsed them correctly.
  const meaningful = changed.filter((c) => c !== 'contact');
  if (meaningful.length) {
    steps.push({ act: 'ack.criteria', data: { changed: meaningful, slots: convo.slots } });
  }

  // --- Answer what they asked, in the order they'd expect. -----------------
  if (intents.has('ask.fee')) steps.push({ act: 'answer.fee', data: { fees: deps.business.fees } });
  if (intents.has('ask.process')) steps.push({ act: 'answer.process' });
  if (intents.has('ask.screening')) {
    steps.push({
      act: 'answer.screening',
      data: {
        risks: screeningRisks(convo),
        income: incomeCheck(convo, deps.business.screening.incomeMultiple),
        multiple: deps.business.screening.incomeMultiple,
      },
    });
  }
  if (intents.has('ask.pets')) steps.push({ act: 'answer.pets', data: { pets: convo.slots.pets } });
  if (intents.has('ask.specials')) steps.push({ act: 'answer.specials' });
  if (intents.has('ask.application')) steps.push({ act: 'answer.application' });
  if (intents.has('ask.location')) steps.push({ act: 'answer.location' });

  // --- Listings: real results if a module can produce them, a promise if not.
  if (intents.has('ask.listings') || (isQualified(convo).ok && convo.stage === STAGES.QUALIFIED)) {
    const results = await tryListings(convo, deps);
    if (results?.length) {
      steps.push({ act: 'answer.listings.results', data: { results } });
      advanceStage(convo, STAGES.MATCHING);
    } else if (intents.has('ask.listings')) {
      steps.push({ act: 'answer.listings.promise', data: { qualified: isQualified(convo) } });
    }
  }

  // A lead who just named a day is the closest thing this trade has to a
  // buying signal. Never let that land on a generic reply.
  if (changed.includes('tourAvailability') && !intents.has('ask.tour')) {
    const booked = await tryTourSlots(convo, deps);
    if (booked?.length) {
      steps.push({ act: 'answer.tour.options', data: { slots: booked } });
    } else {
      steps.push({
        act: 'ack.tour.availability',
        data: { when: convo.slots.tourAvailability, requireGuestCard: deps.business.compliance.requireGuestCard },
      });
    }
    advanceStage(convo, STAGES.TOURING);
    notes.push('lead gave tour availability');
  }

  // --- Tours: same pattern. ------------------------------------------------
  if (intents.has('ask.tour')) {
    const slots = await tryTourSlots(convo, deps);
    if (slots?.length) {
      steps.push({ act: 'answer.tour.options', data: { slots } });
    } else {
      steps.push({
        act: 'answer.tour.promise',
        data: { requireGuestCard: deps.business.compliance.requireGuestCard },
      });
    }
    advanceStage(convo, STAGES.TOURING);
  }

  // --- Then, and only then, ask for one more thing. ------------------------
  const askable = shouldAsk(convo, intents, steps) ? nextMissingSlot(convo) : null;
  if (askable) {
    steps.push({ act: `ask.${askable}`, data: { slot: askable, slots: convo.slots } });
    recordAsk(convo, askable);
  }

  // --- Nothing landed: say something human rather than nothing. ------------
  if (steps.length === 0) {
    if (intents.has('thanks')) steps.push({ act: 'ack.thanks' });
    else if (intents.has('smalltalk')) steps.push({ act: 'ack.smalltalk' });
    else steps.push({ act: 'fallback.unknown', data: { text: convo.turns.at(-1)?.text } });
  }

  advanceStage(convo);

  return {
    steps: steps.slice(0, 4),
    note: notes.join('; ') || describePlan(steps),
    handoff,
  };
}

/** Acts whose own wording already ends in a question. */
const SELF_QUESTIONING_ACTS = new Set(['answer.tour.promise', 'fallback.unknown', 'ack.tour.availability']);

/**
 * Don't pile a question on top of a heavy moment. If we just handed off to a
 * human, flagged compliance, already asked something, or the lead only said
 * thanks, an extra ask reads as tone-deaf.
 */
function shouldAsk(convo, intents, steps) {
  if (convo.status !== 'active') return false;
  if (steps.some((s) => s.act.startsWith('compliance.') || s.act === 'handoff.human')) return false;
  if (steps.some((s) => SELF_QUESTIONING_ACTS.has(s.act))) return false;
  if (intents.has('optout') || intents.has('spam')) return false;
  if (intents.has('thanks') && intents.size === 1) return false;
  if (convo.stage === STAGES.TOURING && !isQualified(convo).ok) return true;
  return true;
}

/** @param {import('../core/types.js').PlanStep[]} steps */
function describePlan(steps) {
  return steps.map((s) => s.act).join(' + ');
}

/**
 * Ask the host whether a listings module exists yet. The contract is the return
 * shape, not the implementation, so any future search backend fits.
 */
async function tryListings(convo, deps) {
  if (!deps.hasCapability('listings.search')) return null;
  try {
    const search = deps.capability('listings.search');
    const results = await search({ slots: convo.slots, threadId: convo.threadId, limit: 3 });
    return Array.isArray(results) ? results.slice(0, 3) : null;
  } catch {
    return null; // A broken bolt-on must degrade to the promise, never to silence.
  }
}

async function tryTourSlots(convo, deps) {
  if (!deps.hasCapability('tours.availability')) return null;
  try {
    const availability = deps.capability('tours.availability');
    const slots = await availability({ threadId: convo.threadId, slots: convo.slots });
    return Array.isArray(slots) ? slots.slice(0, 3) : null;
  } catch {
    return null;
  }
}
