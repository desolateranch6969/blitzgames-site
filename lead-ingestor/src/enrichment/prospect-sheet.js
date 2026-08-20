/**
 * The prospect sheet: everything known about one person, on one page, with the
 * receipts attached.
 *
 * This is the artifact the portal will render and the thing an operator actually
 * reads before picking up a conversation. Its design follows one rule:
 *
 *   **Every line is a fact with a source, or it is a stated gap. Nothing is a
 *   rating.**
 *
 * There is no score, no grade, no tier, no "hotness", and no ordering by
 * quality. Sections are ordered by what a leasing agent needs first — what they
 * asked for, then who they are, then how to reach them, then what is unknown.
 *
 * If a ranking is ever wanted, it belongs in a view layer where an operator
 * chooses and can see the inputs — not baked into the record, where it would
 * silently become the thing everyone acts on.
 */

/**
 * @param {{
 *   person: import('../core/types.js').Person,
 *   lead?: import('../core/types.js').Lead,
 *   events?: import('../core/types.js').RawEvent[],
 * }} input
 */
export function buildProspectSheet({ person, lead, events = [] }) {
  const triage = lead?.triage;
  const facts = person.facts ?? [];

  return {
    person: {
      id: person.id,
      displayName: person.displayName ?? null,
      handles: person.identifiers.filter((i) => i.kind === 'instagram_handle').map((i) => i.value),
      contact: {
        phone: identifierValue(person, 'phone'),
        email: identifierValue(person, 'email'),
      },
      links: buildLinks(person),
      firstSeen: lead?.firstSeenAt ?? person.createdAt,
      lastSeen: lead?.lastSeenAt ?? person.updatedAt,
    },

    /** The routing decision and why. Not a rating. */
    triage: triage
      ? {
          disposition: triage.disposition,
          reasons: triage.reasons,
          needsHuman: triage.needsHuman,
          classifierConfidence: triage.confidence,
        }
      : null,

    /** What they said they want, drawn from their own words. */
    statedNeeds: groupSignals(triage?.signals ?? [], STATED_KINDS),

    /** Who they appear to be, each line with where it came from. */
    profile: facts
      .filter((f) => !INTERNAL_FIELDS.has(f.field))
      .map((f) => ({
        field: f.field,
        value: f.value,
        source: f.source,
        method: f.method,
        url: f.url ?? null,
        observedAt: f.observedAt,
        confidence: f.confidence ?? null,
      }))
      .sort((a, b) => a.field.localeCompare(b.field)),

    /**
     * Where two sources disagree. Surfaced rather than resolved: a bio saying
     * Dallas and a vendor saying Fort Worth is information, and picking one
     * silently throws it away.
     */
    conflicts: findConflicts(facts),

    /** What is still unknown, so the next message has an obvious purpose. */
    gaps: {
      criteria: triage?.missing ?? [],
      identity: identityGaps(person),
      enrichment: enrichmentGaps(person),
    },

    /** The raw record, for anyone who wants to check the work. */
    provenance: {
      sources: [...new Set(events.map((e) => e.source))],
      eventCount: events.length,
      firstEventAt: events[0]?.occurredAt ?? null,
      lastEventAt: events.at(-1)?.occurredAt ?? null,
      enrichmentSources: [...new Set(facts.map((f) => f.source))],
    },
  };
}

/** Signal kinds that describe what the person asked for. */
const STATED_KINDS = {
  stated_budget: 'budget',
  stated_size: 'size',
  stated_timeline: 'timing',
  stated_area: 'area',
  urgency: 'urgency',
  screening_disclosure: 'rental history',
  names_property: 'specific property',
  referral: 'how they found him',
  provided_contact: 'contact offered',
};

const INTERNAL_FIELDS = new Set(['website.fetched', 'linkedin.lookup']);

function groupSignals(signals, kinds) {
  return signals
    .filter((s) => kinds[s.kind])
    .map((s) => ({ what: kinds[s.kind], evidence: s.evidence, source: s.source }));
}

function identifierValue(person, kind) {
  return person.identifiers?.find((i) => i.kind === kind)?.value ?? null;
}

