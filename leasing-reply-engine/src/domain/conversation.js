/**
 * Conversation state and lead qualification.
 *
 * The stage machine is intentionally shallow — real DM threads do not march
 * through a funnel, they jump around. Stage is a summary of how far the lead has
 * gotten, not a gate on what they are allowed to say next.
 */

export const STAGES = /** @type {const} */ ({
  NEW: 'new',
  QUALIFYING: 'qualifying',
  QUALIFIED: 'qualified',
  MATCHING: 'matching',     // options sent, waiting on feedback
  TOURING: 'touring',
  APPLYING: 'applying',
  CLOSED: 'closed',
});

/**
 * The order a working leasing agent actually asks in. Timing and area come
 * first because they eliminate the most inventory; screening history comes
 * before a list is sent, because sending a list a lead can't be approved for
 * wastes everyone's day.
 */
export const SLOT_PRIORITY = ['moveIn', 'areas', 'beds', 'budget', 'occupants', 'pets', 'screening', 'income', 'contact'];

/** Slots that must be known before a list of options is worth sending. */
export const REQUIRED_FOR_QUALIFIED = ['moveIn', 'areas', 'beds', 'budget'];

/**
 * @param {{threadId: string, channel: string, contact?: object}} init
 * @returns {import('../core/types.js').Conversation}
 */
export function createConversation(init) {
  const now = Date.now();
  return {
    threadId: init.threadId,
    channel: init.channel,
    contact: { id: init.contact?.id ?? init.threadId, ...(init.contact ?? {}) },
    slots: {},
    turns: [],
    stage: STAGES.NEW,
    status: 'active',
    flags: {},
    askedSlots: [],
    createdAt: now,
    updatedAt: now,
    ext: {},
  };
}

/**
 * Is a slot filled in a way we can act on?
 * @param {import('../core/types.js').Slots} slots
 * @param {string} name
 */
export function hasSlot(slots, name) {
  const v = slots?.[name];
  if (v == null) return false;
  if (Array.isArray(v)) return v.length > 0;
  if (name === 'beds' || name === 'baths') return Number.isFinite(v);
  if (name === 'budget') return v.max != null || v.min != null;
  if (name === 'moveIn') return Boolean(v.iso || v.text);
  if (name === 'contact') return Boolean(v.phone || v.email);
  if (name === 'income') return v.monthlyGross != null;
  if (name === 'screening') return Object.keys(v).length > 0;
  if (typeof v === 'object') return Object.keys(v).length > 0;
  return true;
}

/**
 * Record that we asked for a slot, so the engine can tell the difference
 * between "never asked" and "asked and ignored".
 * @param {import('../core/types.js').Conversation} convo
 * @param {string} slot
 */
export function recordAsk(convo, slot) {
  convo.askedSlots = [...new Set([...(convo.askedSlots ?? []), slot])];
  const log = (convo.flags.askLog ??= {});
  const entry = (log[slot] ??= { count: 0, atTurn: 0 });
  entry.count += 1;
  entry.atTurn = convo.turns.length;
}

/**
 * The single next thing worth asking. One question per message: stacking three
 * questions into one DM is the fastest way to get no answers at all.
 *
 * A slot that was asked and ignored is not dead forever — the four required
 * fields get one more try a few turns later, because leads answer out of order
 * and drop questions all the time. Everything else is asked once and let go;
 * nagging a lead about pets is how a thread goes cold.
 *
 * @param {import('../core/types.js').Conversation} convo
 * @returns {string|null}
 */
export function nextMissingSlot(convo) {
  const askLog = convo.flags?.askLog ?? {};
  const asked = new Set(convo.askedSlots ?? []);
  const qualified = isQualified(convo).ok;

  for (const slot of SLOT_PRIORITY) {
    if (hasSlot(convo.slots, slot)) continue;

    const log = askLog[slot];
    if (log) {
      const required = REQUIRED_FOR_QUALIFIED.includes(slot);
      const turnsSince = convo.turns.length - (log.atTurn ?? 0);
      if (!required || log.count >= 2 || turnsSince < 4) continue;
    } else if (asked.has(slot)) {
      continue; // asked before this bookkeeping existed
    }

    // Ask these only once the basics are in hand — they read as intrusive cold.
    if ((slot === 'screening' || slot === 'income' || slot === 'contact') && !qualified) continue;
    if (slot === 'occupants' && !hasSlot(convo.slots, 'beds')) continue;
    return slot;
  }
  return null;
}

