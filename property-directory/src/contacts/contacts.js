/**
 * Contacts and their assignments.
 *
 * The one thing that makes this different from a normal contact list: **staff
 * turnover in this industry is brutal.** A leasing agent is at one property for
 * eight months, then another. If assignment were a field on the contact, then
 * updating it would silently rewrite history, and "who did I work with at The
 * Maple last spring" would return the wrong person forever.
 *
 * So an assignment is its own dated record. A contact moving properties ends one
 * assignment and starts another. Nothing is destroyed, and both questions —
 * "who is there now" and "who was there then" — stay answerable.
 */
import { normalizeTitle, isOffice, byAuthority, frontDesk, chainAbove } from './titles.js';

export { normalizeTitle, isOffice, byAuthority, frontDesk, chainAbove };

/**
 * @param {{firstName?: string, lastName?: string, displayName?: string, rawTitle?: string,
 *          channels?: {kind: string, value: string, primary?: boolean}[], source?: object,
 *          notes?: string, id?: string}} init
 * @returns {import('../core/types.js').Contact}
 */
export function createContact(init) {
  const displayName =
    init.displayName?.trim() ||
    [init.firstName, init.lastName].filter(Boolean).join(' ').trim();
  if (!displayName) throw new Error('a contact needs a name');

  const title = normalizeTitle(init.rawTitle ?? '');
  const now = new Date().toISOString();
  const channels = normalizeChannels(init.channels);

  const contact = {
    id: init.id ?? `c_${randomId()}`,
    firstName: init.firstName?.trim(),
    lastName: init.lastName?.trim(),
    displayName,
    rawTitle: init.rawTitle?.trim() || undefined,
    role: title.role,
    level: title.level,
    channels,
    sources: init.source ? [init.source] : [],
    status: 'active',
    notes: init.notes,
    createdAt: now,
    updatedAt: now,
  };

  // A record with no human name and an office-shaped email is the office, not a
  // person — even when the CRM gave it a job title.
  if (contact.role === 'unknown' && isOffice(contact)) {
    contact.role = 'office';
    contact.level = 4;
  }
  return contact;
}

/**
 * Channel normalization. Kept local rather than shared with the other modules —
 * this one has to run standalone, and one small duplicated function is a better
 * trade than a dependency between containers.
 * @param {{kind: string, value: string, primary?: boolean}[]} [channels]
 */
