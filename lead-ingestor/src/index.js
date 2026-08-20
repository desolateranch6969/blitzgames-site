/**
 * Lead ingestor — module 2.
 *
 * Sits upstream of the reply engine. Its whole job is to turn "something arrived
 * somewhere" into "a known person, with a lead, routed correctly".
 *
 *   sources ──▶ dedupe ──▶ resolve identity ──▶ attach to lead
 *                                                    │
 *                                              triage (no ranking)
 *                                                    │
 *                            ┌───────────────────────┼──────────────────┐
 *                            ▼                       ▼                  ▼
 *                     hand to reply engine     enrich in background   hold for human
 *
 * Same two seams as module 1, on purpose: it emits facts on a bus and asks a
 * capability registry whether anything downstream can act yet. It runs standalone
 * with no sources configured, no store, no API keys — it just has nothing to
 * ingest until one is registered.
 *
 * It never imports the reply engine. Handoff goes through an injected function,
 * so either module can be deployed, tested, or replaced without the other.
 */
import { createTriage, DISPOSITIONS, ROUTING } from './triage/triage.js';
import { createEnricher } from './enrichment/enricher.js';
import { buildProspectSheet } from './enrichment/prospect-sheet.js';
import { resolveActor, addFacts, addIdentifiers, compareIdentities } from './identity/identity.js';
import { makeIdentifier } from './identity/handles.js';
import { createStoreFromConfig } from './store/index.js';
import { resilient } from './sources/source.js';

export { DISPOSITIONS, ROUTING, createTriage } from './triage/triage.js';
export { buildProspectSheet, renderProspectSheet } from './enrichment/prospect-sheet.js';
export { createEnricher } from './enrichment/enricher.js';
export { createMemoryStore, createFileStore } from './store/index.js';
export { makeRawEvent } from './sources/source.js';

/** Events this module emits. The portal and any bolt-on subscribe to these. */
export const EVENTS = /** @type {const} */ ({
  EVENT_INGESTED: 'ingest.event',
  EVENT_DUPLICATE: 'ingest.duplicate',
  PERSON_CREATED: 'person.created',
  PERSON_MERGE_SUGGESTED: 'person.merge_suggested',
  LEAD_OPENED: 'lead.opened',
  LEAD_UPDATED: 'lead.updated',
  LEAD_TRIAGED: 'lead.triaged',
  LEAD_HANDED_OFF: 'lead.handed_off',
  LEAD_HELD: 'lead.held',
  INDUSTRY_MESSAGE: 'industry.message',
  ENRICHED: 'person.enriched',
  SOURCE_HEALTH: 'source.health',
  ERROR: 'error',
});

/**
 * Minimal bus, so the module has no dependency on module 1's. If an external bus
 * is passed in, both modules publish onto the same one.
 */
export function createBus({ logger } = {}) {
  const handlers = new Map();
  const wildcard = new Set();
  return {
    on(event, handler) {
      if (event === '*') {
        wildcard.add(handler);
        return () => wildcard.delete(handler);
      }
      if (!handlers.has(event)) handlers.set(event, new Set());
      handlers.get(event).add(handler);
      return () => handlers.get(event)?.delete(handler);
    },
    async emit(event, payload) {
      for (const handler of [...(handlers.get(event) ?? []), ...wildcard]) {
        try {
          await handler(payload, { event });
        } catch (err) {
          logger?.error?.('bus handler failed', { event, error: String(err?.stack ?? err) });
        }
      }
    },
  };
}

/**
 * @typedef {Object} IngestorConfig
 * @property {any} [store]
 * @property {'memory'|'file'} [storeKind]
 * @property {string} [storePath]
 * @property {any} [bus]
 * @property {any} [logger]
 * @property {{name?: string, areas?: string[]}} [market]
 * @property {(text: string) => Record<string, any>} [extractSlots]  Module 1's extractor, optional.
 * @property {(actor: object) => {party: string, confidence: string, reason: string, contact?: object, node?: object}} [identifyParty]
 *   Module 3's party resolver, optional. Injected rather than imported so the
 *   directory and the ingestor stay independent.
 * @property {(handoff: {lead: any, person: any, events: any[], sheet: any}) => any} [onHandoff]
 * @property {import('./enrichment/enricher.js').Provider[]} [enrichmentProviders]
 * @property {boolean} [enrichInline]  Await enrichment during ingest (tests); default false.
 */

/**
 * @param {IngestorConfig} [config]
 */
