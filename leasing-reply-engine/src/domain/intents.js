/**
 * Intent classification.
 *
 * Rule-based on purpose. For lead-handling DMs the vocabulary is small and the
 * cost of a wrong guess is high, so patterns that a human can read, audit, and
 * correct beat a black box — and every rule here is a unit test away from being
 * proven. The registry is open: a future module (or a learned classifier) can
 * register additional intents, or replace the scorer entirely, without touching
 * the planner.
 *
 * A DM routinely carries several intents at once ("do you charge? looking for a
 * 2 bed in uptown under 2k"), so classification returns all of them.
 */
import { normalize } from './normalize.js';

/**
 * @typedef {Object} IntentDef
 * @property {string} id
 * @property {string} description
 * @property {RegExp[]} [patterns]     Strong signals (weight 3 each).
 * @property {string[]} [keywords]     Weak signals (weight 1 each).
 * @property {number} [priority]       Tie-break; higher wins.
 * @property {string[]} [examples]     Documentation and test fixtures.
 */

/** @type {IntentDef[]} */
export const CORE_INTENTS = [
  {
    id: 'greeting',
    description: 'Opening hello with no substance yet.',
    patterns: [/^(hey|hi|hello|yo|good (morning|afternoon|evening)|whats up|sup|howdy)\b[\s!.,]*$/],
    keywords: ['hey', 'hi', 'hello'],
    priority: 1,
    examples: ['hey', 'hi there', 'yo'],
  },
  {
    id: 'inquiry.start',
    description: 'Lead is starting an apartment search.',
    patterns: [
      /\b(looking for|need|searching for|trying to find|in the market for|help me find|can you help)\b.*\b(apartment|place|unit|spot|home|condo|loft|studio|bed|bedroom|rental)\b/,
      /\b(apartment|place|unit) (hunting|search|searching)\b/,
      /\bsaw your (post|page|reel|story|video)\b/,
      /\bare you (still )?(helping|working|taking clients)\b/,
    ],
    keywords: ['looking', 'apartment', 'searching', 'need', 'help', 'move', 'moving', 'relocating'],
    priority: 5,
    examples: ['hey saw your reel, looking for a 2 bed', 'need help finding an apartment'],
  },
  {
    id: 'provide.criteria',
    description: 'Lead is stating what they want (budget, size, area, timing).',
    patterns: [
      /\$\s?\d/,
      /\b\d+\s*(bed|bd|br|bath|ba)\b/,
      /\b\d\s*\/\s*\d\b/,
      /\b(budget|price range|spend|under|around|max)\b.*\d/,
      /\b(move|moving|move in|need it|need to be in)\b.*\b(by|on|asap|next|month|week|\d)/,
      /\b(studio|efficiency|one bedroom|two bedroom|three bedroom)\b/,
    ],
    keywords: ['budget', 'bedroom', 'bed', 'bath', 'move', 'studio', 'area', 'near', 'zip'],
    priority: 6,
    examples: ['2/2 under 1800 in uptown', 'budget is like 1500 moving next month'],
  },
  {
    id: 'ask.fee',
    description: 'Does the locator/agent charge the renter?',
    patterns: [
      /\b(do|does|would|will) (you|this|that|it|there) (charge|cost|have a fee)\b/,
      /\b(is (this|it|your service) free)\b/,
      /\b(what.s the catch|any (fees?|charges?)|how much do you charge|whats your fee|your commission)\b/,
      /\bhow do you get paid\b/,
      /\bfree (service|for me|to me)\b/,
    ],
    keywords: ['fee', 'charge', 'cost', 'free', 'commission', 'paid'],
    priority: 9,
    examples: ['do you charge anything?', 'is this free for me', 'how do you get paid'],
  },
  {
    id: 'ask.process',
    description: 'How does this work / what happens next.',
    patterns: [
      /\bhow (does|do) (this|it|you|that) work\b/,
      /\bwhat(?:'| i)?s the (process|next step|first step)\b/,
      /\bwhat do (you|i) need from me\b/,
      /\bwhat happens (next|after)\b/,
      /\bnever (used|done) (a locator|this before)\b/,
    ],
    keywords: ['process', 'work', 'steps', 'next'],
    priority: 8,
    examples: ['how does this work?', 'whats the process'],
  },
  {
    id: 'ask.listings',
    description: 'Wants options / a list sent over.',
    patterns: [
      /\b(send|show|got|have|share|shoot) (me|over|us)?\s*(some|any|a few|the)?\s*(options|places|list|listings|units|apartments|properties|links)\b/,
      /\bwhat (do you have|have you got|is available)\b/,
      /\b(any|anything) (available|open|good)\b/,
      /\bcan i see\b/,
    ],
    keywords: ['options', 'list', 'listings', 'available', 'send', 'see'],
    priority: 7,
    examples: ['can you send me some options', 'what do you have available'],
  },
  {
    id: 'ask.tour',
    description: 'Wants to see a place in person.',
    patterns: [
      /\b(tour|showing|walk ?through|see it|see them|check it out|visit|look at (it|them|the place))\b/,
      /\bwhen can (i|we) (see|come by|stop by|look)\b/,
      /\bschedule (a|an) (tour|showing|appointment|visit)\b/,
      /\b(are you|is it) available (today|tomorrow|this weekend|saturday|sunday)\b/,
    ],
    keywords: ['tour', 'showing', 'see', 'visit', 'schedule', 'appointment'],
    priority: 9,
    examples: ['can i tour this weekend?', 'when can i see it'],
  },
  {
    id: 'ask.application',
    description: 'Application, approval odds, fees, deposits, documents.',
    patterns: [
      /\b(apply|application|app fee|admin fee|deposit|hold fee|paperwork|documents|pay stubs|proof of income)\b/,
      /\b(will i (get )?(approved|qualify)|do i qualify|approval odds|can i get approved)\b/,
      /\bhow much (is|are) (the )?(deposit|app|application|admin)\b/,
    ],
    keywords: ['apply', 'application', 'deposit', 'approved', 'qualify', 'paperwork'],
    priority: 8,
    examples: ['how much is the app fee', 'do you think ill get approved with a broken lease'],
  },
  {
    id: 'ask.screening',
    description: 'Credit, income, background, eviction, broken lease questions.',
    patterns: [
      /\b(credit (score|check|requirement)|income requirement|3x|three times|background check|criminal|felony|eviction|broken lease|second chance|bad credit)\b/,
      /\bdo they (check|run|look at)\b/,
      /\bwhat credit score\b/,
    ],
    keywords: ['credit', 'income', 'background', 'eviction', 'felony', 'requirements'],
    priority: 8,
    examples: ['what credit score do they need', 'do they work with broken leases'],
  },
  {
    id: 'ask.pets',
    description: 'Pet policy, breed restrictions, pet rent.',
    patterns: [
      /\b(pet (policy|friendly|rent|deposit|fee)|breed restriction|weight limit|do they allow (dogs|cats|pets)|are pets allowed)\b/,
      /\b(is it|are they) pet friendly\b/,
    ],
    keywords: ['pet', 'dog', 'cat', 'breed', 'allowed'],
    priority: 7,
    examples: ['are they pet friendly', 'is there a weight limit for dogs'],
  },
  {
    id: 'ask.specials',
    description: 'Concessions, move-in specials, free months.',
    patterns: [
      /\b(special|specials|concession|free month|months? free|move in special|deal|promo|discount|look and lease)\b/,
      /\bany (deals|specials)\b/,
    ],
    keywords: ['special', 'deal', 'free', 'concession', 'promo'],
    priority: 7,
    examples: ['any move in specials right now', 'anyone doing a month free'],
  },
  {
    id: 'ask.location',
    description: 'Where is it / address / how far from something.',
    patterns: [
      /\b(where is (it|that|this)|what.s the address|which (part|area)|how far (is|from)|commute to)\b/,
      /\baddress\b/,
    ],
    keywords: ['where', 'address', 'far', 'commute', 'location'],
    priority: 6,
    examples: ['where is it exactly', 'how far is that from downtown'],
  },
  {
    id: 'provide.contact',
    description: 'Lead handed over a phone number or email.',
    patterns: [/\b[\w.+-]+@[\w-]+\.[\w.]{2,}\b/, /\b\d{3}[\s.-]?\d{3}[\s.-]?\d{4}\b/],
    keywords: ['number', 'email', 'call', 'text'],
    priority: 7,
    examples: ['my number is 555-555-5555'],
  },
  {
    id: 'human.request',
    description: 'Wants a real person, a call, or is clearly done with messaging.',
    patterns: [
      /\b(are you (a )?(bot|real|human|ai)|is this a bot|talk to (a|the) (real )?(person|human|agent))\b/,
      /\b(call me|can (i|we) (talk|hop on a call|speak))\b/,
      /\bstop (with the )?(bot|automated)\b/,
    ],
    keywords: ['bot', 'human', 'real', 'call', 'speak'],
    priority: 10,
    examples: ['is this a bot?', 'can you just call me'],
  },
  {
    id: 'optout',
    description: 'Asked to stop being messaged.',
    patterns: [/\b(stop|unsubscribe|leave me alone|do not (message|contact)|not interested|remove me|quit messaging)\b/],
    keywords: ['stop', 'unsubscribe', 'unfollow'],
    priority: 11,
    examples: ['stop messaging me', 'not interested'],
  },
  {
    id: 'affirm',
    description: 'Yes / agreement.',
    patterns: [/^(yes|yeah|yep|yup|sure|ok|okay|sounds good|perfect|for sure|absolutely|please do|lets do it|bet|word|k)\b[\s!.,]*$/],
    keywords: ['yes', 'yeah', 'sure', 'okay'],
    priority: 3,
    examples: ['yes please', 'sounds good'],
  },
  {
    id: 'deny',
    description: 'No / disagreement.',
    patterns: [/^(no|nope|nah|not really|negative|no thanks|im good|i am good)\b[\s!.,]*$/],
    keywords: ['no', 'nope', 'nah'],
    priority: 3,
    examples: ['nah', 'no thanks'],
  },
  {
    id: 'thanks',
    description: 'Gratitude, often the end of a thread.',
    patterns: [/\b(thank you|thanks|thx|appreciate (it|you)|preciate it|got it thanks)\b/],
    keywords: ['thanks', 'appreciate'],
    priority: 4,
    examples: ['thanks!', 'appreciate you'],
  },
  {
    id: 'smalltalk',
    description: 'Social filler with no leasing content.',
    patterns: [/\b(how are you|hows it going|how have you been|whats good|happy (new year|holidays))\b/],
    keywords: ['how are you', 'hows it going'],
    priority: 2,
    examples: ['how are you doing'],
  },
  {
    id: 'spam',
    description: 'Promotional, bot, or unrelated outreach.',
    patterns: [
      /\b(crypto|bitcoin|forex|investment opportunity|grow your (following|account)|dm me to earn|click the link in bio|make \$\d+ (a|per) (day|week))\b/,
      /\b(check out my (page|profile)|follow back|f4f|promo(te)? your)\b/,
    ],
    keywords: ['crypto', 'investment', 'followers', 'promote'],
    priority: 12,
    examples: ['want to grow your following? dm me'],
  },
];

/**
 * Compliance triggers.
 *
 * These are not really "intents" — they are questions a leasing professional
 * must not answer casually. Fair-housing steering questions and disability or
 * assistance-animal topics get flagged here so the planner routes them to a
 * neutral, factual response and a human, no matter what else the message said.
 * @type {IntentDef[]}
 */
export const COMPLIANCE_INTENTS = [
  {
    id: 'compliance.steering',
    description: 'Asks the agent to characterize an area or its residents — steering risk.',
    patterns: [
      /\b(is (it|that|this area|the area) (safe|dangerous|sketchy|ghetto|rough|bad|nice)|safe (area|neighborhood|part of town)|crime rate|high crime)\b/,
      /\b(good (schools|school district)|school district|family friendly|good for (kids|families)|kid friendly area)\b/,
      /\b(what (kind|type) of people|who lives (there|in that area)|demographic|mostly (white|black|hispanic|latino|asian)|is it diverse)\b/,
      /\b(church|temple|mosque|synagogue) (nearby|close|around)\b.*\b(people|community|area)\b/,
      /\b(quiet|older|younger) crowd\b/,
    ],
    priority: 20,
    examples: ['is that a safe area?', 'are the schools good over there', 'what kind of people live there'],
  },
  {
    id: 'compliance.assistance_animal',
    description: 'Service animal / ESA — never treated as a pet, never probed.',
    patterns: [/\b(service (dog|animal)|esa|emotional support (animal|dog)|assistance animal)\b/],
    priority: 20,
    examples: ['i have an ESA, is that a problem'],
  },
  {
    id: 'compliance.accessibility',
    description: 'Accessibility need or disability disclosed.',
    patterns: [
      /\b(wheelchair|handicap|accessible unit|ada|disability|disabled|mobility (issues|impaired)|reasonable accommodation|grab bars)\b/,
    ],
    priority: 20,
    examples: ['i need a wheelchair accessible unit'],
  },
  {
    id: 'compliance.voucher',
    description: 'Housing voucher / subsidized program mentioned.',
    patterns: [/\b(section 8|housing voucher|hcv|hud|subsidiz(ed|y)|housing authority|dha voucher)\b/],
    priority: 20,
    examples: ['do you take section 8'],
  },
];

/** Build a classifier. Additional intents can be registered at any time. */
export function createClassifier({ intents = [...CORE_INTENTS, ...COMPLIANCE_INTENTS], threshold = 2 } = {}) {
  /** @type {Map<string, IntentDef>} */
  const registry = new Map(intents.map((i) => [i.id, i]));

  /** @param {IntentDef} def */
  function register(def) {
    if (!def?.id) throw new Error('intent requires an id');
    registry.set(def.id, def);
  }

  /**
   * @param {string} text
   * @param {{conversation?: import('../core/types.js').Conversation}} [ctx]
   * @returns {import('../core/types.js').Classification}
   */
  function classify(text, ctx = {}) {
    const n = normalize(text);
    /** @type {Record<string, number>} */
    const scores = {};

    for (const def of registry.values()) {
      let score = 0;
      for (const re of def.patterns ?? []) if (re.test(n.clean)) score += 3;
      for (const kw of def.keywords ?? []) {
        if (kw.includes(' ') ? n.clean.includes(kw) : n.tokens.includes(kw)) score += 1;
      }
      if (score > 0) scores[def.id] = score + (def.priority ?? 0) / 100;
    }

    // A bare "yes"/"no" only means something in reply to a question we asked.
    const lastAgentTurn = [...(ctx.conversation?.turns ?? [])].reverse().find((t) => t.role === 'agent');
    if ((scores.affirm || scores.deny) && !lastAgentTurn) {
      delete scores.affirm;
      delete scores.deny;
    }

    const ranked = Object.entries(scores).sort((a, b) => b[1] - a[1]);
    const all = ranked.filter(([, s]) => s >= threshold).map(([id]) => id);

    if (ranked.length === 0) {
      return { primary: 'unknown', all: [], confidence: 0, scores };
    }

    // Compliance always outranks whatever else the message was about.
    const compliance = all.find((id) => id.startsWith('compliance.'));
    const primary = compliance ?? all[0] ?? ranked[0][0];
    const top = scores[primary];
    const confidence = Math.min(1, top / 6);

    return { primary, all: all.length ? all : [ranked[0][0]], confidence, scores };
  }

  return { classify, register, list: () => [...registry.values()] };
}
