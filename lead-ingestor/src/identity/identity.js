/**
 * Identity resolution: deciding when two observations are the same human.
 *
 * The same person reaches out from a story reply, then a DM, then texts a phone
 * number, then turns up again next spring under a changed handle. Each of those
 * is a separate observation and they have to collapse onto one record — but only
 * when the evidence actually supports it.
 *
 * The rule is deliberately strict: **auto-merge on strong identifiers only.**
 * Matching names, matching cities, or a similar handle produce a *suggestion*
 * for a human to confirm in the portal, never an automatic merge. A wrong merge
 * puts one person's phone number, income, and rental history onto another
 * person's record, and once merged the original boundary is gone.
 */
import { identifierKey, makeIdentifier } from './handles.js';

/** @returns {import('../core/types.js').Person} */
export function createPerson({ id, identifiers = [], displayName, facts = [] }) {
  const now = new Date().toISOString();
  return {
    id: id ?? `p_${randomId()}`,
    identifiers: dedupeIdentifiers(identifiers),
    displayName,
    facts,
    mergedFrom: [],
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Find the person an actor belongs to, creating one if this is someone new.
 *
 * @param {{
 *   findByIdentifier: (key: string) => Promise<import('../core/types.js').Person|null>,
 *   save: (person: import('../core/types.js').Person) => Promise<any>,
 * }} store
 * @param {import('../core/types.js').SourceActor} actor
 * @param {{source: string, observedAt?: string}} meta
 * @returns {Promise<{person: import('../core/types.js').Person, created: boolean}>}
 */
export async function resolveActor(store, actor, meta) {
  const candidates = [
    makeIdentifier('instagram_id', actor.platform === 'instagram' ? actor.platformId : '', meta),
    makeIdentifier('instagram_handle', actor.handle ?? '', meta),
  ].filter(Boolean);

  // Strong identifiers first: a platform id is authoritative, a handle is not.
  for (const identifier of [...candidates].sort((a, b) => (a.strength === 'strong' ? -1 : 1))) {
    const found = await store.findByIdentifier(identifierKey(identifier));
    if (found) {
      const updated = addIdentifiers(found, candidates);
      if (actor.displayName && !updated.displayName) updated.displayName = actor.displayName;
      await store.save(updated);
      return { person: updated, created: false };
    }
  }

  const person = createPerson({ identifiers: candidates, displayName: actor.displayName });
  await store.save(person);
  return { person, created: true };
}

/**
 * Add identifiers to a person, keeping the earliest observation of each.
 * @param {import('../core/types.js').Person} person
 * @param {import('../core/types.js').Identifier[]} identifiers
 */
export function addIdentifiers(person, identifiers) {
  const merged = dedupeIdentifiers([...person.identifiers, ...identifiers.filter(Boolean)]);
  const changed = merged.length !== person.identifiers.length;
  return changed ? { ...person, identifiers: merged, updatedAt: new Date().toISOString() } : person;
}

/**
 * Attach facts, replacing any earlier value for the same field from the same
 * source. Two sources may legitimately disagree (a bio says Dallas, a LinkedIn
 * says Fort Worth) and both are kept — the portal shows the disagreement rather
 * than silently picking a winner.
 *
 * @param {import('../core/types.js').Person} person
 * @param {import('../core/types.js').Fact[]} facts
 */
export function addFacts(person, facts) {
  const kept = person.facts.filter(
    (existing) => !facts.some((f) => f.field === existing.field && f.source === existing.source),
  );
  return {
    ...person,
    facts: [...kept, ...facts.filter(Boolean)],
    updatedAt: new Date().toISOString(),
  };
}

/**
 * Would these two records auto-merge? Returns the reason when yes, and when no,
 * whether a human should be asked.
 *
 * @param {import('../core/types.js').Person} a
 * @param {import('../core/types.js').Person} b
 * @returns {{merge: boolean, suggest: boolean, reason: string}}
 */
export function compareIdentities(a, b) {
  const strongA = new Set(a.identifiers.filter((i) => i.strength === 'strong').map(identifierKey));
  const shared = b.identifiers.filter((i) => i.strength === 'strong' && strongA.has(identifierKey(i)));
  if (shared.length) {
    return { merge: true, suggest: false, reason: `shares ${shared.map((i) => i.kind).join(', ')}` };
  }

  const weakA = new Set(a.identifiers.filter((i) => i.strength === 'weak').map(identifierKey));
  const weakShared = b.identifiers.filter((i) => i.strength === 'weak' && weakA.has(identifierKey(i)));
  if (weakShared.length) {
    return {
      merge: false,
      suggest: true,
      reason: `shares ${weakShared.map((i) => i.kind).join(', ')}, which can be reassigned to a different person`,
    };
  }

  if (a.displayName && b.displayName && a.displayName.toLowerCase() === b.displayName.toLowerCase()) {
    return { merge: false, suggest: true, reason: 'same display name, which is not an identifier' };
  }

  return { merge: false, suggest: false, reason: 'no shared identifiers' };
}

/**
 * Fold `from` into `into`. Never called automatically except on a strong match;
 * the portal calls it directly when an operator confirms a suggestion.
 *
 * @param {import('../core/types.js').Person} into
 * @param {import('../core/types.js').Person} from
 */
export function mergePeople(into, from) {
  return {
    ...into,
    identifiers: dedupeIdentifiers([...into.identifiers, ...from.identifiers]),
    displayName: into.displayName ?? from.displayName,
    facts: [...into.facts, ...from.facts.filter((f) => !into.facts.some((e) => e.field === f.field && e.source === f.source))],
    mergedFrom: [...new Set([...into.mergedFrom, from.id, ...from.mergedFrom])],
    updatedAt: new Date().toISOString(),
  };
}

/** @param {import('../core/types.js').Identifier[]} identifiers */
function dedupeIdentifiers(identifiers) {
  /** @type {Map<string, import('../core/types.js').Identifier>} */
  const byKey = new Map();
  for (const identifier of identifiers.filter(Boolean)) {
    const key = identifierKey(identifier);
    const existing = byKey.get(key);
    if (!existing || identifier.observedAt < existing.observedAt) byKey.set(key, identifier);
  }
  return [...byKey.values()];
}

function randomId() {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}
