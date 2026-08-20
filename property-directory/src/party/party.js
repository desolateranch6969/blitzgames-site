/**
 * Party separation: is this message from a customer, or from the industry?
 *
 * This is the reason the directory has to exist before the inbox can be trusted.
 * A DM from a property's leasing manager and a DM from a renter arrive through
 * the same pipe and look similar — both mention units, budgets, and move dates.
 * Without this check, the assistant qualifies a property manager as a renter,
 * asks her what her budget is, opens a follow-up, and researches her. Every part
 * of that is wrong, and it is wrong in front of the exact people whose goodwill
 * the business runs on.
 *
 * The check runs **upstream of triage**, so an industry message never enters the
 * renter funnel at all — rather than being classified and then filtered out.
 *
 * ## Matching, weakest link acknowledged
 *
 * Handles, emails, and phone numbers are exact matches on a known contact —
 * strong, and the only kind that decides on its own.
 *
 * An email *domain* match is weaker: `@alderresidential.com` identifies the
 * company, not the person, and a management company's domain will also be worn
 * by someone who genuinely wants an apartment. Domain matches come back as
 * `probable` and carry the reason, so the operator confirms rather than the
 * system assuming.
 */

import { ROLES } from '../contacts/titles.js';

/**
 * @typedef {Object} PartyResult
 * @property {'industry'|'customer'|'unknown'} party
 * @property {'certain'|'probable'|'none'} confidence
 * @property {string} [matchedOn]     What matched: 'instagram', 'email', 'phone', 'domain'.
 * @property {object} [contact]
 * @property {object} [node]
 * @property {string} reason
 */

/**
 * Build the party index from a roster and a tree.
 *
 * @param {{roster: any, tree: any}} deps
 * @param {{extraDomains?: string[]}} [opts]
 */
export function createPartyIndex({ roster, tree }, opts = {}) {
  /** @type {Map<string, {contactId: string, kind: string}>} */
  let exact = new Map();
  /** @type {Map<string, string[]>} domain -> contact ids */
  let domains = new Map();
  let builtAt = null;

  /**
   * Rebuild the lookup tables. Cheap enough to run after every import; the
   * directory changes far less often than the inbox does.
   */
  function rebuild() {
    exact = new Map();
    domains = new Map();

    for (const contact of roster.allContacts()) {
      for (const channel of contact.channels ?? []) {
        exact.set(key(channel.kind, channel.value), { contactId: contact.id, kind: channel.kind });

        if (channel.kind === 'email') {
          const domain = channel.value.split('@')[1];
          if (domain && !FREE_EMAIL_DOMAINS.has(domain)) {
            domains.set(domain, [...(domains.get(domain) ?? []), contact.id]);
          }
        }
      }
    }

    for (const domain of opts.extraDomains ?? []) {
      const clean = String(domain).toLowerCase().replace(/^@/, '');
      if (clean && !domains.has(clean)) domains.set(clean, []);
    }

    builtAt = new Date().toISOString();
    return { exact: exact.size, domains: domains.size, builtAt };
  }

  /**
   * @param {{handle?: string, email?: string, phone?: string, platform?: string, platformId?: string}} actor
   * @returns {PartyResult}
   */
  function identify(actor = {}) {
    if (!builtAt) rebuild();

    const candidates = [
      ['instagram', normalize('instagram', actor.handle)],
      ['email', normalize('email', actor.email)],
      ['phone', normalize('phone', actor.phone)],
    ];

    for (const [kind, value] of candidates) {
      if (!value) continue;
      const hit = exact.get(key(kind, value));
      if (!hit) continue;

      const contact = roster.getContact(hit.contactId);
      const assignment = roster.current(hit.contactId)[0];
      const node = assignment ? tree.resolve(assignment.nodeId) : null;

      return {
        party: 'industry',
        confidence: 'certain',
        matchedOn: kind,
        contact,
        node,
        reason: node
          ? `${contact.displayName} is on file as ${(ROLES[contact.role]?.label ?? contact.role).toLowerCase()} at ${node.name}`
          : `${contact.displayName} is on file as an industry contact`,
      };
    }

    // Domain-only: the company is recognized, the person is not.
    const email = normalize('email', actor.email);
    const domain = email?.split('@')[1];
    if (domain && domains.has(domain)) {
      const sample = (domains.get(domain) ?? []).map((id) => roster.getContact(id)).filter(Boolean)[0];
      const assignment = sample ? roster.current(sample.id)[0] : null;
      const node = assignment ? tree.resolve(assignment.nodeId) : null;
      return {
        party: 'industry',
        confidence: 'probable',
        matchedOn: 'domain',
        contact: null,
        node,
        reason: `writes from ${domain}, a known management domain, but is not an individual on file — confirm before treating as industry`,
      };
    }

    return { party: 'unknown', confidence: 'none', reason: 'not a known industry contact' };
  }

  /**
   * The function to hand the lead ingestor. It answers one question and returns
   * a plain object, so neither module has to import the other.
   */
  function resolver() {
    return (actor) => identify(actor);
  }

  return { rebuild, identify, resolver, stats: () => ({ exact: exact.size, domains: domains.size, builtAt }) };
}

/**
 * Free-mail domains identify nothing. A leasing agent using a personal gmail is
 * still reachable by her exact address, but the domain must never mark every
 * gmail user in the inbox as industry.
 */
const FREE_EMAIL_DOMAINS = new Set([
  'gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com', 'icloud.com', 'aol.com',
  'live.com', 'msn.com', 'me.com', 'mac.com', 'protonmail.com', 'proton.me',
  'comcast.net', 'sbcglobal.net', 'att.net', 'verizon.net', 'ymail.com', 'gmx.com',
]);

function key(kind, value) {
  return `${kind}:${value}`;
}

function normalize(kind, raw) {
  const value = String(raw ?? '').trim();
  if (!value) return null;
  if (kind === 'email') {
    const email = value.toLowerCase();
    return /^[^@\s]+@[^@\s.]+\.[^@\s]{2,}$/.test(email) ? email : null;
  }
  if (kind === 'phone') {
    const digits = value.replace(/[^\d]/g, '');
    if (digits.length === 10) return `+1${digits}`;
    if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
    return null;
  }
  if (kind === 'instagram') {
    const handle = value.toLowerCase().replace(/^@+/, '').replace(/^https?:\/\/(www\.)?instagram\.com\//, '').replace(/\/.*$/, '');
    return /^[a-z0-9._]{1,30}$/.test(handle) ? handle : null;
  }
  return value;
}
