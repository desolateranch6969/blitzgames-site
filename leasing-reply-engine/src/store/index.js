/**
 * Conversation storage.
 *
 * The interface is four methods. Everything the engine needs from a database it
 * gets through them, so the in-memory store used by tests, the JSON file store
 * used on a laptop, and whatever Postgres-backed store the management portal
 * eventually brings are interchangeable.
 *
 *   get(threadId)                  -> Conversation | null
 *   save(conversation)             -> Conversation
 *   list({status, stage, limit})   -> Conversation[]
 *   seen(messageId)                -> boolean   (webhook dedupe)
 *
 * A module that provides a `store` capability replaces the default entirely.
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';

export function createMemoryStore() {
  /** @type {Map<string, import('../core/types.js').Conversation>} */
  const conversations = new Map();
  /** @type {Set<string>} */
  const seenIds = new Set();

  return {
    name: 'memory',
    async get(threadId) {
      const found = conversations.get(threadId);
      return found ? structuredClone(found) : null;
    },
    async save(conversation) {
      conversation.updatedAt = Date.now();
      conversations.set(conversation.threadId, structuredClone(conversation));
      return conversation;
    },
    async list({ status, stage, limit = 100 } = {}) {
      return [...conversations.values()]
        .filter((c) => (status ? c.status === status : true))
        .filter((c) => (stage ? c.stage === stage : true))
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, limit)
        .map((c) => structuredClone(c));
    },
    async seen(messageId) {
      if (!messageId) return false;
      if (seenIds.has(messageId)) return true;
      seenIds.add(messageId);
      // Bounded: webhook replays arrive within seconds, not days.
      if (seenIds.size > 5000) {
        for (const id of [...seenIds].slice(0, 1000)) seenIds.delete(id);
      }
      return false;
    },
    async clear() {
      conversations.clear();
      seenIds.clear();
    },
  };
}

/**
 * Durable single-file store. Fine for one operator on one machine, which is
 * exactly where this module starts. Writes are synchronous and whole-file on
 * purpose: correctness over throughput until the portal brings a real database.
 * @param {{path: string}} opts
 */
export function createFileStore({ path }) {
  /** @type {{conversations: Record<string, any>, seen: string[]}} */
  let state = { conversations: {}, seen: [] };

  if (existsSync(path)) {
    try {
      state = JSON.parse(readFileSync(path, 'utf8'));
      state.conversations ??= {};
      state.seen ??= [];
    } catch {
      // A corrupt file must not take the inbox down; start fresh and keep the
      // old file beside it for inspection.
      try {
        writeFileSync(`${path}.corrupt-${Date.now()}`, readFileSync(path));
      } catch { /* best effort */ }
      state = { conversations: {}, seen: [] };
    }
  }

  function flush() {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(state, null, 2));
  }

  const seenSet = new Set(state.seen);

  return {
    name: 'file',
    async get(threadId) {
      const found = state.conversations[threadId];
      return found ? structuredClone(found) : null;
    },
    async save(conversation) {
      conversation.updatedAt = Date.now();
      state.conversations[conversation.threadId] = structuredClone(conversation);
      flush();
      return conversation;
    },
    async list({ status, stage, limit = 100 } = {}) {
      return Object.values(state.conversations)
        .filter((c) => (status ? c.status === status : true))
        .filter((c) => (stage ? c.stage === stage : true))
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, limit)
        .map((c) => structuredClone(c));
    },
    async seen(messageId) {
      if (!messageId) return false;
      if (seenSet.has(messageId)) return true;
      seenSet.add(messageId);
      state.seen = [...seenSet].slice(-5000);
      flush();
      return false;
    },
    async clear() {
      state = { conversations: {}, seen: [] };
      seenSet.clear();
      flush();
    },
  };
}

/**
 * @param {{store?: string, storePath?: string}} config
 */
export function createStoreFromConfig(config = {}) {
  if (config.store === 'file') {
    return createFileStore({ path: config.storePath ?? './data/conversations.json' });
  }
  return createMemoryStore();
}
