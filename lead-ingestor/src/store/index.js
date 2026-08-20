/**
 * Storage for raw events, people, and leads.
 *
 * The interface is what the portal will eventually back with Postgres. Two
 * design points that are not obvious:
 *
 *   - **Raw events are append-only.** They are the audit trail. Every triage
 *     decision and every enriched fact can be re-derived from them, which means
 *     a bad rule can be fixed and re-run over history instead of leaving wrong
 *     classifications baked into the record forever.
 *
 *   - **Identifiers are indexed separately from people.** Identity resolution
 *     asks "who owns this handle" thousands of times; scanning every person for
 *     it is the difference between instant and unusable once there are a few
 *     thousand records.
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { identifierKey } from '../identity/handles.js';

export function createMemoryStore() {
  /** @type {Map<string, import('../core/types.js').RawEvent>} */
  const events = new Map();
  /** @type {Map<string, import('../core/types.js').Person>} */
  const people = new Map();
  /** @type {Map<string, import('../core/types.js').Lead>} */
  const leads = new Map();
  /** @type {Map<string, string>} identifier key -> person id */
  const identifierIndex = new Map();
  /** @type {Map<string, string>} */
  const cursors = new Map();

  return {
    name: 'memory',

    // --- raw events -------------------------------------------------------
    async hasEvent(id) {
      return events.has(id);
    },
    async appendEvent(event) {
      if (events.has(event.id)) return false;
      events.set(event.id, structuredClone(event));
      return true;
    },
    async listEvents({ threadId, personId, limit = 500 } = {}) {
      let all = [...events.values()];
      if (threadId) all = all.filter((e) => e.threadId === threadId);
      if (personId) {
        const ids = new Set([...leads.values()].filter((l) => l.personId === personId).flatMap((l) => l.eventIds));
        all = all.filter((e) => ids.has(e.id));
      }
      return all
        .sort((a, b) => String(a.occurredAt ?? a.observedAt).localeCompare(String(b.occurredAt ?? b.observedAt)))
        .slice(-limit)
        .map((e) => structuredClone(e));
    },

    // --- people -----------------------------------------------------------
    async getPerson(id) {
      const found = people.get(id);
      return found ? structuredClone(found) : null;
    },
    async findByIdentifier(key) {
      const id = identifierIndex.get(key);
      return id ? this.getPerson(id) : null;
    },
    async savePerson(person) {
      people.set(person.id, structuredClone(person));
      for (const identifier of person.identifiers ?? []) {
        identifierIndex.set(identifierKey(identifier), person.id);
      }
      return person;
    },
    async listPeople({ limit = 200 } = {}) {
      return [...people.values()]
        .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
        .slice(0, limit)
        .map((p) => structuredClone(p));
    },

    // --- leads ------------------------------------------------------------
    async getLead(id) {
      const found = leads.get(id);
      return found ? structuredClone(found) : null;
    },
    async findLeadByThread(threadId) {
      const found = [...leads.values()].find((l) => l.threadId === threadId);
      return found ? structuredClone(found) : null;
    },
    async saveLead(lead) {
      leads.set(lead.id, structuredClone(lead));
      return lead;
    },
    async listLeads({ disposition, state, limit = 200 } = {}) {
      return [...leads.values()]
        .filter((l) => (disposition ? l.triage?.disposition === disposition : true))
        .filter((l) => (state ? l.state === state : true))
        .sort((a, b) => String(b.lastSeenAt).localeCompare(String(a.lastSeenAt)))
        .slice(0, limit)
        .map((l) => structuredClone(l));
    },

    // --- source cursors ---------------------------------------------------
    async getCursor(name) {
      return cursors.get(name) ?? null;
    },
    async setCursor(name, value) {
      cursors.set(name, value);
    },

    async stats() {
      const byDisposition = {};
      for (const lead of leads.values()) {
        const key = lead.triage?.disposition ?? 'untriaged';
        byDisposition[key] = (byDisposition[key] ?? 0) + 1;
      }
      return { events: events.size, people: people.size, leads: leads.size, byDisposition };
    },

    async clear() {
      events.clear();
      people.clear();
      leads.clear();
      identifierIndex.clear();
      cursors.clear();
    },

    _dump: () => ({
      events: [...events.values()],
      people: [...people.values()],
      leads: [...leads.values()],
      cursors: [...cursors.entries()],
    }),
    _load: (data) => {
      for (const e of data.events ?? []) events.set(e.id, e);
      for (const p of data.people ?? []) {
        people.set(p.id, p);
        for (const identifier of p.identifiers ?? []) identifierIndex.set(identifierKey(identifier), p.id);
      }
      for (const l of data.leads ?? []) leads.set(l.id, l);
      for (const [k, v] of data.cursors ?? []) cursors.set(k, v);
    },
  };
}

/**
 * File-backed store. Same interface, flushed to disk on write.
 *
 * Suitable for one operator on one Mac, which is where this starts. It holds the
 * whole dataset in memory and rewrites the file on change — fine for tens of
 * thousands of records, and the point at which that stops being fine is exactly
 * the point at which the portal should bring a real database.
 *
 * @param {{path: string, flushMs?: number}} config
 */
export function createFileStore({ path, flushMs = 250 }) {
  const memory = createMemoryStore();

  if (existsSync(path)) {
    try {
      memory._load(JSON.parse(readFileSync(path, 'utf8')));
    } catch {
      try {
        writeFileSync(`${path}.corrupt-${Date.now()}`, readFileSync(path));
      } catch { /* best effort */ }
    }
  }

  let pending = null;
  function flush() {
    if (pending) return;
    pending = setTimeout(() => {
      pending = null;
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, JSON.stringify(memory._dump(), null, 2));
    }, flushMs);
    pending.unref?.();
  }

  const writes = ['appendEvent', 'savePerson', 'saveLead', 'setCursor', 'clear'];
  /** @type {any} */
  const wrapped = { ...memory, name: 'file' };
  for (const method of writes) {
    wrapped[method] = async (...args) => {
      const result = await memory[method](...args);
      flush();
      return result;
    };
  }
  wrapped.flushNow = () => {
    if (pending) clearTimeout(pending);
    pending = null;
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(memory._dump(), null, 2));
  };
  return wrapped;
}

/** @param {{store?: string, storePath?: string}} config */
export function createStoreFromConfig(config = {}) {
  return config.store === 'file'
    ? createFileStore({ path: config.storePath ?? './data/leads.json' })
    : createMemoryStore();
}
