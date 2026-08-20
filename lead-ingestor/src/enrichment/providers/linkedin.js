/**
 * LinkedIn provider.
 *
 * ## Why this is a resolver plus a slot, and not a scraper
 *
 * A scraper here would be the wrong thing to build, and not only for the obvious
 * reason. LinkedIn's user agreement prohibits automated collection, and they
 * enforce it well: unauthenticated profile views return a wall, authenticated
 * scraping gets the *account* restricted, and the selectors change constantly.
 * A scraper built today is a maintenance burden that produces nothing within
 * weeks, and it puts a real LinkedIn account at risk to do it.
 *
 * So this provider does the two things that actually work and keep working:
 *
 *   1. **Resolve** a candidate profile URL from data the person already
 *      published — their Instagram bio, their link-in-bio site, their email
 *      domain. No fetching of LinkedIn at all. The URL lands on the prospect
 *      sheet as a link the operator clicks. One click, full profile, zero risk.
 *
 *   2. **Delegate** the actual lookup to an injected `vendorLookup` function, so
 *      a licensed data API (People Data Labs, Proxycurl, Clearbit, or whatever
 *      is in use) can be dropped in without touching this file. Licensed vendors
 *      are how this data is obtained legitimately at volume, and they return
 *      structured records instead of parsed HTML.
 *
 * Facts from a resolver are marked `inferred` and carry a confidence, because a
 * candidate URL is a guess until a human confirms it. Facts from a vendor are
 * marked `vendor`. Neither is ever presented as if someone read the profile.
 */
import { normalizeLinkedInUrl } from '../../identity/handles.js';

/**
 * @param {{
 *   vendorLookup?: (query: {name?: string, email?: string, company?: string, website?: string}) => Promise<any>,
 *   allowVendor?: boolean,
 * }} [config]
 * @returns {import('../enricher.js').Provider}
 */
export function createLinkedInProvider(config = {}) {
  const { vendorLookup, allowVendor = true } = config;

  return {
    name: 'linkedin',
    ttlMs: 60 * 24 * 3600_000,

    appliesTo(person) {
      return Boolean(candidateUrlFrom(person) || person.displayName || emailOf(person));
    },

    async fetch(person, ctx) {
      /** @type {import('../../core/types.js').Fact[]} */
      const facts = [];

      // 1. A URL the person themselves published somewhere.
      const found = candidateUrlFrom(person);
      if (found) {
        facts.push({
          field: 'linkedin.url',
          value: found.url,
          method: found.method,
          url: found.evidenceUrl,
          confidence: found.confidence,
        });
      }

      // 2. A licensed vendor, if one is wired up.
      if (allowVendor && vendorLookup) {
        const query = {
          name: person.displayName,
          email: emailOf(person),
          website: websiteOf(person),
          company: factValue(person, 'employer.name'),
        };
        if (query.name || query.email || query.website) {
          const record = await vendorLookup(query);
          for (const [field, value] of Object.entries(flattenVendorRecord(record))) {
            facts.push({ field, value, method: 'vendor', confidence: 0.7, url: record?.profile_url ?? found?.url });
          }
        }
      }

      if (!facts.length) {
        facts.push({
          field: 'linkedin.lookup',
          value: 'no candidate found',
          method: 'inferred',
          confidence: 1,
        });
      }
      return facts;
    },
  };
}

/**
 * Look for a LinkedIn URL the person already made public. Checked in order of
 * how directly the person put it there.
 * @param {import('../../core/types.js').Person} person
 */
export function candidateUrlFrom(person) {
  const identifier = person.identifiers?.find((i) => i.kind === 'linkedin_url')?.value;
  if (identifier) {
    return { url: identifier, method: 'operator', evidenceUrl: identifier, confidence: 1 };
  }

  // Already discovered by the website provider crawling their link-in-bio.
  const fromSite = person.facts?.find((f) => f.field === 'linkedin.url');
  if (fromSite?.value) {
    return { url: String(fromSite.value), method: 'public_page', evidenceUrl: fromSite.url, confidence: 0.8 };
  }

  // Written into their Instagram bio.
  const bio = String(factValue(person, 'instagram.biography') ?? '');
  const inBio = normalizeLinkedInUrl(bio.match(/linkedin\.com\/in\/[a-z0-9\-_%]+/i)?.[0] ?? '');
  if (inBio) {
    return {
      url: inBio,
      method: 'public_page',
      evidenceUrl: `https://instagram.com/${person.identifiers?.find((i) => i.kind === 'instagram_handle')?.value ?? ''}`,
      confidence: 0.9,
    };
  }

  const website = websiteOf(person);
  const fromWebsiteField = normalizeLinkedInUrl(website ?? '');
  if (fromWebsiteField) {
    return { url: fromWebsiteField, method: 'public_page', evidenceUrl: website, confidence: 0.9 };
  }

  return null;
}

/**
 * Map a vendor's record onto our field names. Kept small on purpose: employment
 * and location are what tell a leasing agent something useful (does the commute
 * make sense, is this a relocation). Everything else is data held for no reason.
 */
function flattenVendorRecord(record) {
  if (!record || typeof record !== 'object') return {};
  const out = {};
  const put = (field, value) => {
    if (value != null && value !== '') out[field] = value;
  };
  put('linkedin.url', record.profile_url ?? record.linkedin_url);
  put('linkedin.headline', record.headline ?? record.job_title);
  put('employer.name', record.company ?? record.job_company_name);
  put('employer.title', record.job_title ?? record.title);
  put('location.stated', record.location ?? record.location_name);
  return out;
}

function factValue(person, field) {
  return person.facts?.find((f) => f.field === field)?.value ?? null;
}
function emailOf(person) {
  return person.identifiers?.find((i) => i.kind === 'email')?.value ?? null;
}
function websiteOf(person) {
  return (
    person.identifiers?.find((i) => i.kind === 'website')?.value ??
    (typeof factValue(person, 'instagram.website') === 'string' ? factValue(person, 'instagram.website') : null)
  );
}
