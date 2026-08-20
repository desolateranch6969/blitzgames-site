/**
 * Instagram data-export source ("Download Your Information").
 *
 * This is the backfill path, and it is the only collection method that needs no
 * credentials, breaks no terms, and cannot get an account restricted: Meta hands
 * the account owner their own data on request. Everything already in the inbox
 * — years of it — comes in through here.
 *
 * It does two jobs from one read:
 *   1. Historical RawEvents, so triage and enrichment have a corpus to work on
 *      before a single new DM arrives.
 *   2. A voice corpus (his side of every conversation) for the reply engine's
 *      `learn` command.
 *
 * ## Export layout
 *
 * The unzipped export looks like this. The exact top-level folder name varies by
 * export date, so the reader walks for `messages/inbox` rather than assuming it.
 *
 *   instagram-<handle>-<date>/
 *     your_instagram_activity/
 *       messages/
 *         inbox/
 *           janedoe_17842…/
 *             message_1.json      <- newest chunk
 *             message_2.json      <- older chunk, same thread
 *
 * Two quirks that will bite anyone who writes this from scratch:
 *   - Messages inside each file are newest-first, and a long thread is split
 *     across numbered files. Chronological order needs every chunk concatenated
 *     and sorted by timestamp.
 *   - Text is UTF-8 bytes stored as Latin-1 escapes, so "don't" arrives as
 *     "donâ€™t" unless it is re-decoded.
 */
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import { makeRawEvent } from './source.js';

/**
 * @typedef {Object} ArchiveThread
 * @property {string} threadId
 * @property {string} title
 * @property {string[]} participants
 * @property {boolean} isGroup
 * @property {{sender: string, text: string, at: number, kind: string}[]} messages
 */

/**
 * Find every `messages/inbox` directory under a path, however the export is
 * nested or wherever it was unzipped.
 * @param {string} root
 * @returns {string[]}
 */
export function findInboxDirs(root, depth = 0) {
  if (depth > 6 || !existsSync(root)) return [];
  /** @type {string[]} */
  const found = [];
  let entries = [];
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return found;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const full = join(root, entry.name);
    if (entry.name === 'inbox' && basename(root) === 'messages') {
      found.push(full);
      continue;
    }
    found.push(...findInboxDirs(full, depth + 1));
  }
  return found;
}

/**
 * Read every thread in an export.
 * @param {string} root  The unzipped export folder (or anything above it).
 * @param {{includeGroups?: boolean}} [opts]
 * @returns {ArchiveThread[]}
 */
export function readArchive(root, opts = {}) {
  const inboxes = findInboxDirs(root);
  if (!inboxes.length) {
    throw new Error(
      `no "messages/inbox" folder found under ${root}. Point this at the unzipped export folder ` +
        `(the one containing "your_instagram_activity"), and make sure the export was requested as JSON, not HTML.`,
    );
  }

  /** @type {ArchiveThread[]} */
  const threads = [];
  for (const inbox of inboxes) {
    for (const entry of readdirSync(inbox, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const thread = readThreadDir(join(inbox, entry.name));
      if (!thread) continue;
      if (thread.isGroup && !opts.includeGroups) continue;
      threads.push(thread);
    }
  }
  return threads;
}

/** @param {string} dir */
export function readThreadDir(dir) {
  const files = readdirSync(dir)
    .filter((f) => /^message_\d+\.json$/.test(f))
    .sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0]));
  if (!files.length) return null;

  /** @type {any[]} */
  let raw = [];
  let title = '';
  /** @type {Set<string>} */
  const participants = new Set();

  for (const file of files) {
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(join(dir, file), 'utf8'));
    } catch {
      continue; // one unreadable chunk should not lose the thread
    }
    title ||= decodeExportText(parsed.title ?? '');
    for (const p of parsed.participants ?? []) participants.add(decodeExportText(p.name ?? ''));
    raw.push(...(parsed.messages ?? []));
  }

  const messages = raw
    .map(normalizeArchiveMessage)
    .filter(Boolean)
    .sort((a, b) => a.at - b.at);

  return {
    threadId: basename(dir),
    title,
    participants: [...participants].filter(Boolean),
    isGroup: participants.size > 2,
    messages,
  };
}

