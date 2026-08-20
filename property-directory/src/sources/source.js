/**
 * Property source contract — the seam a crawler plugs into later.
 *
 * Deliberately thin. The crawler is coming from elsewhere and its guardrails are
 * being rebuilt by whoever owns it, so this defines the shape of what comes
 * back and nothing about how it is gathered. No fetching, no rate limiting, no
 * politeness policy, no robots handling — those belong to the crawler, not to
 * the directory that receives its output.
 *
 * What the directory does insist on:
 *   - every record carries provenance, so a crawled value is never
 *     indistinguishable from one a person typed
 *   - a `policy` hook runs before anything is accepted, which is where the
 *     owner's guardrails attach without editing this file
 *
 *   const source = {
 *     name: 'property-crawler',
 *     async discover({ since }) { return [ { name, address, contacts, url } ] },
 *     async health() { return { status: 'ok' } },
 *   }
 */

/**
 * @typedef {Object} DiscoveredProperty
 * @property {string} name
 * @property {{line1?: string, city?: string, state?: string, zip?: string}} [address]
 * @property {string} [website]
 * @property {string} [managementCompany]
 * @property {Record<string, unknown>} [attrs]
 * @property {DiscoveredContact[]} [contacts]
 * @property {string} [url]          Where it was found — required for provenance.
 *
 * @typedef {Object} DiscoveredContact
 * @property {string} [name]
 * @property {string} [title]
 * @property {string} [email]
 * @property {string} [phone]
 *
 * @typedef {Object} PropertySource
 * @property {string} name
 * @property {(opts?: {since?: string}) => Promise<DiscoveredProperty[]>} discover
 * @property {() => Promise<{status: string, detail?: string}>} [health]
 */

/**
 * Accept discovered records into the directory.
 *
 * @param {DiscoveredProperty[]} discovered
 * @param {{
 *   tree: any, roster: any, sourceName?: string,
 *   policy?: (record: DiscoveredProperty) => {accept: boolean, reason?: string},
 *   dryRun?: boolean,
 * }} opts
 */
export function acceptDiscovered(discovered, opts) {
  const policy = opts.policy ?? (() => ({ accept: true }));
  const rows = [];
  const rejected = [];

  for (const record of discovered ?? []) {
    const verdict = policy(record);
    if (!verdict.accept) {
      rejected.push({ name: record.name, reason: verdict.reason ?? 'rejected by policy' });
      continue;
    }

    // Flattened to the same denormalized shape the CRM importer already takes,
    // so discovery and import share one code path instead of two.
    const base = {
      propertyName: record.name,
      addressLine1: record.address?.line1 ?? '',
      city: record.address?.city ?? '',
      state: record.address?.state ?? '',
      zip: record.address?.zip ?? '',
      managementCompany: record.managementCompany ?? '',
      propertyWebsite: record.website ?? '',
    };

    if (!record.contacts?.length) {
      rows.push({ ...base, contactName: '', contactTitle: '', contactEmail: '', contactPhone: '' });
      continue;
    }
    for (const contact of record.contacts) {
      rows.push({
        ...base,
        contactName: contact.name ?? '',
        contactTitle: contact.title ?? '',
        contactEmail: contact.email ?? '',
        contactPhone: contact.phone ?? '',
      });
    }
  }

  return { rows, rejected };
}
