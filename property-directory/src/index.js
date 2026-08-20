/**
 * Property directory — module 3.
 *
 * Holds the apartment communities, the hierarchy above them, and the people who
 * work at them. Two jobs:
 *
 *   1. **Answer "who do I call about this property."** The surfaced answer is
 *      deliberately small — the leasing office and the manager. The full ladder
 *      and the full hierarchy sit underneath, available but not in the way.
 *
 *   2. **Keep industry contacts out of the renter funnel.** A property manager's
 *      DM must never be qualified as a lead. `partyResolver()` is handed to the
 *      lead ingestor, which checks it before triage runs.
 *
 * Standalone like the others: no imports from module 1 or 2, no database, no
 * network. It is a container with rules about its own contents.
 */
import { createTree, createNode, naturalKey } from './tree/tree.js';
import { createRoster, createContact, frontDesk, byAuthority, chainAbove } from './contacts/contacts.js';
import { normalizeTitle, ROLES } from './contacts/titles.js';
import { createPartyIndex } from './party/party.js';
import { importRecords, renderReport, detectMapping } from './import/importer.js';
import { acceptDiscovered } from './sources/source.js';
import { createMemoryState, createFileStore } from './store/index.js';

export { createNode, createTree, naturalKey } from './tree/tree.js';
export { createContact, createRoster } from './contacts/contacts.js';
export { normalizeTitle, ROLES, frontDesk, byAuthority } from './contacts/titles.js';
export { importRecords, renderReport, detectMapping } from './import/importer.js';
export { parseCsv, toCsv } from './import/csv.js';
export { acceptDiscovered } from './sources/source.js';
export { createFileStore } from './store/index.js';

/**
 * @param {{state?: object, store?: any, extraDomains?: string[]}} [config]
 */
