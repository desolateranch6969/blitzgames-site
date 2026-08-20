/**
 * Slot extraction: turn a DM into the facts a leasing agent actually needs.
 *
 * These are the fields that decide which properties will even take the lead —
 * budget, timing, size, area, occupancy, pets, income, and rental history. Each
 * extractor is independent and returns null when it isn't confident, because a
 * wrong slot is far more expensive than a missing one: a wrong budget sends the
 * wrong list, and the lead is gone.
 */
import { normalize, parseMoney, parseCount, isPlausibleRent } from './normalize.js';

const MONTHS = ['january','february','march','april','may','june','july','august','september','october','november','december'];
const MONTH_ABBR = ['jan','feb','mar','apr','may','jun','jul','aug','sept','sep','oct','nov','dec'];

/** Longest first, so "sept" is not consumed as "sep" and then fail on the "t". */
const MONTH_PATTERN = [...MONTHS, ...MONTH_ABBR].sort((a, b) => b.length - a.length).join('|');

/**
 * @param {string} text
 * @param {{now?: number, market?: import('./market.js').Market}} [opts]
 * @returns {Partial<import('../core/types.js').Slots>}
 */
export function extractSlots(text, opts = {}) {
  const n = normalize(text);
  const now = opts.now ?? Date.now();
  /** @type {Partial<import('../core/types.js').Slots>} */
  const slots = {};

  const budget = extractBudget(n.clean);
  if (budget) slots.budget = budget;

  const size = extractSize(n.clean);
  if (size.beds != null) slots.beds = size.beds;
  if (size.baths != null) slots.baths = size.baths;

  const moveIn = extractMoveIn(n.clean, now);
  if (moveIn) slots.moveIn = moveIn;

  const areas = extractAreas(n.clean, opts.market);
  if (areas.length) slots.areas = areas;

  const occupants = extractOccupants(n.clean);
  if (occupants != null) slots.occupants = occupants;

  const pets = extractPets(n.clean);
  if (pets) slots.pets = pets;

  const income = extractIncome(n.clean);
  if (income) slots.income = income;

  const screening = extractScreening(n.clean);
  if (screening) slots.screening = screening;

  const contact = extractContact(n.original);
  if (contact) slots.contact = contact;

  const amenities = extractAmenities(n.clean);
  if (amenities.length) slots.amenities = amenities;

  const tourAvailability = extractTourAvailability(n.clean);
  if (tourAvailability) slots.tourAvailability = tourAvailability;

  return slots;
}

/** @param {string} s */
export function extractBudget(input) {
  // Callable directly, so it cannot assume normalize() already ran.
  const s = String(input ?? '').toLowerCase();

  // Explicit range: "1200-1500", "between 1200 and 1500", "1.2k to 1.5k"
  const range =
    s.match(/\$?(\d[\d,.]*k?)\s*(?:-|to|thru|through)\s*\$?(\d[\d,.]*k?)/) ||
    s.match(/between\s+\$?(\d[\d,.]*k?)\s+and\s+\$?(\d[\d,.]*k?)/);
  if (range) {
    const min = parseMoney(range[1]);
    const max = parseMoney(range[2]);
    if (isPlausibleRent(min) && isPlausibleRent(max) && max >= min) {
      return { min, max, raw: range[0] };
    }
  }

  // Ceiling: "under 2k", "max 1800", "no more than 1500", "up to 2000", "1800 or less"
  const ceiling = s.match(
    /(?:under|below|less than|no more than|max(?:imum)?|up to|at most|cap(?:ped)? at|within)\s*\$?(\d[\d,.]*k?)/,
  ) || s.match(/\$?(\d[\d,.]*k?)\s*(?:or less|or under|and under|tops)/);
  if (ceiling) {
    const max = parseMoney(ceiling[1]);
    if (isPlausibleRent(max)) return { max, raw: ceiling[0] };
  }

  // Target: "around 1800", "budget is 2k", "looking to spend 1500", "1800/mo"
  // A lead revising their own number mid-thread: "actually make it 2500".
  const revised = s.match(
    /(?:make it|bump (?:it )?(?:up )?to|go(?: up)? to|stretch to|raise it to|push it to|i can do)\s*\$?(\d[\d,.]*k?)/,
  );
  if (revised) {
    const value = parseMoney(revised[1]);
    if (isPlausibleRent(value)) return { max: value, raw: revised[0] };
  }

  const target = s.match(
    /(?:around|about|roughly|approx(?:imately)?|near|~|budget|spend(?:ing)?|paying|pay|price range)(?:\s+(?:is|of|at|like|around|about|maybe|near|roughly|would be|will be)){0,2}\s*\$?(\d[\d,.]*k?)/,
  ) || s.match(/\$?(\d[\d,.]*k?)\s*(?:\/|per\s+)?(?:mo|month|monthly)\b/) || s.match(/\$(\d[\d,.]*k?)/);
  if (target) {
    const value = parseMoney(target[1]);
    if (isPlausibleRent(value)) {
      // A single number is a ceiling in practice — nobody hunts for a *minimum* rent.
      return { max: value, raw: target[0] };
    }
  }
  return null;
}

