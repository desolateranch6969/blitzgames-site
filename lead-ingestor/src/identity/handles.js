/**
 * Identifier normalization.
 *
 * Every identity decision downstream compares normalized values, so this file
 * is the only place that decides what "the same handle" means. Getting it wrong
 * merges two different people, which is the worst failure this module can have —
 * it puts one person's private details on another person's record.
 */

/** @param {string} input */
export function normalizeHandle(input) {
  if (!input) return null;
  const handle = String(input)
    .trim()
    .toLowerCase()
    .replace(/^@+/, '')
    .replace(/^https?:\/\/(www\.)?instagram\.com\//, '')
    .replace(/\/.*$/, '')
    .replace(/\?.*$/, '');
  return /^[a-z0-9._]{1,30}$/.test(handle) ? handle : null;
}

/**
 * US-centric phone normalization to E.164. Returns null rather than guessing:
 * a wrong phone number on a person record is worse than a missing one.
 * @param {string} input
 */
export function normalizePhone(input) {
  if (!input) return null;
  const digits = String(input).replace(/[^\d]/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  if (digits.length > 11 && digits.length <= 15 && String(input).trim().startsWith('+')) return `+${digits}`;
  return null;
}

/** @param {string} input */
export function normalizeEmail(input) {
  if (!input) return null;
  const email = String(input).trim().toLowerCase();
  return /^[^@\s]+@[^@\s.]+\.[^@\s]{2,}$/.test(email) ? email : null;
}

/**
 * LinkedIn profile URLs come in many shapes; only the vanity slug is stable.
 * @param {string} input
 */
export function normalizeLinkedInUrl(input) {
  if (!input) return null;
  const match = String(input)
    .trim()
    .toLowerCase()
    .match(/linkedin\.com\/in\/([a-z0-9\-_%]+)/);
  return match ? `https://www.linkedin.com/in/${match[1].replace(/%[0-9a-f]{2}/g, '')}` : null;
}

/** @param {string} input */
export function normalizeWebsite(input) {
  if (!input) return null;
  let value = String(input).trim().toLowerCase();
  if (!/^https?:\/\//.test(value)) value = `https://${value}`;
  try {
    const url = new URL(value);
    if (!url.hostname.includes('.')) return null;
    return `${url.protocol}//${url.hostname.replace(/^www\./, '')}${url.pathname === '/' ? '' : url.pathname}`;
  } catch {
    return null;
  }
}

/**
 * Build a normalized identifier, or null if the value is not usable.
 *
 * Strength decides whether two people may be merged automatically. A phone or
 * email is strong: people do not share them by accident. A display name is not
 * an identifier at all, and a handle is only strong within its own platform.
 *
 * @param {import('../core/types.js').Identifier['kind']} kind
 * @param {string} value
 * @param {{source?: string, observedAt?: string}} [meta]
 * @returns {import('../core/types.js').Identifier|null}
 */
export function makeIdentifier(kind, value, meta = {}) {
  const normalized = {
    instagram_id: (v) => (String(v).trim() ? String(v).trim() : null),
    instagram_handle: normalizeHandle,
    phone: normalizePhone,
    email: normalizeEmail,
    linkedin_url: normalizeLinkedInUrl,
    website: normalizeWebsite,
  }[kind]?.(value);

  if (!normalized) return null;

  const strength = STRONG_KINDS.has(kind) ? 'strong' : 'weak';
  return {
    kind,
    value: normalized,
    strength,
    source: meta.source ?? 'unknown',
    observedAt: meta.observedAt ?? new Date().toISOString(),
  };
}

/**
 * Identifiers that uniquely name a human.
 *
 * `instagram_id` is here because it is the platform's own primary key.
 * `instagram_handle` is NOT: handles get changed, released, and re-registered
 * by someone else, so matching on a handle alone can attach an old record to a
 * new person.
 * `website` is not, either — a dozen employees share a company domain.
 */
const STRONG_KINDS = new Set(['instagram_id', 'phone', 'email', 'linkedin_url']);

/** @param {import('../core/types.js').Identifier} identifier */
export function identifierKey(identifier) {
  return `${identifier.kind}:${identifier.value}`;
}
