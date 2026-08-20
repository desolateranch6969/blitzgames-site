/**
 * Signal detectors.
 *
 * A signal is an observation with the words that produced it — "they stated a
 * budget", "they mentioned buying, not renting", "this is a copy-paste mass DM".
 * Signals are facts about a message, not judgments about a person, and they are
 * never summed, weighted, or turned into a number. Triage reads them; the portal
 * displays them; nothing ranks them.
 *
 * Detectors are registerable, so a market-specific or seasonal signal can be
 * added without editing this file.
 */

/**
 * @typedef {Object} SignalDef
 * @property {string} kind
 * @property {string} description
 * @property {RegExp} [re]
 * @property {(ctx: SignalContext) => string|null} [detect]  Returns evidence, or null.
 *
 * @typedef {Object} SignalContext
 * @property {string} text          Lowercased message text.
 * @property {string} original
 * @property {import('../core/types.js').RawEvent[]} [history]
 * @property {{areas?: string[], name?: string}} [market]
 * @property {Record<string, any>} [slots]   Optional structured extraction.
 */

/** Signals that a real rental search is underway. */
export const INTENT_SIGNALS = [
  {
    kind: 'stated_search',
    description: 'Explicitly looking for a place to rent.',
    re: /\b(looking for|need|searching for|trying to find|in the market for|help me find|apartment hunting|apt hunting|need a place|need somewhere)\b.{0,40}\b(apartment|apt|place|unit|spot|home|condo|loft|studio|bed|bedroom|rental|to live|to rent)\b|\b(apartment|apt) (hunting|search)\b/,
  },
  { kind: 'stated_budget', description: 'Named a rent figure.', re: /\$\s?\d{3,}|\b\d{3,4}\s*(?:\/|per\s+)?(?:mo|month)\b|\b(?:under|below|max|budget|around|about|up to)\s*\$?\s?\d(?:[\d.,]*)k?\b/ },
  { kind: 'stated_size', description: 'Named a unit size.', re: /\b\d\s*(?:\/|x)\s*\d\b|\b\d+\s*-?\s*(?:bed(?:room)?s?|bd|br)\b|\b(studio|efficiency)\b/ },
  { kind: 'stated_timeline', description: 'Named a move date or window.', re: /\b(asap|as soon as possible|right away|next month|this month|end of (?:the )?month|move[- ]?in|by (?:the )?\d{1,2}(?:st|nd|rd|th)?|\d{1,2}\/\d{1,2}|january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sept|sep|oct|nov|dec)\b.{0,25}\b(move|moving|need|lease|in)\b|\b(move|moving|need to be in|lease is up|lease ends)\b.{0,30}\b(asap|next month|\d{1,2}\/\d{1,2}|january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sept|sep|oct|nov|dec)\b/ },
  { kind: 'stated_area', description: 'Named a neighborhood, city, or zip.', re: /\b(?:in|near|around|by|close to|off of)\s+[a-z]{3,}|\b\d{5}\b|\b(down|up|mid)town\b/ },
  { kind: 'urgency', description: 'Needs to move immediately.', re: /\b(asap|right away|immediately|today|tomorrow|this week|urgent|emergency|got to be out|have to be out|need out)\b/ },
  { kind: 'screening_disclosure', description: 'Disclosed rental or background history that narrows the property list.', re: /\b(broken lease|evict(?:ion|ed)|felon(?:y|ies)|misdemeanor|bad credit|no credit|bankrupt|second chance)\b/ },
  { kind: 'names_property', description: 'Asked about a specific property.', re: /\b(?:the\s+)?[a-z]+\s+(?:apartments|lofts|residences|towers|flats|at\s+[a-z]+)\b|\bis\s+[a-z]+\s+still\s+available\b/ },
  { kind: 'referral', description: 'Came from a referral or specific post.', re: /\b(my (friend|cousin|coworker|sister|brother|girl|guy)|someone|a friend)\b.{0,20}\b(said|told me|referred|sent me|recommended)\b|\bsaw your (post|reel|story|video|page|tiktok)\b/ },
  { kind: 'provided_contact', description: 'Handed over a phone number or email.', re: /\b[\w.+-]+@[\w-]+\.[a-z]{2,}\b|\b\d{3}[\s.-]?\d{3}[\s.-]?\d{4}\b/ },
];

