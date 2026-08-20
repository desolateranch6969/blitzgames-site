/**
 * Triage: what kind of approach is this, and what should happen to it.
 *
 * ## No rankings. On purpose.
 *
 * This module never produces a lead score, a grade, a tier, a star rating, or a
 * sorted "best leads" list. Three reasons, and they are worth keeping in mind
 * when someone inevitably asks for one:
 *
 *   1. A score compresses away the reason. "72" tells an operator nothing they
 *      can act on; "stated a budget and a move date, no area yet" tells them
 *      exactly what to ask next.
 *   2. Scores get acted on as if they were measurements. A lead who typed three
 *      words is not worse than one who typed thirty; they typed three words.
 *   3. Ranking people by predicted value, in housing, drifts toward deciding who
 *      gets service and who does not. That is precisely the shape of a fair
 *      housing problem, and there is no reason to build the machinery for it.
 *
 * What comes out instead is a **disposition** — a routing decision — plus the
 * signals and the reasons behind it. Routing is not ranking: every disposition
 * has a defined next step, and none of them means "this person matters less."
 *
 * The output is deliberately free of numeric fields other than `confidence`,
 * which describes how sure the classifier is about ITS OWN CALL, never anything
 * about the person.
 */
import { createSignalDetector } from './signals.js';

/**
 * Routing classes. Each says what happens next, not how good the lead is.
 */
export const DISPOSITIONS = /** @type {const} */ ({
  /** A rental search is underway. Hand to the reply engine. */
  PROSPECTIVE_RENTER: 'prospective_renter',
  /** Interested, but nothing stated yet. Reply engine asks the first question. */
  NEEDS_QUALIFICATION: 'needs_qualification',
  /** Asking about the service itself. Answerable; often becomes a search. */
  GENERAL_QUESTION: 'general_question',
  /** A real person wanting something this business does not do. Reply once, kindly, and close. */
  NOT_SERVICEABLE: 'not_serviceable',
  /** Selling something or recruiting. No reply. */
  VENDOR_OR_RECRUITER: 'vendor_or_recruiter',
  /** Automated or fraudulent. No reply, no person record enrichment. */
  SPAM_OR_BOT: 'spam_or_bot',
  /** Someone he knows, socially. Never automated. */
  PERSONAL_OR_SOCIAL: 'personal_or_social',
  /** Not enough to classify. Held for a human glance. */
  UNCLEAR: 'unclear',
});

/** What the system does with each disposition. The portal renders this. */
export const ROUTING = {
  [DISPOSITIONS.PROSPECTIVE_RENTER]: { handOffToReplyEngine: true, enrich: true, notifyOperator: false },
  [DISPOSITIONS.NEEDS_QUALIFICATION]: { handOffToReplyEngine: true, enrich: true, notifyOperator: false },
  [DISPOSITIONS.GENERAL_QUESTION]: { handOffToReplyEngine: true, enrich: false, notifyOperator: false },
  [DISPOSITIONS.NOT_SERVICEABLE]: { handOffToReplyEngine: false, enrich: false, notifyOperator: true },
  [DISPOSITIONS.VENDOR_OR_RECRUITER]: { handOffToReplyEngine: false, enrich: false, notifyOperator: false },
  [DISPOSITIONS.SPAM_OR_BOT]: { handOffToReplyEngine: false, enrich: false, notifyOperator: false },
  [DISPOSITIONS.PERSONAL_OR_SOCIAL]: { handOffToReplyEngine: false, enrich: false, notifyOperator: true },
  [DISPOSITIONS.UNCLEAR]: { handOffToReplyEngine: false, enrich: false, notifyOperator: true },
};

/** Criteria a search needs before anyone can actually work it. */
const REQUIRED_CRITERIA = [
  ['stated_timeline', 'move date'],
  ['stated_area', 'area'],
  ['stated_size', 'bedroom count'],
  ['stated_budget', 'budget'],
];

/**
 * @param {{
 *   detector?: ReturnType<typeof createSignalDetector>,
 *   market?: {name?: string, areas?: string[]},
 *   extractSlots?: (text: string) => Record<string, any>,
 * }} [deps]
 */
