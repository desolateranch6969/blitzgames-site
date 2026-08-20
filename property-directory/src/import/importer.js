/**
 * CRM import.
 *
 * The CRM is unknown until his export lands, so this makes no assumptions about
 * it beyond the one shape every leasing CRM export shares: **a denormalized
 * table, one row per contact, with the property repeated across rows.** From
 * that, one pass produces properties, contacts, and the assignments between
 * them.
 *
 * Three properties matter more than features here:
 *
 *   1. **Dry run first.** Nothing is written until the operator has seen what
 *      the import believes it found — including which columns it could not
 *      place. An import that silently invents 400 properties from a
 *      misread column is a day of cleanup.
 *   2. **Idempotent.** Re-running the same export changes nothing. Exports get
 *      re-pulled and re-imported constantly; that must be safe.
 *   3. **Nothing is dropped silently.** Every skipped row comes back with a
 *      reason, ready to be written out, corrected, and re-fed.
 */
import { parseCsv } from './csv.js';
import { createNode, naturalKey } from '../tree/tree.js';
import { createContact, normalizeChannelValue } from '../contacts/contacts.js';

/**
 * Header synonyms. Matching is loose — lowercase, non-alphanumerics stripped —
 * because CRM headers are written by humans: "Property Name", "property_name",
 * "PROPERTY", "Community".
 * @type {Record<string, string[]>}
 */
export const FIELD_SYNONYMS = {
  propertyName: ['property', 'propertyname', 'community', 'communityname', 'apartment', 'apartmentname', 'complex', 'building', 'site', 'account', 'accountname', 'name of property', 'location'],
  propertyWebsite: ['website', 'url', 'weblink', 'propertywebsite', 'site url'],
  addressLine1: ['address', 'address1', 'addressline1', 'street', 'streetaddress', 'propertyaddress'],
  city: ['city', 'town', 'propertycity'],
  state: ['state', 'st', 'province', 'propertystate'],
  zip: ['zip', 'zipcode', 'postal', 'postalcode'],
  units: ['units', 'unitcount', 'numberofunits', 'totalunits', 'doors'],
  managementCompany: ['management', 'managementcompany', 'mgmtcompany', 'mgmt', 'owner', 'ownership', 'parentcompany', 'group', 'portfolio'],

  contactFirstName: ['firstname', 'first', 'fname', 'contactfirstname'],
  contactLastName: ['lastname', 'last', 'lname', 'surname', 'contactlastname'],
  contactName: ['contact', 'contactname', 'fullname', 'name', 'primarycontact', 'manager', 'agent'],
  contactTitle: ['title', 'role', 'position', 'jobtitle', 'contacttitle'],
  contactEmail: ['email', 'emailaddress', 'contactemail', 'e-mail'],
  contactPhone: ['phone', 'phonenumber', 'telephone', 'contactphone', 'mobile', 'cell', 'office', 'officephone', 'directphone'],
  contactInstagram: ['instagram', 'ig', 'instagramhandle', 'social'],
  notes: ['notes', 'note', 'comments', 'description', 'remarks'],
  // If the CRM already tracks when a contact was last confirmed, inherit it
  // rather than starting every record from unverified.
  contactVerifiedAt: ['lastcontacted', 'lastverified', 'lastcontact', 'lastupdated', 'verified', 'lasttouch', 'lastactivity'],
};