/** @param {any} message */
function normalizeArchiveMessage(message) {
  if (message?.is_unsent) return null;
  const sender = decodeExportText(message.sender_name ?? '');
  const at = Number(message.timestamp_ms ?? 0);
  if (!sender || !at) return null;

  const text = decodeExportText(message.content ?? '');
  let kind = 'text';
  if (!text) {
    if (message.photos?.length) kind = 'photo';
    else if (message.videos?.length) kind = 'video';
    else if (message.audio_files?.length) kind = 'audio';
    else if (message.share) kind = 'share';
    else if (message.call_duration != null) kind = 'call';
    else return null;
  }

  return {
    sender,
    at,
    kind,
    text: text || `[${kind}]`,
    ...(message.share?.link ? { link: decodeExportText(message.share.link) } : {}),
  };
}

/**
 * Meta writes UTF-8 bytes into JSON as Latin-1 escapes. Re-decoding fixes the
 * mojibake; if a string was already clean, this is a no-op.
 * @param {string} text
 */
export function decodeExportText(text) {
  if (!text) return '';
  try {
    const decoded = Buffer.from(text, 'latin1').toString('utf8');
    // If re-decoding produced replacement characters, the original was fine.
    return decoded.includes('�') ? text : decoded;
  } catch {
    return text;
  }
}

/**
 * Turn an archive into RawEvents for the pipeline.
 *
 * Only the other party's messages become events — his own outgoing messages are
 * context, not leads. Identity is thin here by design: an export gives display
 * names, not platform ids, so the person record is keyed on the thread folder
 * (which embeds the account's numeric id) and marked as archive-derived.
 *
 * @param {ArchiveThread[]} threads
 * @param {{meName: string, since?: string}} opts
 * @returns {import('../core/types.js').RawEvent[]}
 */
export function archiveToEvents(threads, { meName, since }) {
  const cutoff = since ? Date.parse(since) : 0;
  /** @type {import('../core/types.js').RawEvent[]} */
  const events = [];

  for (const thread of threads) {
    const handle = handleFromThreadId(thread.threadId);
    for (const [index, message] of thread.messages.entries()) {
      if (message.sender === meName) continue;
      if (message.at < cutoff) continue;
      events.push(
        makeRawEvent({
          source: 'archive',
          kind: 'message',
          platform: 'instagram',
          platformId: thread.threadId,
          handle,
          displayName: message.sender,
          id: `archive:${thread.threadId}:${message.at}:${index}`,
          threadId: `ig:${thread.threadId}`,
          text: message.text,
          occurredAt: message.at,
          payload: { kind: message.kind, threadTitle: thread.title, fromArchive: true },
        }),
      );
    }
  }
  return events.sort((a, b) => String(a.occurredAt).localeCompare(String(b.occurredAt)));
}

/**
 * Export folder names are `<handle><numeric id>` with punctuation stripped, so
 * the handle can be recovered but never trusted as an identifier. It is recorded
 * as weak evidence and a human confirms it in the portal.
 * @param {string} threadId
 */
export function handleFromThreadId(threadId) {
  const match = String(threadId).match(/^([a-z0-9._]+?)_?\d{6,}$/i);
  return match ? match[1].toLowerCase() : undefined;
}

/**
 * Build a voice corpus for the reply engine's `learn` command: his replies,
 * paired with the message he was replying to.
 *
 * @param {ArchiveThread[]} threads
 * @param {{meName: string, maxGapMs?: number}} opts
 * @returns {{lead: string|undefined, agent: string}[]}
 */
export function archiveToVoiceCorpus(threads, { meName, maxGapMs = 6 * 3600_000 }) {
  /** @type {{lead: string|undefined, agent: string}[]} */
  const pairs = [];

  for (const thread of threads) {
    let lastInbound = null;
    for (const message of thread.messages) {
      if (message.sender !== meName) {
        lastInbound = message;
        continue;
      }
      if (message.kind !== 'text') continue;
      const withinWindow = lastInbound && message.at - lastInbound.at <= maxGapMs;
      pairs.push({ lead: withinWindow ? lastInbound.text : undefined, agent: message.text });
      // Only the first reply is paired; the rest of a burst are follow-on
      // bubbles, not answers to the same prompt.
      lastInbound = null;
    }
  }
  return pairs;
}