function buildLinks(person) {
  const links = [];
  const handle = identifierValue(person, 'instagram_handle');
  if (handle) links.push({ label: 'Instagram', url: `https://instagram.com/${handle}` });

  const linkedin = identifierValue(person, 'linkedin_url') ?? factValue(person, 'linkedin.url');
  if (linkedin) {
    links.push({
      label: 'LinkedIn',
      url: String(linkedin),
      // A resolved URL is a candidate until someone looks at it.
      confirmed: Boolean(identifierValue(person, 'linkedin_url')),
    });
  }

  const website = identifierValue(person, 'website') ?? factValue(person, 'instagram.website');
  if (website) links.push({ label: 'Website', url: String(website) });
  return links;
}

function factValue(person, field) {
  return person.facts?.find((f) => f.field === field)?.value ?? null;
}

/** @param {import('../core/types.js').Fact[]} facts */
function findConflicts(facts) {
  /** @type {Map<string, import('../core/types.js').Fact[]>} */
  const byField = new Map();
  for (const fact of facts) {
    if (!byField.has(fact.field)) byField.set(fact.field, []);
    byField.get(fact.field).push(fact);
  }

  const conflicts = [];
  for (const [field, list] of byField) {
    const distinct = [...new Set(list.map((f) => JSON.stringify(f.value)))];
    if (distinct.length > 1) {
      conflicts.push({
        field,
        values: list.map((f) => ({ value: f.value, source: f.source, observedAt: f.observedAt, url: f.url ?? null })),
      });
    }
  }
  return conflicts;
}

function identityGaps(person) {
  const gaps = [];
  if (!identifierValue(person, 'phone')) gaps.push('no phone number');
  if (!identifierValue(person, 'email')) gaps.push('no email');
  if (!person.displayName) gaps.push('no real name');
  return gaps;
}

function enrichmentGaps(person) {
  const fields = new Set((person.facts ?? []).map((f) => f.field));
  const gaps = [];
  if (!fields.has('instagram.followers') && !fields.has('instagram.profile_visibility')) {
    gaps.push('instagram profile not checked');
  }
  if (fields.has('instagram.profile_visibility') && factValue(person, 'instagram.profile_visibility') !== 'professional') {
    gaps.push('instagram profile is personal or private — no API data available');
  }
  if (!fields.has('linkedin.url')) gaps.push('no linkedin found');
  return gaps;
}

/**
 * A one-screen text rendering, for the CLI and for pasting into a thread.
 * @param {ReturnType<typeof buildProspectSheet>} sheet
 */
export function renderProspectSheet(sheet) {
  const lines = [];
  const name = sheet.person.displayName ?? sheet.person.handles[0] ?? sheet.person.id;
  lines.push(`${name}${sheet.person.handles[0] ? `  @${sheet.person.handles[0]}` : ''}`);
  lines.push('─'.repeat(Math.max(20, name.length + 12)));

  if (sheet.triage) {
    lines.push(`disposition   ${sheet.triage.disposition}${sheet.triage.needsHuman ? '  (needs a human)' : ''}`);
    for (const reason of sheet.triage.reasons) lines.push(`              · ${reason}`);
  }

  if (sheet.statedNeeds.length) {
    lines.push('', 'asked for');
    for (const need of sheet.statedNeeds) lines.push(`  ${need.what.padEnd(18)} "${need.evidence}"`);
  }

  if (sheet.profile.length) {
    lines.push('', 'profile');
    for (const fact of sheet.profile) {
      lines.push(`  ${fact.field.padEnd(28)} ${String(fact.value).slice(0, 60)}   [${fact.source}/${fact.method}]`);
    }
  }

  if (sheet.conflicts.length) {
    lines.push('', 'sources disagree');
    for (const conflict of sheet.conflicts) {
      lines.push(`  ${conflict.field}: ${conflict.values.map((v) => `${v.value} (${v.source})`).join(' vs ')}`);
    }
  }

  const gaps = [...sheet.gaps.criteria, ...sheet.gaps.identity, ...sheet.gaps.enrichment];
  if (gaps.length) {
    lines.push('', 'not known');
    for (const gap of gaps) lines.push(`  · ${gap}`);
  }

  if (sheet.person.links.length) {
    lines.push('', 'links');
    for (const link of sheet.person.links) {
      lines.push(`  ${link.label.padEnd(10)} ${link.url}${link.confirmed === false ? '  (candidate, unconfirmed)' : ''}`);
    }
  }

  return lines.join('\n');
}