export function normalizeChannels(channels = []) {
  /** @type {import('../core/types.js').ContactChannel[]} */
  const out = [];
  const seen = new Set();

  for (const channel of channels) {
    const value = normalizeChannelValue(channel.kind, channel.value);
    if (!value) continue;
    const key = `${channel.kind}:${value}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ kind: channel.kind, value, ...(channel.primary ? { primary: true } : {}) });
  }
  return out;
}

/** @param {string} kind @param {string} raw */
export function normalizeChannelValue(kind, raw) {
  const value = String(raw ?? '').trim();
  if (!value) return null;

  if (kind === 'email') {
    const email = value.toLowerCase();
    return /^[^@\s]+@[^@\s.]+\.[^@\s]{2,}$/.test(email) ? email : null;
  }
  if (kind === 'phone') {
    const digits = value.replace(/[^\d]/g, '');
    // A leasing office line often carries an extension; keep the base number.
    if (digits.length === 10) return `+1${digits}`;
    if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
    if (digits.length > 11) return `+1${digits.slice(digits.startsWith('1') ? 1 : 0, digits.startsWith('1') ? 11 : 10)}`;
    return null;
  }
  if (kind === 'instagram') {
    const handle = value.toLowerCase().replace(/^@+/, '').replace(/^https?:\/\/(www\.)?instagram\.com\//, '').replace(/\/.*$/, '');
    return /^[a-z0-9._]{1,30}$/.test(handle) ? handle : null;
  }
  return value;
}

/**
 * The roster: contacts plus the assignments that place them.
 * @param {{contacts?: Map<string, any>, assignments?: Map<string, any>}} [state]
 */
export function createRoster(state = {}) {
  const contacts = state.contacts ?? new Map();
  const assignments = state.assignments ?? new Map();

  function addContact(contact) {
    contacts.set(contact.id, contact);
    return contact;
  }

  function getContact(id) {
    return contacts.get(id) ?? null;
  }

  /**
   * Place a contact at a node.
   *
   * Assigning someone who is already placed elsewhere ends the old assignment
   * rather than deleting it — that is the turnover case, and it is the norm.
   *
   * @param {string} contactId
   * @param {string} nodeId
   * @param {{startedAt?: string, role?: string, level?: number|null, source?: object, keepOthers?: boolean}} [opts]
   */
  function assign(contactId, nodeId, opts = {}) {
    const contact = contacts.get(contactId);
    if (!contact) throw new Error(`contact ${contactId} not found`);

    const startedAt = opts.startedAt ?? new Date().toISOString();

    const existing = current(contactId);
    for (const a of existing) {
      if (a.nodeId === nodeId) return a; // already there; nothing to record
      if (!opts.keepOthers) end(a.id, startedAt);
    }

    const assignment = {
      id: `a_${randomId()}`,
      contactId,
      nodeId,
      role: opts.role ?? contact.role,
      level: opts.level ?? contact.level,
      startedAt,
      endedAt: null,
      source: opts.source,
    };
    assignments.set(assignment.id, assignment);
    return assignment;
  }

  /** @param {string} assignmentId */
  function end(assignmentId, endedAt = new Date().toISOString()) {
    const assignment = assignments.get(assignmentId);
    if (!assignment) return null;
    assignment.endedAt = endedAt;
    return assignment;
  }

  /** Current assignments for a contact. */
  function current(contactId) {
    return [...assignments.values()].filter((a) => a.contactId === contactId && !a.endedAt);
  }

  /**
   * Contacts at a node.
   * @param {string} nodeId
   * @param {{includeDeparted?: boolean, asOf?: string}} [opts]
   */
  function at(nodeId, opts = {}) {
    return [...assignments.values()]
      .filter((a) => a.nodeId === nodeId)
      .filter((a) => {
        if (opts.asOf) {
          return a.startedAt <= opts.asOf && (!a.endedAt || a.endedAt > opts.asOf);
        }
        return opts.includeDeparted ? true : !a.endedAt;
      })
      .map((a) => {
        const contact = contacts.get(a.contactId);
        if (!contact) return null;
        // The assignment's role wins: the same person can be a leasing agent at
        // one property and the manager at another.
        return { ...contact, role: a.role ?? contact.role, level: a.level ?? contact.level, assignment: a };
      })
      .filter(Boolean);
  }

  /**
   * The default view: the office and the manager for a node. Everything else is
   * counted, not listed.
   * @param {string} nodeId
   */
  function frontDeskAt(nodeId) {
    return frontDesk(byAuthority(at(nodeId)));
  }

  /** Mark someone as gone without deleting them. */
  function markDeparted(contactId, at = new Date().toISOString()) {
    const contact = contacts.get(contactId);
    if (!contact) return null;
    contact.status = 'departed';
    contact.updatedAt = at;
    for (const a of current(contactId)) end(a.id, at);
    return contact;
  }

  /**
   * Titles the taxonomy could not place. Surfaced rather than guessed at — this
   * is the review list that keeps the ladder honest.
   */
  function unrecognizedTitles() {
    const seen = new Map();
    for (const contact of contacts.values()) {
      if (contact.role !== 'unknown' || !contact.rawTitle) continue;
      const key = contact.rawTitle.toLowerCase();
      seen.set(key, { rawTitle: contact.rawTitle, count: (seen.get(key)?.count ?? 0) + 1 });
    }
    return [...seen.values()].sort((a, b) => b.count - a.count);
  }

  return {
    contacts,
    assignments,
    addContact,
    getContact,
    assign,
    end,
    current,
    at,
    frontDeskAt,
    markDeparted,
    unrecognizedTitles,
    allContacts: () => [...contacts.values()],
    allAssignments: () => [...assignments.values()],
  };
}

function randomId() {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}