/** @param {string} s */
export function extractSize(input) {
  const s = String(input ?? '').toLowerCase();
  /** @type {{beds: number|null, baths: number|null}} */
  const out = { beds: null, baths: null };

  if (/\b(studio|efficiency|eff)\b/.test(s)) out.beds = 0;

  // "2/2", "2x2", "1/1.5"
  const combo = s.match(/\b(\d)\s*(?:\/|x)\s*(\d(?:\.5)?)\b/);
  if (combo) {
    out.beds = parseCount(combo[1]);
    out.baths = parseCount(combo[2]);
  }

  const beds = s.match(/\b(\d+|one|two|three|four|five|studio)\s*-?\s*(?:bed(?:room)?s?|bd|br|bdr|bdrm)\b/);
  if (beds) out.beds = beds[1] === 'studio' ? 0 : parseCount(beds[1]);

  const baths = s.match(/\b(\d+(?:\.5)?|one|two|three)\s*-?\s*(?:bath(?:room)?s?|ba)\b/);
  if (baths) out.baths = parseCount(baths[1]);

  if (out.beds != null && (out.beds < 0 || out.beds > 6)) out.beds = null;
  if (out.baths != null && (out.baths < 0 || out.baths > 6)) out.baths = null;
  return out;
}

/**
 * @param {string} s
 * @param {number} now
 * @returns {{iso?: string, text?: string, flexible?: boolean}|null}
 */
export function extractMoveIn(input, now = Date.now()) {
  const s = String(input ?? '').toLowerCase();
  const today = new Date(now);

  if (/\b(as soon as possible|asap|right away|immediately|now|today|tomorrow|this week)\b/.test(s)) {
    return { iso: isoOf(today), text: 'asap', flexible: false };
  }
  if (/\b(flexible|whenever|no rush|not in a rush|open|depends)\b/.test(s) && /\b(move|date|timing|timeline)\b/.test(s)) {
    return { text: 'flexible', flexible: true };
  }

  // "aug 1", "august 1st", "8/1", "on the 15th"
  const monthDay = s.match(new RegExp(`\\b(${MONTH_PATTERN})\\.?\\s*(\\d{1,2})?(?:st|nd|rd|th)?\\b`));
  if (monthDay) {
    const idx = MONTHS.indexOf(monthDay[1]) >= 0 ? MONTHS.indexOf(monthDay[1]) : monthIndexFromAbbr(monthDay[1]);
    if (idx >= 0) {
      const day = monthDay[2] ? parseInt(monthDay[2], 10) : 1;
      const year = idx < today.getMonth() ? today.getFullYear() + 1 : today.getFullYear();
      const d = new Date(Date.UTC(year, idx, Math.min(Math.max(day, 1), 28)));
      return { iso: isoOf(d), text: monthDay[0], flexible: false };
    }
  }

  const numeric = s.match(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/);
  if (numeric && parseInt(numeric[1], 10) <= 12 && parseInt(numeric[2], 10) <= 31) {
    const month = parseInt(numeric[1], 10) - 1;
    const day = parseInt(numeric[2], 10);
    let year = numeric[3] ? parseInt(numeric[3], 10) : today.getFullYear();
    if (year < 100) year += 2000;
    if (!numeric[3] && month < today.getMonth()) year += 1;
    return { iso: isoOf(new Date(Date.UTC(year, month, day))), text: numeric[0], flexible: false };
  }

  const relative = s.match(/\b(?:in\s+)?(\d+|a few|couple)\s*(day|week|month)s?\b/);
  if (relative && /\b(move|need|start|lease|looking|available)\b/.test(s)) {
    const qty = parseCount(relative[1]) ?? 2;
    const unitDays = { day: 1, week: 7, month: 30 }[relative[2]];
    const d = new Date(now + qty * unitDays * 86400000);
    return { iso: isoOf(d), text: relative[0], flexible: true };
  }

  if (/\bnext month\b/.test(s)) {
    const d = new Date(Date.UTC(today.getFullYear(), today.getMonth() + 1, 1));
    return { iso: isoOf(d), text: 'next month', flexible: true };
  }
  if (/\b(end of (?:the )?month|eom)\b/.test(s)) {
    const d = new Date(Date.UTC(today.getFullYear(), today.getMonth() + 1, 0));
    return { iso: isoOf(d), text: 'end of the month', flexible: true };
  }
  if (/\b(?:my )?lease (?:is )?(?:up|ends|expires)\b/.test(s)) {
    return { text: 'when their current lease ends', flexible: true };
  }
  return null;
}