/**
 * The archive as a Source. It is a one-shot pull: everything, once.
 * @param {{path: string, meName: string, since?: string, includeGroups?: boolean}} config
 * @returns {import('./source.js').Source}
 */
export function createArchiveSource(config) {
  let drained = false;
  let lastCount = 0;

  return {
    name: 'archive',
    mode: 'pull',

    async poll() {
      if (drained) return [];
      const threads = readArchive(config.path, { includeGroups: config.includeGroups });
      const events = archiveToEvents(threads, { meName: config.meName, since: config.since });
      drained = true;
      lastCount = events.length;
      return events;
    },

    async health() {
      if (!existsSync(config.path)) {
        return { status: 'unconfigured', detail: `export path not found: ${config.path}` };
      }
      try {
        const inboxes = findInboxDirs(config.path);
        return {
          status: inboxes.length ? 'ok' : 'down',
          detail: inboxes.length
            ? `${inboxes.length} inbox folder(s), ${drained ? `${lastCount} events ingested` : 'not yet read'}`
            : 'no messages/inbox folder found — was the export requested as JSON?',
        };
      } catch (err) {
        return { status: 'down', detail: String(err.message) };
      }
    },
  };
}

/**
 * Summarize an export, and work out which display name is the account owner.
 *
 * Getting the owner right matters more than anything else in this file: it
 * decides which messages are leads and which are his own replies, and a wrong
 * guess inverts the entire import.
 *
 * The reliable signal is **participation, not volume**. The owner is a
 * participant in every single thread — that is what a thread is — while the
 * chattiest single person might be one talkative lead. So candidates are ranked
 * by how many threads they appear in, and the result carries the evidence so a
 * human can sanity-check it instead of trusting a guess.
 *
 * @param {string} path
 */
export function describeArchive(path) {
  const inboxes = findInboxDirs(path);
  const threads = inboxes.length ? readArchive(path, { includeGroups: true }) : [];

  /** @type {Map<string, {threads: number, messages: number}>} */
  const people = new Map();
  const bump = (name, key) => {
    if (!name) return;
    const entry = people.get(name) ?? { threads: 0, messages: 0 };
    entry[key]++;
    people.set(name, entry);
  };

  for (const thread of threads) {
    for (const participant of thread.participants) bump(participant, 'threads');
    for (const message of thread.messages) bump(message.sender, 'messages');
  }

  const candidates = [...people.entries()]
    .map(([name, counts]) => ({ name, ...counts, threadShare: threads.length ? counts.threads / threads.length : 0 }))
    .sort((a, b) => b.threads - a.threads || b.messages - a.messages);

  const owner = candidates[0] ?? null;
  const runnerUp = candidates[1] ?? null;

  return {
    inboxes,
    threadCount: threads.length,
    groupThreads: threads.filter((t) => t.isGroup).length,
    messageCount: [...people.values()].reduce((total, p) => total + p.messages, 0),
    likelyOwner: owner
      ? {
          name: owner.name,
          inThreads: owner.threads,
          ofThreads: threads.length,
          messages: owner.messages,
          // Unambiguous only when nobody else comes close to being everywhere.
          certain: owner.threadShare > 0.9 && (!runnerUp || runnerUp.threads < owner.threads),
        }
      : null,
    candidates: candidates.slice(0, 5),
    topSenders: candidates
      .slice()
      .sort((a, b) => b.messages - a.messages)
      .slice(0, 5)
      .map((c) => [c.name, c.messages]),
    dateRange: dateRangeOf(threads),
  };
}

function dateRangeOf(threads) {
  const times = threads.flatMap((t) => t.messages.map((m) => m.at)).filter(Boolean);
  if (!times.length) return null;
  return {
    from: new Date(Math.min(...times)).toISOString().slice(0, 10),
    to: new Date(Math.max(...times)).toISOString().slice(0, 10),
  };
}

/** Statistics without loading a whole export into memory twice. */
export function statArchive(path) {
  return { exists: existsSync(path), size: existsSync(path) ? statSync(path).size : 0 };
}