export function createTriage(deps = {}) {
  const detector = deps.detector ?? createSignalDetector();

  /**
   * @param {{text: string, history?: any[], actorFacts?: Record<string, any>}} input
   * @returns {import('../core/types.js').Triage}
   */
  function classify(input) {
    const original = String(input.text ?? '');
    const slots = deps.extractSlots ? safeExtract(deps.extractSlots, original) : undefined;
    const signals = detector.detect({
      original,
      text: original.toLowerCase(),
      history: input.history,
      market: deps.market,
      slots,
    });

    const has = (kind) => signals.some((s) => s.kind === kind);
    const hasAny = (...kinds) => kinds.some(has);
    /** @type {string[]} */
    const reasons = [];

    // Rules run in order and the first match wins, so the order IS the policy.
    // Noise is removed first, then things this business does not do, and only
    // then is anything treated as a rental search.

    if (hasAny('spam_offer')) {
      reasons.push('promotional or fraudulent content');
      return decide(DISPOSITIONS.SPAM_OR_BOT, reasons, signals, 0.9, false);
    }

    if (has('growth_pitch') || has('recruiter')) {
      reasons.push(has('recruiter') ? 'recruiting pitch' : 'selling marketing or lead-gen services');
      return decide(DISPOSITIONS.VENDOR_OR_RECRUITER, reasons, signals, 0.85, false);
    }

    if (has('complaint')) {
      reasons.push('complaint, dispute, or legal language — never answered automatically');
      return decide(DISPOSITIONS.UNCLEAR, reasons, signals, 0.8, true);
    }

    if (has('no_text') || has('link_only')) {
      reasons.push(has('no_text') ? 'no words to work with' : 'a bare link');
      return decide(DISPOSITIONS.UNCLEAR, reasons, signals, 0.6, true);
    }

    const disqualifiers = [
      ['wants_to_buy', 'wants to buy, not rent'],
      ['wants_to_sell', 'wants to sell a property'],
      ['commercial_space', 'wants commercial space'],
      ['wants_roommate', 'wants a room, sublet, or roommate rather than a lease'],
      ['wants_job', 'asking about work, not housing'],
      ['landlord_side', 'is an owner wanting a unit filled'],
      ['already_leased', 'already found a place'],
    ];
    for (const [kind, reason] of disqualifiers) {
      // Someone can want to buy *and* need a rental in the meantime; a rental
      // search stated in the same message outranks the disqualifier.
      if (has(kind) && !has('stated_search')) {
        reasons.push(reason);
        return decide(DISPOSITIONS.NOT_SERVICEABLE, reasons, signals, 0.8, false);
      }
    }

    const criteriaPresent = REQUIRED_CRITERIA.filter(([kind]) => has(kind));
    const missing = REQUIRED_CRITERIA.filter(([kind]) => !has(kind)).map(([, label]) => label);

    if (has('stated_search') || criteriaPresent.length >= 2) {
      reasons.push(
        has('stated_search')
          ? 'stated they are looking for a place'
          : `stated ${criteriaPresent.map(([, label]) => label).join(' and ')}`,
      );
      if (has('screening_disclosure')) reasons.push('disclosed rental history that narrows the property list');
      if (has('urgency')) reasons.push('needs to move immediately');
      if (has('area_not_in_market')) {
        reasons.push('named an area outside the configured market — confirm before working it');
        return decide(DISPOSITIONS.NOT_SERVICEABLE, reasons, signals, 0.55, true, missing);
      }
      return decide(DISPOSITIONS.PROSPECTIVE_RENTER, reasons, signals, 0.85, false, missing);
    }

    if (criteriaPresent.length === 1) {
      reasons.push(`stated ${criteriaPresent[0][1]} but nothing else yet`);
      return decide(DISPOSITIONS.NEEDS_QUALIFICATION, reasons, signals, 0.7, false, missing);
    }

    if (has('question_only')) {
      reasons.push('asked about the service without stating a search');
      return decide(DISPOSITIONS.GENERAL_QUESTION, reasons, signals, 0.75, false, missing);
    }

    if (has('personal_social') && !has('greeting_only')) {
      reasons.push('personal conversation, not a business inquiry');
      return decide(DISPOSITIONS.PERSONAL_OR_SOCIAL, reasons, signals, 0.6, true);
    }

    if (has('greeting_only') || has('referral')) {
      reasons.push(has('referral') ? 'came from a referral or a post, nothing stated yet' : 'opened with a greeting only');
      return decide(DISPOSITIONS.NEEDS_QUALIFICATION, reasons, signals, 0.65, false, missing);
    }

    reasons.push('not enough in the message to classify');
    return decide(DISPOSITIONS.UNCLEAR, reasons, signals, 0.3, true, missing);
  }

  /**
   * Re-triage a whole thread. People rarely say everything in one message, so
   * the disposition of a conversation is the strongest thing anyone said in it,
   * not the last thing they typed.
   *
   * @param {{text: string}[]} messages
   */
  function classifyThread(messages) {
    const results = messages.map((m, i) => classify({ text: m.text, history: messages.slice(0, i) }));
    if (!results.length) return classify({ text: '' });

    const merged = new Map();
    for (const r of results) for (const s of r.signals) merged.set(`${s.kind}:${s.evidence}`, s);

    const best = results
      .slice()
      .sort((a, b) => PRECEDENCE.indexOf(a.disposition) - PRECEDENCE.indexOf(b.disposition))[0];

    // Reasons come only from the messages that produced the winning
    // disposition. Merging every message's reasons puts "not enough to
    // classify" next to "stated they are looking for a place" on the same
    // lead, which reads as though the system contradicted itself.
    const reasons = [
      ...new Set(results.filter((r) => r.disposition === best.disposition).flatMap((r) => r.reasons)),
    ];

    return {
      ...best,
      signals: [...merged.values()],
      reasons,
      missing: results.at(-1)?.missing ?? best.missing,
    };
  }

  return { classify, classifyThread, detector };
}

/**
 * Which disposition wins when a thread contains several.
 *
 * Not a quality order — a resolution order. Spam anywhere in a thread makes the
 * thread spam; a stated search anywhere makes it a search, even if the last
 * message was "ok thanks".
 */
const PRECEDENCE = [
  DISPOSITIONS.SPAM_OR_BOT,
  DISPOSITIONS.VENDOR_OR_RECRUITER,
  DISPOSITIONS.PROSPECTIVE_RENTER,
  DISPOSITIONS.NOT_SERVICEABLE,
  DISPOSITIONS.NEEDS_QUALIFICATION,
  DISPOSITIONS.GENERAL_QUESTION,
  DISPOSITIONS.PERSONAL_OR_SOCIAL,
  DISPOSITIONS.UNCLEAR,
];

/** @returns {import('../core/types.js').Triage} */
function decide(disposition, reasons, signals, confidence, needsHuman, missing = []) {
  return { disposition, reasons, signals, missing, confidence, needsHuman };
}

function safeExtract(extract, text) {
  try {
    return extract(text);
  } catch {
    return undefined;
  }
}