export function createIngestor(config = {}) {
  const logger = config.logger ?? nullLogger();
  const bus = config.bus ?? createBus({ logger });
  const store = config.store ?? createStoreFromConfig({ store: config.storeKind, storePath: config.storePath });

  const triage = createTriage({ market: config.market, extractSlots: config.extractSlots });
  const enricher = createEnricher({ providers: config.enrichmentProviders ?? [], logger });

  /** @type {Map<string, import('./sources/source.js').Source>} */
  const sources = new Map();
  /** @type {Map<string, any>} */
  const timers = new Map();
  let running = false;

  // ------------------------------------------------------------- sources --

  /** @param {import('./sources/source.js').Source} source */
  function addSource(source) {
    if (!source?.name) throw new Error('a source needs a name');
    if (sources.has(source.name)) throw new Error(`source "${source.name}" is already registered`);
    sources.set(source.name, resilient(source, { logger }));
    return source;
  }

  async function health() {
    const report = {};
    for (const [name, source] of sources) {
      report[name] = await source.health().catch((err) => ({ status: 'down', detail: String(err.message) }));
    }
    await bus.emit(EVENTS.SOURCE_HEALTH, report);
    return report;
  }

  /** Poll every pull source once and ingest whatever comes back. */
  async function runOnce() {
    const results = [];
    for (const [name, source] of sources) {
      if (source.mode !== 'pull' || !source.poll) continue;
      const events = await source.poll();
      if (events.length) logger.info?.('source produced events', { source: name, count: events.length });
      results.push(...(await ingest(events)));
    }
    return results;
  }

  /**
   * Start scheduled polling. Each source sets its own cadence — the device rig
   * paces itself irregularly on purpose (see sources/device-bridge.js), while an
   * API poll is a plain interval.
   * @param {{intervalMs?: number}} [opts]
   */
  async function start(opts = {}) {
    if (running) return;
    running = true;
    for (const [name, source] of sources) {
      await source.start?.({ ingestor: api, bus, logger });
      if (source.mode !== 'pull') continue;

      const schedule = () => {
        const delay = typeof source.nextDelay === 'function' ? source.nextDelay() : opts.intervalMs ?? 60_000;
        const timer = setTimeout(async () => {
          try {
            await ingest(await source.poll());
          } catch (err) {
            logger.error?.('scheduled poll failed', { source: name, error: String(err.message) });
          }
          if (running) schedule();
        }, delay);
        timer.unref?.();
        timers.set(name, timer);
      };
      schedule();
    }
    logger.info?.('ingestor started', { sources: [...sources.keys()] });
  }

  async function stop() {
    running = false;
    for (const timer of timers.values()) clearTimeout(timer);
    timers.clear();
    for (const source of sources.values()) await source.stop?.();
  }

  /**
   * Push path: hand a webhook payload to a named source and ingest the result.
   * @param {string} sourceName
   * @param {any} payload
   */
  async function push(sourceName, payload) {
    const source = sources.get(sourceName);
    if (!source?.push) throw new Error(`source "${sourceName}" does not accept pushed payloads`);
    return ingest(await source.push(payload));
  }

  // ------------------------------------------------------------- ingest ---

  /**
   * @param {import('./core/types.js').RawEvent[]} events
   * @returns {Promise<{lead: any, person: any, triage: any, routed: string}[]>}
   */
  async function ingest(events) {
    const results = [];
    for (const event of events ?? []) {
      try {
        const result = await ingestOne(event);
        if (result) results.push(result);
      } catch (err) {
        logger.error?.('failed to ingest event', { id: event?.id, error: String(err?.stack ?? err) });
        await bus.emit(EVENTS.ERROR, { source: 'ingest', event, error: err });
      }
    }
    return results;
  }

  /** @param {import('./core/types.js').RawEvent} event */
  async function ingestOne(event) {
    // Sources overlap on purpose — the API and the device can both see the same
    // DM — so the same message arriving twice is expected, not exceptional.
    if (!(await store.appendEvent(event))) {
      await bus.emit(EVENTS.EVENT_DUPLICATE, { event });
      return null;
    }
    await bus.emit(EVENTS.EVENT_INGESTED, { event });

    const { person, created } = await resolveActor(
      { findByIdentifier: store.findByIdentifier.bind(store), save: store.savePerson.bind(store) },
      event.actor,
      { source: event.source, observedAt: event.observedAt },
    );
    if (created) await bus.emit(EVENTS.PERSON_CREATED, { person, event });

    const lead = await upsertLead(person, event);
    const history = await store.listEvents({ threadId: lead.threadId });

    // Identity before words. A leasing manager asking about a unit reads exactly
    // like a renter asking about a unit, so the party check runs first and
    // short-circuits triage entirely — an industry message never enters the
    // renter funnel to be filtered out of later.
    const party = identifyParty(event);
    const inboundTexts = history.map((e) => ({ text: e.text ?? '' }));
    const decision = party ? industryDecision(party) : triage.classifyThread(inboundTexts);

    if (party) {
      lead.ext.party = { ...party, contact: party.contact?.id ?? null, node: party.node?.id ?? null };
      await bus.emit(EVENTS.INDUSTRY_MESSAGE, { lead, person, event, party });
    }
    lead.triage = decision;
    lead.state = 'triaged';
    await store.saveLead(lead);
    await bus.emit(EVENTS.LEAD_TRIAGED, { lead, person, triage: decision });

    // Contact details a person volunteers are strong identifiers and belong on
    // the person record immediately, whatever the disposition.
    const harvested = harvestIdentifiers(event, person);
    if (harvested.length) {
      const updated = addIdentifiers(person, harvested);
      await store.savePerson(updated);
      await suggestMerges(updated);
    }

    const routing = ROUTING[decision.disposition] ?? {};
    let routed = 'held';

    if (routing.handOffToReplyEngine && config.onHandoff) {
      const sheet = buildProspectSheet({ person, lead, events: history });
      try {
        await config.onHandoff({ lead, person, events: history, sheet });
        lead.state = 'handed_off';
        lead.handedOffAt = new Date().toISOString();
        await store.saveLead(lead);
        await bus.emit(EVENTS.LEAD_HANDED_OFF, { lead, person, sheet });
        routed = 'handed_off';
      } catch (err) {
        // A failing downstream must not lose the lead — it stays queued.
        logger.error?.('handoff failed; lead held', { lead: lead.id, error: String(err.message) });
        await bus.emit(EVENTS.LEAD_HELD, { lead, person, reason: `handoff failed: ${err.message}` });
      }
    } else if (routing.notifyOperator) {
      await bus.emit(EVENTS.LEAD_HELD, { lead, person, reason: decision.reasons[0] ?? decision.disposition });
      routed = 'operator';
    } else {
      routed = 'no_action';
    }

    if (routing.enrich) {
      const run = () => enrichPerson(person.id, { triage: decision, lead });
      if (config.enrichInline) await run();
      // Enrichment is slow and must never delay a reply, so by default it runs
      // after the turn and reports through the bus when it lands.
      else queueMicrotask(() => run().catch(() => {}));
    }

    return { lead, person, triage: decision, routed };
  }

  /**
   * Ask the directory whether this sender is industry rather than a customer.
   * Returns null when there is no directory wired up, or when the sender is not
   * recognized — the common case.
   * @param {import('./core/types.js').RawEvent} event
   */
  function identifyParty(event) {
    if (!config.identifyParty) return null;
    try {
      const result = config.identifyParty({
        platform: event.actor.platform,
        platformId: event.actor.platformId,
        handle: event.actor.handle,
        email: extractEmail(event.text),
        phone: extractPhone(event.text),
      });
      return result?.party === 'industry' ? result : null;
    } catch (err) {
      // A directory that is down must not stop the inbox. Treating an unknown
      // sender as a customer is the safe default: worst case, a manager gets a
      // polite qualifying question, which a human then corrects.
      logger.warn?.('party lookup failed; treating sender as a customer', { error: String(err.message) });
      return null;
    }
  }

  /**
   * A confirmed industry contact is routed, not classified. A probable one —
   * matched only on an email domain — still goes to a person, because the
   * company being recognized does not mean this individual is staff.
   * @param {{confidence: string, reason: string, contact?: object, node?: object}} party
   */
  function industryDecision(party) {
    const certain = party.confidence === 'certain';
    return {
      disposition: DISPOSITIONS.INDUSTRY_CONTACT,
      reasons: [party.reason],
      signals: [{ kind: 'known_industry_contact', evidence: party.reason, source: 'directory' }],
      missing: [],
      confidence: certain ? 0.95 : 0.5,
      needsHuman: !certain,
    };
  }

  function extractEmail(text) {
    return String(text ?? '').match(/\b[\w.+-]+@[\w-]+\.[a-z]{2,}\b/i)?.[0] ?? undefined;
  }
  function extractPhone(text) {
    return String(text ?? '').match(/(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/)?.[0] ?? undefined;
  }

  /** @param {import('./core/types.js').Person} person @param {import('./core/types.js').RawEvent} event */
  async function upsertLead(person, event) {
    const threadId = event.threadId ?? `${event.source}:${event.actor.platformId}`;
    const existing = await store.findLeadByThread(threadId);
    const at = event.occurredAt ?? event.observedAt;

    if (existing) {
      existing.lastSeenAt = at;
      existing.eventIds = [...new Set([...existing.eventIds, event.id])];
      await store.saveLead(existing);
      await bus.emit(EVENTS.LEAD_UPDATED, { lead: existing, person, event });
      return existing;
    }

    /** @type {import('./core/types.js').Lead} */
    const lead = {
      id: `l_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`,
      personId: person.id,
      source: event.source,
      threadId,
      firstSeenAt: at,
      lastSeenAt: at,
      eventIds: [event.id],
      state: 'new',
      ext: {},
    };
    await store.saveLead(lead);
    await bus.emit(EVENTS.LEAD_OPENED, { lead, person, event });
    return lead;
  }

  /**
   * Pull phone numbers and emails out of what someone actually typed. These are
   * the identifiers that let a person be recognized across a handle change.
   */
  function harvestIdentifiers(event, person) {
    const text = String(event.text ?? '');
    const meta = { source: event.source, observedAt: event.observedAt };
    const found = [];

    const email = text.match(/\b[\w.+-]+@[\w-]+\.[a-z]{2,}\b/i)?.[0];
    if (email) found.push(makeIdentifier('email', email, meta));

    const phone = text.match(/(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/)?.[0];
    if (phone) found.push(makeIdentifier('phone', phone, meta));

    const linkedin = text.match(/linkedin\.com\/in\/[a-z0-9\-_%]+/i)?.[0];
    if (linkedin) found.push(makeIdentifier('linkedin_url', linkedin, meta));

    const known = new Set(person.identifiers.map((i) => `${i.kind}:${i.value}`));
    return found.filter(Boolean).filter((i) => !known.has(`${i.kind}:${i.value}`));
  }

  /**
   * When a new strong identifier appears, another record may be the same human.
   * Suggested, never merged automatically — see identity/identity.js for why.
   */
  async function suggestMerges(person) {
    const others = await store.listPeople({ limit: 500 });
    for (const other of others) {
      if (other.id === person.id) continue;
      const comparison = compareIdentities(person, other);
      if (comparison.suggest) {
        await bus.emit(EVENTS.PERSON_MERGE_SUGGESTED, { a: person, b: other, reason: comparison.reason });
      }
    }
  }

  // ---------------------------------------------------------- enrichment --

  /**
   * @param {string} personId
   * @param {{triage?: any, lead?: any, force?: boolean}} [ctx]
   */
  async function enrichPerson(personId, ctx = {}) {
    const person = await store.getPerson(personId);
    if (!person) return null;

    const { facts, ran, skipped } = await enricher.enrich(person, ctx);
    if (!facts.length) {
      await bus.emit(EVENTS.ENRICHED, { person, facts: [], ran, skipped });
      return { person, facts, ran, skipped };
    }

    const updated = addFacts(person, facts);
    await store.savePerson(updated);
    await bus.emit(EVENTS.ENRICHED, { person: updated, facts, ran, skipped });
    return { person: updated, facts, ran, skipped };
  }

  /** The full sheet for one person: identity, facts, provenance, gaps. */
  async function prospectSheet(personId) {
    const person = await store.getPerson(personId);
    if (!person) return null;
    const leads = (await store.listLeads({})).filter((l) => l.personId === personId);
    const lead = leads.sort((a, b) => String(b.lastSeenAt).localeCompare(String(a.lastSeenAt)))[0];
    const events = await store.listEvents({ personId });
    return buildProspectSheet({ person, lead, events });
  }

  const api = {
    addSource,
    ingest,
    push,
    runOnce,
    start,
    stop,
    health,
    enrichPerson,
    prospectSheet,
    triage,
    enricher,
    store,
    bus,
    logger,
    sources: () => [...sources.keys()],
    stats: () => store.stats(),
  };
  return api;
}

function nullLogger() {
  const noop = () => {};
  return { debug: noop, info: noop, warn: noop, error: noop, child: () => nullLogger() };
}

export default createIngestor;