/** Signals that this is not a rental lead at all. */
export const DISQUALIFYING_SIGNALS = [
  { kind: 'wants_to_buy', description: 'Buying, not renting.', re: /\b(buy(ing)? a (house|home|condo|place)|purchase a (home|house)|mortgage|pre[- ]?approved|realtor for buying|first time (home )?buyer|down payment|closing costs)\b/ },
  { kind: 'wants_to_sell', description: 'Selling or listing a property.', re: /\b(sell my (house|home|condo|property)|list my (house|home|property)|whats my home worth|home valuation)\b/ },
  { kind: 'commercial_space', description: 'Commercial, not residential.', re: /\b(office space|retail space|warehouse|commercial (space|property|lease)|storefront|salon suite)\b/ },
  { kind: 'wants_roommate', description: 'Looking for a roommate or a room, not a lease.', re: /\b(roommate|room ?mate|need a room|renting a room|sublet|sublease|air ?bnb|short term stay|couch)\b/ },
  { kind: 'wants_job', description: 'Asking about work, not housing.', re: /\b(hiring|job opening|are you hiring|apply for a (job|position)|internship|shadow you|get into (real estate|leasing)|become a locator|how do i get my license)\b/ },
  { kind: 'landlord_side', description: 'Owns a property and wants it filled.', re: /\b(i (have|own|got) (a|an|some|my)?\s*(rental|investment)?\s*(property|properties|unit|units|house|duplex|condo|apartment)\b[^.?!]{0,30}\b(for rent|available|to rent|filled|rented|vacant|empty|leased)|list my rental|fill my vacancy|my tenants?|i(?:'|)m a landlord|as a landlord)\b/ },
  { kind: 'already_leased', description: 'Already signed somewhere.', re: /\b(already (signed|leased|found|moved)|we found (a place|something)|no longer looking|found something)\b/ },
];

/** Signals that a human is not on the other end, or is selling something. */
export const NOISE_SIGNALS = [
  { kind: 'spam_offer', description: 'Promotional or scam content.', re: /\b(crypto|bitcoin|forex|binary options|investment opportunity|make \$?\d+ (a|per) (day|week)|work from home opportunity|cash app|gift card|giveaway winner|you(?:'|)ve been selected|claim your prize)\b/ },
  { kind: 'growth_pitch', description: 'Selling followers, leads, or marketing.', re: /\b(grow your (following|account|page|business)|more (followers|leads|clients)|social media (management|manager)|seo services|website for your business|video editor|edit your reels|ai automation for|lead gen(eration)? service|appointment setter)\b/ },
  { kind: 'recruiter', description: 'Recruiting for a brokerage or role.', re: /\b(join (our|my) (team|brokerage)|we(?:'|)re hiring|recruiting agents|split commission|come work (with|for)|partner with (us|me) on deals)\b/ },
  { kind: 'link_only', description: 'A link with no message.', detect: (ctx) => (/^\s*https?:\/\/\S+\s*$/.test(ctx.original) ? ctx.original.trim() : null) },
  { kind: 'no_text', description: 'Media, reaction, or empty message with no words.', detect: (ctx) => (ctx.original.trim().length === 0 ? '(empty)' : null) },
  { kind: 'mass_dm_pattern', description: 'Opener seen verbatim from other senders.', detect: null },
];

/** Signals about the relationship rather than the message. */
export const CONTEXT_SIGNALS = [
  { kind: 'greeting_only', description: 'A hello with nothing else in it.', detect: (ctx) => (/^\s*(hey|hi|hello|yo|sup|whats up|what's up|good (morning|afternoon|evening))[\s!.,?]*$/i.test(ctx.original) ? ctx.original.trim() : null) },
  { kind: 'question_only', description: 'Asks about the service without stating a search.', re: /\b(do you charge|whats your fee|what(?:'|)s the catch|how does (this|it) work|how do you get paid|are you a realtor|do you do|can you help with|whats the process)\b/ },
  { kind: 'personal_social', description: 'Personal conversation, not business.', re: /\b(happy birthday|congrats|congratulations|miss you|see you (at|on)|good to see you|how(?:'|)s the family|love this|nice pic|great post)\b/ },
  { kind: 'complaint', description: 'Complaint or dispute, which is never handled automatically.', re: /\b(scam|fraud|report you|lawyer|attorney|lawsuit|sue|discriminat|refund|you never|stop ignoring)\b/ },
];

export const ALL_SIGNALS = [...INTENT_SIGNALS, ...DISQUALIFYING_SIGNALS, ...NOISE_SIGNALS, ...CONTEXT_SIGNALS];

/**
 * @param {SignalDef[]} [definitions]
 */
export function createSignalDetector(definitions = ALL_SIGNALS) {
  /** @type {Map<string, SignalDef>} */
  const registry = new Map(definitions.map((d) => [d.kind, d]));

  /** @param {SignalDef} def */
  function register(def) {
    if (!def?.kind) throw new Error('a signal needs a kind');
    registry.set(def.kind, def);
  }

  /**
   * @param {SignalContext} ctx
   * @returns {import('../core/types.js').Signal[]}
   */
  function detect(ctx) {
    const text = ctx.text ?? String(ctx.original ?? '').toLowerCase();
    /** @type {import('../core/types.js').Signal[]} */
    const found = [];

    for (const def of registry.values()) {
      let evidence = null;
      if (def.detect) evidence = def.detect({ ...ctx, text });
      else if (def.re) evidence = text.match(def.re)?.[0] ?? null;
      if (evidence) found.push({ kind: def.kind, evidence: String(evidence).trim().slice(0, 120), source: 'text' });
    }

    // Signals that come from structure rather than wording.
    if (ctx.slots) {
      for (const [slot, kind] of Object.entries(SLOT_SIGNALS)) {
        if (hasValue(ctx.slots[slot]) && !found.some((s) => s.kind === kind)) {
          found.push({ kind, evidence: JSON.stringify(ctx.slots[slot]).slice(0, 120), source: 'extractor' });
        }
      }
    }

    if ((ctx.history?.length ?? 0) > 0) {
      found.push({ kind: 'repeat_contact', evidence: `${ctx.history.length} prior message(s)`, source: 'history' });
    }

    if (ctx.market?.areas?.length && found.some((s) => s.kind === 'stated_area')) {
      const mentioned = ctx.market.areas.some((area) => text.includes(String(area).toLowerCase()));
      if (!mentioned) {
        found.push({ kind: 'area_not_in_market', evidence: 'named an area not in the configured market', source: 'market' });
      }
    }

    return found;
  }

  return { detect, register, list: () => [...registry.values()] };
}

/** Structured extraction, when module 1's extractor is injected, backs these. */
const SLOT_SIGNALS = {
  budget: 'stated_budget',
  beds: 'stated_size',
  moveIn: 'stated_timeline',
  areas: 'stated_area',
  screening: 'screening_disclosure',
  contact: 'provided_contact',
};

function hasValue(value) {
  if (value == null) return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.keys(value).length > 0;
  return true;
}