/**
 * @param {import('../core/types.js').Conversation} convo
 * @returns {{ok: boolean, missing: string[], have: string[]}}
 */
export function isQualified(convo) {
  const missing = REQUIRED_FOR_QUALIFIED.filter((s) => !hasSlot(convo.slots, s));
  return {
    ok: missing.length === 0,
    missing,
    have: REQUIRED_FOR_QUALIFIED.filter((s) => hasSlot(convo.slots, s)),
  };
}

/**
 * Income screening. Most conventional properties want gross monthly income at
 * roughly 3x the rent; this reports the arithmetic without ever telling a lead
 * they are denied — approval is the property's call, never the bot's.
 * @param {import('../core/types.js').Conversation} convo
 * @param {number} multiple
 */
export function incomeCheck(convo, multiple = 3) {
  const rent = convo.slots?.budget?.max ?? convo.slots?.budget?.min;
  const income = convo.slots?.income?.monthlyGross;
  if (!rent || !income) return { known: false };
  return {
    known: true,
    rent,
    income,
    multiple,
    required: rent * multiple,
    meets: income >= rent * multiple,
  };
}

/**
 * Screening facts that change which properties will take the lead. Surfaced to
 * the planner so the reply stays honest and to the portal so a human can see
 * why a lead was routed the way it was.
 * @param {import('../core/types.js').Conversation} convo
 */
export function screeningRisks(convo) {
  const s = convo.slots?.screening ?? {};
  const risks = [];
  if (s.eviction) risks.push('eviction');
  if (s.brokenLease) risks.push('broken_lease');
  if (s.felony) risks.push('felony');
  if (s.misdemeanor) risks.push('misdemeanor');
  if (s.bankruptcy) risks.push('bankruptcy');
  if (s.poorCredit) risks.push('credit');
  return risks;
}

/**
 * Advance the stage. Monotonic except for explicit closure: a lead who has
 * already toured does not go back to "qualifying" because they asked about pets.
 * @param {import('../core/types.js').Conversation} convo
 * @param {string} [proposed]
 */
export function advanceStage(convo, proposed) {
  const rank = [STAGES.NEW, STAGES.QUALIFYING, STAGES.QUALIFIED, STAGES.MATCHING, STAGES.TOURING, STAGES.APPLYING, STAGES.CLOSED];
  const current = rank.indexOf(convo.stage);
  let next = convo.stage;

  if (proposed) {
    next = rank.indexOf(proposed) > current ? proposed : convo.stage;
  } else if (convo.stage === STAGES.NEW && convo.turns.some((t) => t.role === 'lead')) {
    next = STAGES.QUALIFYING;
  }

  if (next === STAGES.QUALIFYING && isQualified(convo).ok) next = STAGES.QUALIFIED;
  convo.stage = next;
  return next;
}

/**
 * A compact, human-readable summary of the lead. This is the payload other
 * modules (CRM, portal, listing search) will want, so it is stable and boring
 * on purpose.
 * @param {import('../core/types.js').Conversation} convo
 */
export function summarizeLead(convo) {
  const s = convo.slots ?? {};
  const budget = s.budget ? (s.budget.min ? `$${s.budget.min}-${s.budget.max}` : `up to $${s.budget.max}`) : null;
  return {
    threadId: convo.threadId,
    channel: convo.channel,
    name: convo.contact?.name ?? convo.contact?.handle ?? null,
    stage: convo.stage,
    status: convo.status,
    budget,
    beds: s.beds ?? null,
    baths: s.baths ?? null,
    moveIn: s.moveIn?.iso ?? s.moveIn?.text ?? null,
    areas: s.areas ?? [],
    occupants: s.occupants ?? null,
    pets: s.pets ?? null,
    amenities: s.amenities ?? [],
    screeningRisks: screeningRisks(convo),
    income: incomeCheck(convo),
    contact: s.contact ?? null,
    qualified: isQualified(convo),
    messageCount: convo.turns.length,
    createdAt: convo.createdAt,
    updatedAt: convo.updatedAt,
  };
}