export function createDirectory(config = {}) {
  const state = config.store?.state ?? config.state ?? createMemoryState();
  const tree = createTree(state.nodes);
  const roster = createRoster({ contacts: state.contacts, assignments: state.assignments });
  const party = createPartyIndex({ roster, tree }, { extraDomains: config.extraDomains });

  /**
   * The default view of a property: name, where it sits, and the two contacts
   * that matter. Everything else is a count and a follow-up call away.
   * @param {string} nodeId
   */
  function property(nodeId) {
    const node = tree.resolve(nodeId);
    if (!node) return null;
    const desk = roster.frontDeskAt(node.id);
    return {
      id: node.id,
      name: node.name,
      kind: node.kind,
      address: node.address ?? null,
      attrs: node.attrs,
      under: tree.ancestors(node.id).map((a) => ({ id: a.id, name: a.name, kind: a.kind })),
      office: desk.office ? summarize(desk.office) : null,
      manager: desk.manager ? summarize(desk.manager) : null,
      otherContacts: desk.otherCount,
      sources: node.sources,
    };
  }

  /** The full contact list for a property, ordered by authority. */
  function contactsAt(nodeId, opts) {
    return byAuthority(roster.at(nodeId, opts)).map(summarize);
  }

  /**
   * Who to go to when the usual contact goes quiet: up the ladder at the
   * property first, then the same ladder at each parent node.
   * @param {string} contactId
   */
  function escalationFrom(contactId) {
    const contact = roster.getContact(contactId);
    if (!contact) return [];
    const assignment = roster.current(contactId)[0];
    if (!assignment) return [];

    const atProperty = roster.at(assignment.nodeId);
    const above = tree.ancestors(assignment.nodeId).flatMap((node) => roster.at(node.id));
    return chainAbove(contact, atProperty, above).map(summarize);
  }

  /** Find properties by name, city, or zip — the search the console needs. */
  function search(query, { limit = 20 } = {}) {
    const q = String(query ?? '').toLowerCase().trim();
    if (!q) return [];
    return tree
      .all()
      .filter((n) => n.status !== 'merged')
      .filter((n) =>
        n.name.toLowerCase().includes(q) ||
        (n.address?.city ?? '').toLowerCase().includes(q) ||
        (n.address?.zip ?? '').includes(q))
      .slice(0, limit)
      .map((n) => property(n.id));
  }

  /**
   * Import a CRM export. Always dry-run it first — see import/importer.js.
   * @param {{text?: string, rows?: object[], headers?: string[]}} input
   * @param {object} [opts]
   */
  function importCrm(input, opts = {}) {
    const report = importRecords(input, { tree, roster, ...opts });
    if (!opts.dryRun) party.rebuild();
    return report;
  }

  /**
   * Take records from a crawler. The crawler's own guardrails run before this;
   * `policy` is where they attach.
   * @param {any[]} discovered
   * @param {object} [opts]
   */
  function ingestDiscovered(discovered, opts = {}) {
    const { rows, rejected } = acceptDiscovered(discovered, { tree, roster, ...opts });
    const report = importRecords(
      { rows, headers: rows.length ? Object.keys(rows[0]) : [] },
      { tree, roster, source: { source: opts.sourceName ?? 'crawler' }, ...opts },
    );
    if (!opts.dryRun) party.rebuild();
    return { ...report, rejected };
  }

  /**
   * Hand this to the lead ingestor. It answers "is this message from the
   * industry" and returns a plain object, so neither module imports the other.
   */
  function partyResolver() {
    party.rebuild();
    return party.resolver();
  }

  function stats() {
    const properties = tree.ofKind('property').filter((n) => n.status !== 'merged');
    const contacts = roster.allContacts();
    return {
      properties: properties.length,
      companies: tree.ofKind('management_company').length,
      contacts: contacts.length,
      activeAssignments: roster.allAssignments().filter((a) => !a.endedAt).length,
      withManager: properties.filter((p) => roster.frontDeskAt(p.id).manager).length,
      withOffice: properties.filter((p) => roster.frontDeskAt(p.id).office).length,
      unrecognizedTitles: roster.unrecognizedTitles().length,
      byRole: countBy(contacts, (c) => c.role),
    };
  }

  /**
   * Properties missing the two things the default view shows. This is the work
   * list for whoever is filling gaps — far more useful than a completeness
   * percentage.
   */
  function gaps() {
    return tree
      .ofKind('property')
      .filter((n) => n.status !== 'merged')
      .map((n) => {
        const desk = roster.frontDeskAt(n.id);
        const onSite = roster.at(n.id).some((c) => ['manager', 'assistant_manager', 'leasing'].includes(c.role));
        const missing = [];
        if (!desk.office) missing.push('no leasing office contact');
        if (!desk.manager) missing.push('nobody on file at all');
        else if (!onSite) missing.push(`only a ${desk.manager.role.replace(/_/g, ' ')} contact — no site staff`);
        if (!n.address?.line1) missing.push('no street address');
        return missing.length ? { id: n.id, name: n.name, missing } : null;
      })
      .filter(Boolean);
  }

  return {
    tree,
    roster,
    party,
    property,
    contactsAt,
    escalationFrom,
    search,
    importCrm,
    ingestDiscovered,
    partyResolver,
    identify: (actor) => party.identify(actor),
    stats,
    gaps,
    save: () => config.store?.save?.() ?? null,
  };
}

/** The shape the console renders. Small on purpose. */
function summarize(contact) {
  return {
    id: contact.id,
    name: contact.displayName,
    role: contact.role,
    roleLabel: ROLES[contact.role]?.label ?? contact.role,
    level: contact.level,
    title: contact.rawTitle ?? null,
    email: contact.channels?.find((c) => c.kind === 'email')?.value ?? null,
    phone: contact.channels?.find((c) => c.kind === 'phone')?.value ?? null,
    instagram: contact.channels?.find((c) => c.kind === 'instagram')?.value ?? null,
    status: contact.status,
  };
}

function countBy(list, fn) {
  const out = {};
  for (const item of list) {
    const key = fn(item);
    out[key] = (out[key] ?? 0) + 1;
  }
  return out;
}

export default createDirectory;