/** @param {string} header */
function slug(header) {
  return String(header).toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Work out which column is which. Returns the mapping AND the columns it could
 * not place, because the unplaced ones are what the operator needs to see.
 *
 * @param {string[]} headers
 * @param {Record<string, string>} [overrides]  field -> exact header name
 */
export function detectMapping(headers, overrides = {}) {
  /** @type {Record<string, string>} */
  const mapping = {};
  const used = new Set();

  for (const [field, header] of Object.entries(overrides)) {
    if (headers.includes(header)) {
      mapping[field] = header;
      used.add(header);
    }
  }

  for (const [field, synonyms] of Object.entries(FIELD_SYNONYMS)) {
    if (mapping[field]) continue;
    const match = headers.find((h) => !used.has(h) && synonyms.includes(slug(h)));
    if (match) {
      mapping[field] = match;
      used.add(match);
    }
  }

  // Second pass: contains-matching, only for fields still unfilled. Looser, so
  // it runs last and never steals a column an exact match wanted.
  for (const [field, synonyms] of Object.entries(FIELD_SYNONYMS)) {
    if (mapping[field]) continue;
    const match = headers.find((h) => !used.has(h) && synonyms.some((s) => s.length > 4 && slug(h).includes(s)));
    if (match) {
      mapping[field] = match;
      used.add(match);
    }
  }

  return {
    mapping,
    unmapped: headers.filter((h) => !used.has(h)),
    missingRequired: mapping.propertyName ? [] : ['propertyName'],
  };
}

/**
 * @param {{text?: string, rows?: object[], headers?: string[]}} input
 * @param {{
 *   tree: any, roster: any,
 *   mapping?: Record<string, string>,
 *   source?: {source?: string, reference?: string},
 *   dryRun?: boolean,
 *   defaultManagementCompany?: string,
 * }} opts
 */
export function importRecords(input, opts) {
  const { tree, roster } = opts ?? {};
  if (!tree || !roster) throw new Error('import needs a tree and a roster');

  // Options passed in the input argument are silently ignored, and the two that
  // matter most fail dangerously when ignored: `dryRun` writes anyway, and
  // `reconcile` quietly departs nobody. Refuse rather than misbehave.
  const misplaced = ['dryRun', 'reconcile', 'mapping', 'source', 'defaultManagementCompany'].filter(
    (key) => input && key in input,
  );
  if (misplaced.length) {
    throw new Error(
      `${misplaced.join(', ')} belong in the second argument, not the first: ` +
        `importCrm({ text }, { ${misplaced[0]}: … })`,
    );
  }

  const parsed = input.text ? parseCsv(input.text) : { headers: input.headers ?? [], rows: input.rows ?? [] };
  const { mapping, unmapped, missingRequired } = detectMapping(parsed.headers, opts.mapping);

  const source = {
    source: opts.source?.source ?? 'crm-import',
    reference: opts.source?.reference,
    // When the FILE was produced, not when we got round to loading it. A CRM
    // dump generated three months ago must not mark its roster fresh today —
    // that is precisely the stale data the freshness model exists to catch.
    at: opts.source?.at ?? new Date().toISOString(),
  };

  /** Contacts this file vouched for — the basis for reconciling departures. */
  const seenContactIds = new Set();
  const touchedNodeIds = new Set();

  const report = {
    rows: parsed.rows.length,
    mapping,
    unmappedColumns: unmapped,
    missingRequired,
    properties: { created: 0, matched: 0 },
    companies: { created: 0, matched: 0 },
    contacts: { created: 0, matched: 0, assigned: 0 },
    skipped: [],
    unrecognizedTitles: new Map(),
    departed: [],
    dryRun: Boolean(opts.dryRun),
  };

  if (missingRequired.length) {
    report.skipped.push({ row: 0, reason: `no column looks like a property name. Map it explicitly with --map propertyName=<header>.` });
    return finish(report);
  }

  // Index what already exists so re-running an export is a no-op.
  const byKey = new Map();
  for (const node of tree.all()) {
    if (node.status === 'merged') continue;
    byKey.set(naturalKey(node), node);
  }
  const companiesByName = new Map(
    tree.ofKind('management_company').map((n) => [n.name.toLowerCase(), n]),
  );

  parsed.rows.forEach((row, index) => {
    const get = (field) => (mapping[field] ? String(row[mapping[field]] ?? '').trim() : '');

    const propertyName = get('propertyName');
    if (!propertyName) {
      report.skipped.push({ row: index + 2, reason: 'no property name in this row', data: row });
      return;
    }

    // ── company ──────────────────────────────────────────────
    const companyName = get('managementCompany') || opts.defaultManagementCompany || '';
    let company = null;
    if (companyName) {
      company = companiesByName.get(companyName.toLowerCase()) ?? null;
      if (company) {
        report.companies.matched++;
      } else {
        company = createNode({ kind: 'management_company', name: companyName, source });
        if (!opts.dryRun) tree.insert(company);
        companiesByName.set(companyName.toLowerCase(), company);
        report.companies.created++;
      }
    }

    // ── property ─────────────────────────────────────────────
    const address = {
      line1: get('addressLine1') || undefined,
      city: get('city') || undefined,
      state: get('state') || undefined,
      zip: get('zip') || undefined,
    };
    const candidate = { name: propertyName, address };
    const key = naturalKey(candidate);

    let property = byKey.get(key) ?? null;
    if (property) {
      report.properties.matched++;
      if (!opts.dryRun) {
        // Fill gaps from the newer record; never overwrite a known value with
        // a blank one, which is how re-imports quietly erase data.
        property.address = { ...(property.address ?? {}), ...stripEmpty(address) };
        if (get('units')) property.attrs.units ??= Number(get('units')) || get('units');
        if (get('propertyWebsite')) property.attrs.website ??= get('propertyWebsite');
        property.sources.push(source);
        property.updatedAt = source.at;
      }
    } else {
      property = createNode({
        kind: 'property',
        name: propertyName,
        parentId: company?.id ?? null,
        address: stripEmpty(address),
        attrs: {
          ...(get('units') ? { units: Number(get('units')) || get('units') } : {}),
          ...(get('propertyWebsite') ? { website: get('propertyWebsite') } : {}),
        },
        source,
      });
      if (!opts.dryRun) tree.insert(property);
      byKey.set(key, property);
      report.properties.created++;
    }

    // ── contact ──────────────────────────────────────────────
    const email = normalizeChannelValue('email', get('contactEmail'));
    const phone = normalizeChannelValue('phone', get('contactPhone'));
    const instagram = normalizeChannelValue('instagram', get('contactInstagram'));
    const first = get('contactFirstName');
    const last = get('contactLastName');
    const whole = get('contactName');
    const title = get('contactTitle');

    const hasContact = Boolean(first || last || whole || email || phone);
    if (!hasContact) return; // a property-only row is legitimate

    const displayName = [first, last].filter(Boolean).join(' ').trim() || whole || officeNameFor(propertyName, email);

    let contact = findExistingContact(roster, { email, phone, instagram, displayName, nodeId: property.id });
    if (contact) {
      report.contacts.matched++;
      if (!opts.dryRun) {
        contact.channels = mergeChannels(contact.channels, [
          { kind: 'email', value: email },
          { kind: 'phone', value: phone },
          { kind: 'instagram', value: instagram },
        ]);
        contact.sources.push(source);
        contact.updatedAt = source.at;
        // Still in the export means still there as of the export date.
        contact.verifiedAt = parseDate(get('contactVerifiedAt')) ?? source.at;
        if (contact.status === 'unknown') contact.status = 'active';
      }
      seenContactIds.add(contact.id);
    } else {
      contact = createContact({
        firstName: first || undefined,
        lastName: last || undefined,
        displayName,
        rawTitle: title || undefined,
        // An import is itself evidence: the CRM held this person as of the
        // export. Prefer the CRM's own last-contacted column when it has one.
        verifiedAt: parseDate(get('contactVerifiedAt')) ?? source.at,
        channels: [
          { kind: 'email', value: email, primary: true },
          { kind: 'phone', value: phone },
          { kind: 'instagram', value: instagram },
        ].filter((c) => c.value),
        notes: get('notes') || undefined,
        source,
      });
      if (!opts.dryRun) roster.addContact(contact);
      seenContactIds.add(contact.id);
      report.contacts.created++;
    }

    if (title && contact.role === 'unknown') {
      const seen = report.unrecognizedTitles.get(title.toLowerCase()) ?? { rawTitle: title, count: 0 };
      seen.count++;
      report.unrecognizedTitles.set(title.toLowerCase(), seen);
    }

    if (!opts.dryRun) {
      // Dated from the export, not from the moment of loading — an assignment
      // learned from a year-old file began at least a year ago, and any
      // as-of query against the interim would otherwise miss it.
      roster.assign(contact.id, property.id, { source, startedAt: source.at, keepOthers: true });
    }
    touchedNodeIds.add(property.id);
    report.contacts.assigned++;
  });

  // ── reconcile departures ───────────────────────────────────────────────
  //
  // Someone who was on file at a property and is NOT in a fresh full export of
  // that property has left. That is the strongest automatic turnover signal
  // there is, and it costs nobody any effort.
  //
  // Guarded behind an explicit opt-in, because the inference only holds if the
  // file is COMPLETE for the properties it touches. Run it on a partial export
  // and it marks half the directory as departed.
  if (opts.reconcile && !opts.dryRun) {
    for (const nodeId of touchedNodeIds) {
      for (const contact of roster.at(nodeId)) {
        if (seenContactIds.has(contact.id)) continue;
        roster.markDeparted(contact.id, source.at);
        report.departed.push({ name: contact.displayName, role: contact.role, nodeId });
      }
    }
  }

  return finish(report);
}

function finish(report) {
  report.unrecognizedTitles = [...report.unrecognizedTitles.values()].sort((a, b) => b.count - a.count);
  return report;
}

/**
 * Match an incoming row to a contact already on file.
 *
 * Email and phone are exact and decide alone. Name is only trusted **within the
 * same property** — "Sarah Johnson" is not rare, and matching on a name across
 * a whole portfolio merges two different people.
 */
function findExistingContact(roster, { email, phone, instagram, displayName, nodeId }) {
  for (const contact of roster.allContacts()) {
    for (const channel of contact.channels ?? []) {
      if (email && channel.kind === 'email' && channel.value === email) return contact;
      if (phone && channel.kind === 'phone' && channel.value === phone) return contact;
      if (instagram && channel.kind === 'instagram' && channel.value === instagram) return contact;
    }
  }

  if (displayName && nodeId) {
    const here = roster.at(nodeId, { includeDeparted: true });
    const match = here.find((c) => c.displayName.toLowerCase() === displayName.toLowerCase());
    if (match) return roster.getContact(match.id);
  }
  return null;
}

function mergeChannels(existing = [], incoming = []) {
  const out = [...existing];
  for (const channel of incoming) {
    if (!channel.value) continue;
    if (out.some((c) => c.kind === channel.kind && c.value === channel.value)) continue;
    out.push({ kind: channel.kind, value: channel.value });
  }
  return out;
}

/** A row with an email but no person's name is the office. */
function officeNameFor(propertyName, email) {
  return email ? `${propertyName} leasing office` : propertyName;
}

/** Lenient date parsing — CRM exports write dates a dozen ways. */
function parseDate(raw) {
  if (!raw) return null;
  const parsed = Date.parse(raw);
  return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
}

function stripEmpty(object) {
  return Object.fromEntries(Object.entries(object).filter(([, v]) => v != null && v !== ''));
}

/**
 * Render a report for a terminal. Leads with what could not be placed, because
 * that is the part that needs a decision.
 * @param {ReturnType<typeof importRecords>} report
 */
export function renderReport(report) {
  const lines = [];
  lines.push(report.dryRun ? '\nDRY RUN — nothing was written\n' : '\nImport complete\n');
  lines.push(`  rows read            ${report.rows}`);
  lines.push(`  properties           ${report.properties.created} new, ${report.properties.matched} rows matched existing`);
  if (report.companies.created || report.companies.matched) {
    lines.push(`  management companies ${report.companies.created} new, ${report.companies.matched} rows matched existing`);
  }
  lines.push(`  contacts             ${report.contacts.created} new, ${report.contacts.matched} rows matched existing`);
  lines.push(`  assignments          ${report.contacts.assigned}`);

  lines.push('\n  columns mapped');
  for (const [field, header] of Object.entries(report.mapping)) {
    lines.push(`    ${field.padEnd(20)} ← "${header}"`);
  }

  if (report.unmappedColumns.length) {
    lines.push(`\n  columns ignored      ${report.unmappedColumns.join(', ')}`);
    lines.push(`    Map any of these with --map <field>=<column>`);
  }

  if (report.unrecognizedTitles.length) {
    lines.push('\n  titles not recognized (kept as written, no rank assigned)');
    for (const t of report.unrecognizedTitles.slice(0, 12)) {
      lines.push(`    ${String(t.count).padStart(4)}  ${t.rawTitle}`);
    }
  }

  if (report.skipped.length) {
    lines.push(`\n  rows skipped         ${report.skipped.length}`);
    for (const s of report.skipped.slice(0, 5)) lines.push(`    row ${s.row}: ${s.reason}`);
    if (report.skipped.length > 5) lines.push(`    …and ${report.skipped.length - 5} more`);
  }

  return lines.join('\n') + '\n';
}