/** 'sept' and 'sep' are both September; the array has both, so map by prefix. */
function monthIndexFromAbbr(abbr) {
  return MONTHS.findIndex((m) => m.startsWith(abbr.slice(0, 3)));
}

function isoOf(d) {
  return new Date(d).toISOString().slice(0, 10);
}

/**
 * Area extraction. Markets are configuration, never code, so this engine works
 * in any city the day someone hands it a market file. Until then, zip codes,
 * a few universal area words, and a conservative "in/near X" fallback keep the
 * thread moving without inventing neighborhoods that do not exist.
 * @param {string} s
 * @param {import('./market.js').Market} [market]
 * @returns {string[]}
 */
export function extractAreas(input, market) {
  const s = String(input ?? '').toLowerCase();
  const found = new Set();

  for (const z of s.match(/\b\d{5}\b/g) ?? []) if (!/^0/.test(z)) found.add(z);

  for (const area of market?.areas ?? []) {
    const names = [area.name, ...(area.aliases ?? [])];
    if (names.some((name) => new RegExp(`\\b${escapeRe(name.toLowerCase())}\\b`).test(s))) {
      found.add(area.name);
    }
  }

  for (const m of s.match(/\b(?:down|up|mid)town\b|\b(?:north|south|east|west)\s?(?:side|end)\b/g) ?? []) {
    found.add(m.trim());
  }

  if (found.size === 0) {
    const near = s.match(/\b(?:in|near|around|by|close to|off of|off)\s+((?:[a-z']{2,}\s+){0,2}[a-z']{2,})/);
    if (near) {
      const phrase = takePlaceWords(near[1]);
      if (phrase) found.add(phrase);
    }
  }
  return [...found];
}

/**
 * Trim a candidate place phrase down to the words that can plausibly be part of
 * a place name. Stops at leasing vocabulary so "in uptown under 2k" yields
 * "uptown", not "uptown under".
 * @param {string} phrase
 */
function takePlaceWords(phrase) {
  const words = [];
  const parts = phrase.split(/\s+/);
  if (['the', 'a', 'an'].includes(parts[0])) parts.shift(); // "around the medical district"
  for (const word of parts) {
    if (STOP_PLACE_WORDS.has(word) || word.length < 3 || /\d/.test(word)) break;
    words.push(word);
    if (words.length === 3) break;
  }
  const joined = words.join(' ').trim();
  if (!joined || STOP_PHRASES.has(joined)) return null;
  return joined;
}

/** Whole phrases that read like a place but never are. */
const STOP_PHRASES = new Set([
  'my price', 'the same', 'the works', 'the way', 'the middle', 'the phone',
  'the meantime', 'the process', 'the market', 'the future', 'the works',
]);

/** Words that can never start or continue a neighborhood name in this context. */
const STOP_PLACE_WORDS = new Set([
  'under','below','over','above','around','about','near','with','without','for','and','or','but',
  'that','this','the','a','an','my','your','our','their','his','her','its','is','are','was','were',
  'budget','price','range','rent','month','monthly','moving','move','date','dates','lease','leases',
  'apartment','apartments','place','places','unit','units','spot','area','areas','city','town',
  'asap','soon','now','today','tomorrow','week','weeks','day','days','year','years','time','times',
  'bed','beds','bedroom','bedrooms','bath','baths','bathroom','person','people','pets','pet',
  'mind','touch','general','particular','advance','case','fact','order','process','meantime',
  'anything','something','everything','nothing','somewhere','anywhere','there','here','me','you',
  'phone','email','text','call','dm','morning','afternoon','evening','night','tonight','possible',
]);

function escapeRe(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** @param {string} s */
export function extractOccupants(input) {
  const s = String(input ?? '').toLowerCase();
  if (/\b(just me|only me|myself|solo|by myself|1 person|one person)\b/.test(s)) return 1;
  const explicit = s.match(/\b(\d+|two|three|four|five|couple)\s*(?:of us|people|adults|occupants|roommates|on the lease)\b/);
  if (explicit) {
    const n = parseCount(explicit[1]);
    if (n != null && n > 0 && n <= 10) return explicit[1] === 'couple' ? 2 : n;
  }
  // "me and my girlfriend/boyfriend/partner/wife/husband/roommate" -> 2
  if (/\b(?:me|myself)\s+and\s+my\s+(girlfriend|boyfriend|partner|wife|husband|fiance|fiancee|roommate|spouse|significant other)\b/.test(s)) {
    return 2;
  }
  return null;
}

/** @param {string} s */
export function extractPets(input) {
  const s = String(input ?? '').toLowerCase();
  if (/\b(no pets|pet free|without pets|i do not have (?:any )?pets|no animals)\b/.test(s)) {
    return { has: false };
  }
  const petWord = s.match(/\b(dogs?|cats?|puppy|puppies|kitten|pets?|animals?)\b/);
  if (!petWord) return null;

  // An assistance animal is not a pet and must never be handled as one.
  if (/\b(service (?:dog|animal)|esa|emotional support|assistance animal)\b/.test(s)) {
    return { has: true, kind: 'assistance_animal' };
  }
  if (/\b(?:do you|does the|are|any|is there|what(?:'s| is)?)\b.*\bpet\b/.test(s) && !/\bi (?:have|got|own)\b/.test(s)) {
    return null; // asking about pet policy, not disclosing a pet
  }

  const count = s.match(/\b(\d+|two|three|a|one)\s+(dogs?|cats?)\b/);
  const weight = s.match(/\b(\d{2,3})\s*(?:lb|lbs|pound|pounds)\b/);
  const kind = /\bdog|puppy|puppies\b/.test(s) ? 'dog' : /\bcat|kitten\b/.test(s) ? 'cat' : 'pet';

  const out = { has: true, kind };
  if (count) {
    const c = parseCount(count[1]);
    if (c != null && c > 0 && c <= 6) out.count = c;
  }
  if (weight) out.weightLb = parseInt(weight[1], 10);
  return out;
}

/** @param {string} s */
export function extractIncome(input) {
  const s = String(input ?? '').toLowerCase();
  const yearly = s.match(/\$?(\d[\d.]*k?)\s*(?:a|per|\/)\s*(?:year|yr|annually)\b/) || s.match(/\bi make\s*\$?(\d[\d.]*k?)\s*(?:a year|yearly|annually)\b/);
  if (yearly) {
    const amount = parseMoney(yearly[1]);
    if (amount && amount >= 10000) return { monthlyGross: Math.round(amount / 12) };
  }
  const monthly = s.match(/(?:i make|i bring home|income(?: is)?|making|make)\s*\$?(\d[\d.]*k?)\s*(?:a|per|\/)?\s*(?:mo|month|monthly)?\b/);
  if (monthly) {
    const amount = parseMoney(monthly[1]);
    if (amount && amount >= 800 && amount <= 100000) return { monthlyGross: amount };
  }
  return null;
}

/**
 * Rental and credit history. These are the make-or-break screening facts: a
 * broken lease or an eviction changes the entire property list, so catching
 * them early is the difference between a placement and a wasted tour.
 * @param {string} s
 */
export function extractScreening(input) {
  const s = String(input ?? '').toLowerCase();
  /** @type {Record<string, boolean>} */
  const out = {};
  const negated = (re) => new RegExp(`\\b(?:no|never|not|without|zero|do not have (?:a|an)?)\\s+(?:\\w+\\s+){0,2}${re}`).test(s);

  if (/\bbroken leases?|lease breaks?|broke (?:my|a) lease|lease violations?\b/.test(s)) out.brokenLease = !negated('broken leases?|lease breaks?');
  if (/\bevict(?:ion|ions|ed)\b/.test(s)) out.eviction = !negated('evict(?:ion|ions|ed)');
  if (/\bfelon(?:y|ies|ious)\b/.test(s)) out.felony = !negated('felon(?:y|ies)');
  if (/\bmisdemeanors?\b/.test(s)) out.misdemeanor = !negated('misdemeanors?');
  if (/\bbankrupt(?:cy)?\b/.test(s)) out.bankruptcy = !negated('bankrupt(?:cy)?');
  if (/\bbad credit|poor credit|low credit|credit is (?:bad|rough|not great|terrible)|no credit\b/.test(s)) out.poorCredit = true;
  if (/\bgood credit|great credit|credit is (?:good|great|fine|solid|excellent)|high credit\b/.test(s)) out.poorCredit = false;

  return Object.keys(out).length ? out : null;
}

/** @param {string} original Raw text: phone and email formatting matters here. */
export function extractContact(original) {
  /** @type {Record<string, string>} */
  const out = {};
  const email = original.match(/\b[\w.+-]+@[\w-]+\.[\w.]{2,}\b/);
  if (email) out.email = email[0].toLowerCase();

  const phone = original.match(/(?:\+?1[\s.-]?)?\(?(\d{3})\)?[\s.-]?(\d{3})[\s.-]?(\d{4})\b/);
  if (phone) {
    const digits = `${phone[1]}${phone[2]}${phone[3]}`;
    // Reject obvious non-phones (a rent number, a year, a zip run-on).
    if (!/^(\d)\1{9}$/.test(digits)) out.phone = digits;
  }

  const lower = original.toLowerCase();
  if (/\b(call me|give me a call|phone call)\b/.test(lower)) out.preferred = 'phone';
  else if (/\b(text me|shoot me a text|sms)\b/.test(lower)) out.preferred = 'text';
  else if (/\b(email me)\b/.test(lower)) out.preferred = 'email';

  return Object.keys(out).length ? out : null;
}

const AMENITY_PATTERNS = [
  [/\b(washer|dryer|w\/d|laundry in unit|in unit laundry|full size w)\b/, 'washer_dryer'],
  [/\b(garage|covered parking|reserved parking|attached garage)\b/, 'garage'],
  [/\b(gated|controlled access|secure entry)\b/, 'gated'],
  [/\b(pool)\b/, 'pool'],
  [/\b(gym|fitness)\b/, 'gym'],
  [/\b(yard|patio|balcony|backyard)\b/, 'outdoor_space'],
  [/\b(pet friendly|dog park|pet park)\b/, 'pet_friendly'],
  [/\b(furnished)\b/, 'furnished'],
  [/\b(short term|month to month|corporate|6 month|three month)\b/, 'short_term'],
  [/\b(new build|newly built|brand new|new construction|updated|renovated)\b/, 'new_construction'],
  [/\b(first floor|ground floor|top floor|no stairs|elevator)\b/, 'floor_preference'],
  [/\b(all bills paid|abp|utilities included|water paid)\b/, 'bills_paid'],
];

/** @param {string} s */
export function extractAmenities(input) {
  const s = String(input ?? '').toLowerCase();
  const out = [];
  for (const [re, tag] of AMENITY_PATTERNS) if (re.test(s)) out.push(tag);
  return out;
}

/**
 * Merge newly extracted slots onto a conversation. Later statements win, but a
 * new message never erases a known fact by staying silent about it.
 * @param {import('../core/types.js').Slots} current
 * @param {Partial<import('../core/types.js').Slots>} incoming
 * @returns {{slots: import('../core/types.js').Slots, changed: string[]}}
 */
export function mergeSlots(current, incoming) {
  const slots = { ...current };
  const changed = [];
  for (const [key, value] of Object.entries(incoming)) {
    if (value == null) continue;
    const before = JSON.stringify(slots[key]);
    if (Array.isArray(value)) {
      const merged = [...new Set([...(slots[key] ?? []), ...value])];
      slots[key] = merged;
    } else if (typeof value === 'object') {
      slots[key] = { ...(slots[key] ?? {}), ...value };
    } else {
      slots[key] = value;
    }
    if (JSON.stringify(slots[key]) !== before) changed.push(key);
  }
  return { slots, changed };
}

const DAY_WORDS = 'monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tues|tue|wed|thur|thurs|thu|fri|sat|sun';

/**
 * When a lead can actually go see places. Captured as the phrase they used —
 * a scheduling module can parse it into real times later; until then it is
 * exactly what a human agent would jot down.
 * @param {string} s
 */
export function extractTourAvailability(input) {
  const s = String(input ?? '').toLowerCase();
  const window = s.match(
    new RegExp(`\\b(?:(?:this |next |any )?(?:${DAY_WORDS})(?:\\s*(?:or|and|,)\\s*(?:${DAY_WORDS}))*|this weekend|next weekend|weekends?|weekdays?|any day|any time|whenever)\\b`),
  );
  const partOfDay = s.match(/\b(mornings?|afternoons?|evenings?|after work|after \d{1,2}(?::\d{2})?\s*(?:am|pm)?|before \d{1,2}(?::\d{2})?\s*(?:am|pm)?)\b/);

  if (!window && !partOfDay) return null;
  return [window?.[0], partOfDay?.[0]].filter(Boolean).join(' ');
}
