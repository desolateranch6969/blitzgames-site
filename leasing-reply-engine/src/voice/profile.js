/**
 * Voice profiles.
 *
 * A voice profile is pure data describing how one person writes: their phrase
 * bank per speech act, how often they capitalize, how often they abbreviate,
 * which emoji they actually use, whether they fire off three short bubbles or
 * one paragraph, and the verbal tics that make them sound like them.
 *
 * Nothing about the engine's behavior lives here — only its sound. That is what
 * makes the swap cheap: `standard-locator` is a stand-in written to be
 * plausible for the trade; when the real corpus of his DMs is collected,
 * `learn.js` writes a profile in this same shape and the engine speaks like him
 * with no code change.
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const PROFILE_DIR = join(HERE, 'profiles');

/**
 * @typedef {Object} VoiceStyle
 * @property {'as-written'|'lower'|'sentence'} casing
 * @property {number} terminalPunctuationRate  How often a message ends in . ! or ?
 * @property {number} exclamationRate
 * @property {number} emojiRate
 * @property {string[]} emojiPalette
 * @property {number} maxEmojiPerMessage
 * @property {number} abbreviationRate
 * @property {Record<string,string>} abbreviations
 * @property {{splitRate: number, maxBubbles: number, targetWordsPerBubble: number}} bubbles
 * @property {{baseMs: number, msPerChar: number, jitterMs: number, maxMs: number}} typing
 *
 * @typedef {Object} VoiceTic
 * @property {string} phrase
 * @property {number} rate
 * @property {'lead'|'trail'} [position]
 *
 * @typedef {Object} VoiceProfile
 * @property {string} id
 * @property {string} displayName
 * @property {string} version
 * @property {{source: string, sampleCount: number, note?: string, builtAt?: string}} provenance
 * @property {VoiceStyle} style
 * @property {VoiceTic[]} tics
 * @property {string[]} banned            Phrases this voice must never emit.
 * @property {Record<string, string[]>} phrases  Speech act id -> variants.
 * @property {{lead: string, agent: string}[]} exemplars  Few-shot material for the LLM realizer.
 */

/** @type {VoiceStyle} */
export const DEFAULT_STYLE = {
  casing: 'as-written',
  terminalPunctuationRate: 0.5,
  exclamationRate: 0.1,
  emojiRate: 0.1,
  emojiPalette: [],
  maxEmojiPerMessage: 1,
  abbreviationRate: 0,
  abbreviations: {},
  bubbles: { splitRate: 0.3, maxBubbles: 3, targetWordsPerBubble: 14 },
  typing: { baseMs: 800, msPerChar: 25, jitterMs: 400, maxMs: 6000 },
};

/**
 * Phrases every profile needs so a partial profile can never leave the engine
 * speechless. A learned profile that only covers half the acts inherits the
 * rest from here.
 * @type {Record<string, string[]>}
 */
export const FALLBACK_PHRASES = {
  greet: ['hey{name}!'],
  'ack.criteria': ['got it{criteriaSummary}.'],
  'ack.thanks': ['anytime!'],
  'ack.smalltalk': ['doing good, staying busy!'],
  'answer.fee': ['no charge to you at all — the property pays my side.'],
  'answer.process': ['i pull a list that fits what you want, you tell me what you like, and i set up the tours.'],
  'answer.screening': ['most places want to see about {multiple}x the rent in gross monthly income, and they run credit and background.'],
  'answer.pets': ['most places are pet friendly, a few have breed and weight limits — i check that before i send anything.'],
  'answer.specials': ['there are specials out there right now, they change weekly. i check them when i pull your list.'],
  'answer.application': ['application fees and deposits are set by each property, i list them out with the options.'],
  'answer.location': ['i can send the exact address and the cross streets.'],
  'answer.listings.promise': ['let me pull a few that fit and send them over.'],
  'answer.listings.results': ['here are a few that fit:{listings}'],
  'answer.tour.promise': ['i can get tours set up — what days work for you?'],
  'answer.tour.options': ['here is what is open:{tourSlots}'],
  'ack.tour.availability': ['{when} works. i will confirm the times and send you the addresses. what is the best number to reach you at?'],
  'ask.moveIn': ['when are you looking to move?'],
  'ask.areas': ['what area are you trying to be in?'],
  'ask.beds': ['how many bedrooms do you need?'],
  'ask.budget': ['what are you trying to stay under on rent?'],
  'ask.occupants': ['how many people will be on the lease?'],
  'ask.pets': ['any pets?'],
  'ask.screening': ['any broken leases or evictions on your record? asking so i only send places that will actually approve you.'],
  'ask.income': ['what does your gross monthly income look like?'],
  'ask.contact': ['whats the best number to reach you at?'],
  'compliance.steering': ['i cannot speak to what an area or its residents are like — fair housing rules. i can send public data sources so you can look for yourself.'],
  'compliance.assistance_animal': ['assistance animals are not treated as pets, so no pet rent or pet deposit applies.'],
  'compliance.accessibility': ['i can look specifically for units that meet accessibility needs.'],
  'compliance.voucher': ['let me get you with someone on the voucher side.'],
  'handoff.human': ['let me look at that one myself and come right back to you.'],
  'optout.ack': ['no problem, i will stop here. good luck with the search!'],
  'fallback.unknown': ['let me make sure i follow — can you say a little more?'],
};

