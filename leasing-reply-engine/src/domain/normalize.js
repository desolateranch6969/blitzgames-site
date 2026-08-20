/**
 * Text normalization for DM traffic.
 *
 * Instagram DMs are not sentences. They are "2/2 uptown ~1800 asap 🐶". Every
 * downstream stage (classifier, slot extraction) reads the normalized form,
 * while the realizer always sees the lead's original text so we can mirror how
 * *they* write when it matters.
 */

const CONTRACTIONS = {
  "i'm": 'i am', "im": 'i am', "ive": 'i have', "i've": 'i have',
  "dont": 'do not', "don't": 'do not', "doesnt": 'does not', "doesn't": 'does not',
  "cant": 'can not', "can't": 'can not', "wont": 'will not', "won't": 'will not',
  "whats": 'what is', "what's": 'what is', "thats": 'that is', "that's": 'that is',
  "its": 'it is', "it's": 'it is', "youre": 'you are', "you're": 'you are',
  "id": 'i would', "i'd": 'i would', "ill": 'i will', "i'll": 'i will',
  "lookin": 'looking', "tryna": 'trying to', "wanna": 'want to', "gonna": 'going to',
  "u": 'you', "ur": 'your', "yall": 'you all', "y'all": 'you all', "pls": 'please',
  "plz": 'please', "thx": 'thanks', "ty": 'thanks', "asap": 'as soon as possible',
  "abt": 'about', "bc": 'because', "b/c": 'because', "w/": 'with', "w/o": 'without',
  "apt": 'apartment', "apts": 'apartments', "bldg": 'building', "mo": 'month',
};

const NUMBER_WORDS = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6,
  seven: 7, eight: 8, nine: 9, ten: 10, a: 1, an: 1, couple: 2,
};

/** Strip emoji/pictographs but remember them — emoji carry tone, not content. */
const EMOJI_RE = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{1F900}-\u{1F9FF}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}]/gu;

/**
 * @param {string} text
 * @returns {{clean: string, tokens: string[], emoji: string[], original: string,
 *            hasQuestion: boolean, shouty: boolean, wordCount: number}}
 */
export function normalize(text) {
  const original = String(text ?? '');
  const emoji = original.match(EMOJI_RE) ?? [];
  let clean = original
    .replace(EMOJI_RE, ' ')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .toLowerCase();

  // Money and ranges must survive before punctuation is stripped.
  clean = clean
    .replace(/(\d),(\d{3})\b/g, '$1$2')            // 1,500 -> 1500
    .replace(/\s*[-–—]\s*/g, '-')                   // 1200 - 1500 -> 1200-1500
    .replace(/[^\w\s$%/.:'\-+#&]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const tokens = clean.split(' ').filter(Boolean).map((t) => {
    const stripped = t.replace(/^[^\w$#]+|[^\w%+]+$/g, '');
    return CONTRACTIONS[stripped] ?? stripped;
  });

  const expanded = tokens.join(' ').replace(/\s+/g, ' ').trim();

  return {
    original,
    clean: expanded,
    tokens: expanded.split(' ').filter(Boolean),
    emoji,
    hasQuestion: /\?/.test(original) || /^(what|when|where|how|do|does|can|is|are|any|who|which|would|could)\b/.test(expanded),
    shouty: original.length > 6 && original === original.toUpperCase() && /[A-Z]{3}/.test(original),
    wordCount: expanded ? expanded.split(' ').length : 0,
  };
}

/**
 * Parse a money-ish token into a number. Handles 1500, $1500, 1.5k, 2k, 1800/mo.
 * @param {string} token
 * @returns {number|null}
 */
export function parseMoney(token) {
  if (!token) return null;
  const m = String(token).toLowerCase().replace(/[$,]/g, '').match(/^(\d+(?:\.\d+)?)(k)?/);
  if (!m) return null;
  let value = parseFloat(m[1]);
  if (m[2] === 'k') value *= 1000;
  else if (value < 100 && value >= 1) value *= 1000; // "1.8" / "2" in a rent context
  return Math.round(value);
}

/** @param {string} token */
export function parseCount(token) {
  if (token == null) return null;
  const t = String(token).toLowerCase();
  if (t in NUMBER_WORDS) return NUMBER_WORDS[t];
  const n = parseFloat(t);
  return Number.isFinite(n) ? n : null;
}

/** Plausible monthly rent for a US apartment. Keeps phone numbers out of budget. */
export function isPlausibleRent(n) {
  return Number.isFinite(n) && n >= 300 && n <= 25000;
}
