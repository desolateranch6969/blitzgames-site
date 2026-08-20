/**
 * Seeded, deterministic pseudo-randomness.
 *
 * Variation is what keeps replies from sounding like a bot, but variation that
 * changes on every call is untestable and makes a retried webhook say something
 * different the second time. So every random choice is seeded from stable facts
 * (thread id + turn number + what we're saying). Same situation, same words;
 * different lead, different words.
 */

/** @param {string} str */
export function hashString(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

/**
 * Small, fast, well-distributed PRNG (mulberry32).
 * @param {string|number} seed
 * @returns {() => number} float in [0, 1)
 */
export function createRng(seed) {
  let a = typeof seed === 'number' ? seed >>> 0 : hashString(String(seed));
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * @template T
 * @param {() => number} rng
 * @param {readonly T[]} items
 * @returns {T}
 */
export function pick(rng, items) {
  if (!items || items.length === 0) throw new Error('pick() called with no items');
  return items[Math.floor(rng() * items.length)];
}

/**
 * Pick without immediately repeating a recently used value.
 * @template T
 * @param {() => number} rng
 * @param {readonly T[]} items
 * @param {Set<string>} recent
 * @param {(item: T) => string} [key]
 * @returns {T}
 */
export function pickFresh(rng, items, recent, key = (i) => String(i)) {
  const fresh = items.filter((i) => !recent.has(key(i)));
  const pool = fresh.length > 0 ? fresh : items;
  const chosen = pick(rng, pool);
  recent.add(key(chosen));
  return chosen;
}

/** @param {() => number} rng @param {number} probability */
export function chance(rng, probability) {
  return rng() < probability;
}

/**
 * Normal-ish draw via central limit, clamped. Used for word counts and delays,
 * where a flat distribution reads as mechanical.
 * @param {() => number} rng
 */
export function gaussian(rng, mean, sd, min = -Infinity, max = Infinity) {
  const u = (rng() + rng() + rng() + rng() + rng() + rng() - 3) / 3;
  return Math.min(max, Math.max(min, mean + u * sd));
}