/** @param {Partial<VoiceProfile>} raw */
export function createVoiceProfile(raw = {}) {
  /** @type {VoiceProfile} */
  const profile = {
    id: raw.id ?? 'unnamed',
    displayName: raw.displayName ?? raw.id ?? 'Unnamed voice',
    version: raw.version ?? '0.0.0',
    provenance: { source: 'unknown', sampleCount: 0, ...(raw.provenance ?? {}) },
    style: {
      ...DEFAULT_STYLE,
      ...(raw.style ?? {}),
      bubbles: { ...DEFAULT_STYLE.bubbles, ...(raw.style?.bubbles ?? {}) },
      typing: { ...DEFAULT_STYLE.typing, ...(raw.style?.typing ?? {}) },
      abbreviations: { ...DEFAULT_STYLE.abbreviations, ...(raw.style?.abbreviations ?? {}) },
    },
    tics: raw.tics ?? [],
    banned: [...DEFAULT_BANNED, ...(raw.banned ?? [])],
    phrases: { ...FALLBACK_PHRASES, ...(raw.phrases ?? {}) },
    exemplars: raw.exemplars ?? [],
  };
  return profile;
}

/**
 * Phrases no voice may emit. These are the tells that a lead is talking to
 * software, plus the promises nobody is allowed to make on a property's behalf.
 */
export const DEFAULT_BANNED = [
  'as an ai',
  'as a language model',
  'i apologize for any inconvenience',
  'i am unable to',
  'thank you for reaching out to us',
  'we value your business',
  'guaranteed approval',
  'you will be approved',
  'i guarantee',
  'best rates in the city',
];

/**
 * @param {VoiceProfile} profile
 * @returns {{ok: boolean, errors: string[], warnings: string[]}}
 */
export function validateVoiceProfile(profile) {
  const errors = [];
  const warnings = [];

  if (!profile?.id) errors.push('profile.id is required');
  const style = profile?.style ?? {};
  for (const rate of ['terminalPunctuationRate', 'exclamationRate', 'emojiRate', 'abbreviationRate']) {
    const v = style[rate];
    if (v != null && (typeof v !== 'number' || v < 0 || v > 1)) errors.push(`style.${rate} must be between 0 and 1`);
  }
  if (style.emojiRate > 0 && !(style.emojiPalette ?? []).length) {
    warnings.push('style.emojiRate is above zero but emojiPalette is empty; no emoji will be used');
  }
  for (const [act, variants] of Object.entries(profile?.phrases ?? {})) {
    if (!Array.isArray(variants) || variants.length === 0) errors.push(`phrases["${act}"] must be a non-empty array`);
    else if (variants.length === 1 && !act.startsWith('compliance.')) {
      warnings.push(`phrases["${act}"] has only one variant; replies will repeat verbatim`);
    }
  }
  for (const tic of profile?.tics ?? []) {
    if (!tic.phrase) errors.push('every tic needs a phrase');
    if (tic.rate == null || tic.rate < 0 || tic.rate > 1) errors.push(`tic "${tic.phrase}" needs a rate between 0 and 1`);
  }
  return { ok: errors.length === 0, errors, warnings };
}

/**
 * @param {string} idOrPath
 * @returns {VoiceProfile}
 */
export function loadVoiceProfile(idOrPath) {
  const candidates = [
    idOrPath,
    join(PROFILE_DIR, `${idOrPath}.json`),
    join(process.cwd(), idOrPath),
  ];
  const found = candidates.find((p) => p && existsSync(p) && p.endsWith('.json'));
  if (!found) {
    throw new Error(
      `voice profile "${idOrPath}" not found. Available: ${listVoiceProfiles().join(', ') || '(none)'}`,
    );
  }
  const raw = JSON.parse(readFileSync(found, 'utf8'));
  const profile = createVoiceProfile(raw);
  const { ok, errors } = validateVoiceProfile(profile);
  if (!ok) throw new Error(`voice profile "${profile.id}" is invalid:\n  - ${errors.join('\n  - ')}`);
  return profile;
}

export function listVoiceProfiles() {
  if (!existsSync(PROFILE_DIR)) return [];
  return readdirSync(PROFILE_DIR).filter((f) => f.endsWith('.json')).map((f) => f.replace(/\.json$/, ''));
}

/**
 * Merge a learned profile over a base one. Learned material always wins where
 * it exists; the base fills the gaps. This is how a thin corpus still produces
 * a usable voice on day one and gets sharper as more samples arrive.
 * @param {VoiceProfile} base
 * @param {Partial<VoiceProfile>} learned
 */
export function mergeVoiceProfiles(base, learned) {
  const phrases = { ...base.phrases };
  for (const [act, variants] of Object.entries(learned.phrases ?? {})) {
    if (variants?.length) phrases[act] = variants;
  }
  return createVoiceProfile({
    ...base,
    ...learned,
    style: { ...base.style, ...(learned.style ?? {}) },
    phrases,
    tics: learned.tics?.length ? learned.tics : base.tics,
    exemplars: [...(learned.exemplars ?? []), ...base.exemplars].slice(0, 40),
  });
}
