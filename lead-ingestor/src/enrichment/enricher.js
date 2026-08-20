/**
 * Enrichment orchestration.
 *
 * Enrichment answers one question: what can be established about this person
 * from sources they made public, cheaply, without guessing? Everything it
 * produces is a Fact with provenance — a value, where it came from, how it was
 * obtained, when, and a URL a human can open to check it.
 *
 * Four rules the orchestrator enforces, so no provider has to:
 *
 *   1. **Disposition gate.** Spam and vendor pitches are never enriched. There
 *      is no reason to go build a profile of someone selling SEO services, and
 *      every reason not to accumulate data on people who never asked for
 *      anything.
 *   2. **Budget.** A fixed number of provider calls per person and a politeness
 *      delay per host. Enrichment that hammers a site gets blocked, and a lead
 *      that costs thirty requests to research is not worth researching.
 *   3. **Cache.** Facts have a TTL. Re-fetching a bio that changes twice a year
 *      on every message is waste.
 *   4. **No inference laundering.** A provider may return `method: 'inferred'`,
 *      but it must say so. An inference that gets stored looking like an
 *      observation is how a wrong fact becomes permanent.
 */
import { ROUTING } from '../triage/triage.js';

/**
 * @typedef {Object} Provider
 * @property {string} name
 * @property {string} [host]           For politeness pacing.
 * @property {(person: any, ctx: any) => boolean} appliesTo
 * @property {(person: any, ctx: any) => Promise<import('../core/types.js').Fact[]>} fetch
 * @property {number} [ttlMs]
 */

/**
 * @param {{
 *   providers?: Provider[],
 *   maxCallsPerPerson?: number,
 *   politenessMs?: number,
 *   defaultTtlMs?: number,
 *   cache?: Map<string, {at: number, facts: any[]}>,
 *   logger?: any,
 *   now?: () => number,
 *   sleep?: (ms: number) => Promise<void>,
 * }} [config]
 */
export function createEnricher(config = {}) {
  const {
    providers = [],
    maxCallsPerPerson = 4,
    politenessMs = 1500,
    defaultTtlMs = 14 * 24 * 3600_000,
    cache = new Map(),
    logger,
    now = () => Date.now(),
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  } = config;

  /** @type {Map<string, number>} */
  const lastHostCall = new Map();

  /** @param {Provider} provider */
  function register(provider) {
    if (!provider?.name || typeof provider.fetch !== 'function') {
      throw new Error('a provider needs a name and a fetch(person, ctx) function');
    }
    providers.push(provider);
  }

  /**
   * @param {import('../core/types.js').Person} person
   * @param {{triage?: import('../core/types.js').Triage, force?: boolean, lead?: any}} [ctx]
   * @returns {Promise<{facts: import('../core/types.js').Fact[], ran: string[], skipped: {provider: string, reason: string}[]}>}
   */
  async function enrich(person, ctx = {}) {
    /** @type {import('../core/types.js').Fact[]} */
    const facts = [];
    /** @type {string[]} */
    const ran = [];
    /** @type {{provider: string, reason: string}[]} */
    const skipped = [];

    const disposition = ctx.triage?.disposition;
    if (disposition && ROUTING[disposition] && !ROUTING[disposition].enrich && !ctx.force) {
      return { facts, ran, skipped: [{ provider: '*', reason: `disposition "${disposition}" is not enriched` }] };
    }

    let calls = 0;
    for (const provider of providers) {
      if (calls >= maxCallsPerPerson) {
        skipped.push({ provider: provider.name, reason: 'per-person call budget spent' });
        continue;
      }

      let applies = false;
      try {
        applies = provider.appliesTo ? provider.appliesTo(person, ctx) : true;
      } catch (err) {
        skipped.push({ provider: provider.name, reason: `appliesTo threw: ${err.message}` });
        continue;
      }
      if (!applies) {
        skipped.push({ provider: provider.name, reason: 'nothing for it to work from' });
        continue;
      }

      const cacheKey = `${provider.name}:${person.id}`;
      const cached = cache.get(cacheKey);
      const ttl = provider.ttlMs ?? defaultTtlMs;
      if (cached && now() - cached.at < ttl && !ctx.force) {
        facts.push(...cached.facts);
        skipped.push({ provider: provider.name, reason: 'cached' });
        continue;
      }

      if (provider.host) {
        const since = now() - (lastHostCall.get(provider.host) ?? 0);
        if (since < politenessMs) await sleep(politenessMs - since);
        lastHostCall.set(provider.host, now());
      }

      try {
        const produced = (await provider.fetch(person, ctx)) ?? [];
        const stamped = produced.filter(Boolean).map((fact) => ({
          observedAt: new Date(now()).toISOString(),
          source: provider.name,
          method: 'public_page',
          ...fact,
        }));
        facts.push(...stamped);
        cache.set(cacheKey, { at: now(), facts: stamped });
        ran.push(provider.name);
        calls++;
      } catch (err) {
        // A provider failing is normal — profiles go private, sites go down,
        // vendors rate limit. It is never a reason to fail the whole enrichment.
        logger?.warn?.('enrichment provider failed', { provider: provider.name, error: String(err.message) });
        skipped.push({ provider: provider.name, reason: `failed: ${err.message}` });
        calls++;
      }
    }

    return { facts, ran, skipped };
  }

  return { enrich, register, providers, cache };
}
