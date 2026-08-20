/**
 * The two-card model.
 *
 * A rolodex card per property, except every property carries two of them —
 * because the contacts on it decay at wildly different rates, and treating them
 * as one list means the whole card rots at the speed of its fastest-rotting
 * entry.
 *
 *   LOCAL CARD    The site team: office line, property manager, assistant,
 *                 leasing staff. High churn. Eight-month half-life is normal.
 *                 Displayed as primary, because it is who you actually call.
 *
 *   MASTER CARD   Inherited from above: the regional, and corporate behind them.
 *                 Low churn. Shared across every sister property, so it is
 *                 maintained once rather than N times — and it is still valid on
 *                 the day the entire local card goes bad.
 *
 * ## Why the master card is not "corporate"
 *
 * The instinct is to hang it off the management company. That fails at scale:
 * a company managing a hundred thousand units has a corporate office nobody
 * calls about one property. The useful durable contact is the **regional**, who
 * covers a handful of properties, survives site turnover, and actually knows the
 * asset. ZRS caps regionals at six properties; that is the relationship worth
 * recording.
 *
 * So the master card resolves to the **nearest ancestor that has contacts**, and
 * composes upward from there — regional first, corporate behind. If a property
 * hangs directly off a management company with no region between, the company is
 * the nearest ancestor and the card is the company's. The tree decides; nothing
 * is hardcoded to a level.
 *
 * ## The loop this creates
 *
 * When the local card goes stale, the master card is how you re-verify it. That
 * is the answer to the churn problem: not "keep the local card fresh forever",
 * which is impossible, but "always retain a durable route back to a fresh one."
 */
import { byAuthority } from './titles.js';

/**
 * How long each kind of card stays believable.
 *
 * Two clocks, because that is the entire point. A site roster six months old is
 * probably wrong; a regional six months old is probably still right.
 */
export const DEFAULT_FRESHNESS = {
  volatile: { fresh: 60, aging: 180 },   // days — the local card
  durable: { fresh: 180, aging: 540 },   // days — the master card
};

/**
 * @param {string|null} verifiedAt
 * @param {'volatile'|'durable'} kind
 * @param {{now?: number, thresholds?: typeof DEFAULT_FRESHNESS}} [opts]
 * @returns {{state: 'unverified'|'fresh'|'aging'|'stale', ageDays: number|null, verifiedAt: string|null}}
 */
export function freshnessOf(verifiedAt, kind, opts = {}) {
  if (!verifiedAt) return { state: 'unverified', ageDays: null, verifiedAt: null };

  const now = opts.now ?? Date.now();
  const thresholds = (opts.thresholds ?? DEFAULT_FRESHNESS)[kind] ?? DEFAULT_FRESHNESS.volatile;
  const ageDays = Math.floor((now - Date.parse(verifiedAt)) / 86_400_000);

  const state = ageDays <= thresholds.fresh ? 'fresh' : ageDays <= thresholds.aging ? 'aging' : 'stale';
  return { state, ageDays, verifiedAt };
}

/**
 * The most recent verification across a set of contacts. A card is only as
 * fresh as its freshest confirmation — one contact confirmed last week does not
 * make a two-year-old roster current, but it does mean somebody looked.
 * @param {{verifiedAt?: string}[]} contacts
 */
function latestVerification(contacts) {
  return (
    contacts
      .map((c) => c.verifiedAt)
      .filter(Boolean)
      .sort()
      .at(-1) ?? null
  );
}

/**
 * Build both cards for a property.
 *
 * @param {string} nodeId
 * @param {{tree: any, roster: any}} deps
 * @param {{now?: number, thresholds?: typeof DEFAULT_FRESHNESS, summarize?: (c: any) => any}} [opts]
 */
export function buildCards(nodeId, { tree, roster }, opts = {}) {
  const node = tree.resolve(nodeId);
  if (!node) return null;
  const summarize = opts.summarize ?? ((c) => c);

  // ── local ────────────────────────────────────────────────────────────────
  const here = byAuthority(roster.at(node.id));
  const office = here.find((c) => c.role === 'office') ?? null;
  const people = here.filter((c) => c.role !== 'office');

  const local = {
    kind: 'local',
    volatile: true,
    scope: { id: node.id, name: node.name, kind: node.kind },
    office: office ? summarize(office) : null,
    people: people.map(summarize),
    primary: people[0] ? summarize(people[0]) : null,
    ...freshnessOf(latestVerification(here), 'volatile', opts),
  };

  // ── master ───────────────────────────────────────────────────────────────
  // Walk up from the property. The nearest ancestor holding contacts names the
  // card; anything further up is composed behind it.
  const ancestors = tree.ancestors(node.id).reverse(); // nearest first
  let scope = null;
  /** @type {any[]} */
  const inherited = [];

  for (const ancestor of ancestors) {
    const contacts = roster.at(ancestor.id);
    if (!contacts.length) continue;
    scope ??= ancestor;
    // Nearest ancestor first, ranked by authority only WITHIN each level.
    //
    // Sorting the whole card by authority would put the corporate VP above the
    // regional, which is exactly backwards: at a company managing a hundred
    // thousand units, nobody calls the VP about one property. Proximity is what
    // makes a durable contact useful.
    inherited.push(
      ...byAuthority(contacts).map((c) => ({
        ...c,
        fromNode: { id: ancestor.id, name: ancestor.name, kind: ancestor.kind },
      })),
    );
  }

  const master = scope
    ? {
        kind: 'master',
        durable: true,
        scope: { id: scope.id, name: scope.name, kind: scope.kind },
        // The maintain-once win, made visible: one card, this many properties.
        sharedWith: tree.descendants(scope.id).filter((n) => n.kind === 'property' && n.status !== 'merged' && n.id !== node.id).length,
        people: inherited.map((c) => ({ ...summarize(c), fromNode: c.fromNode })),
        ...freshnessOf(latestVerification(inherited), 'durable', opts),
      }
    : null;

  return { local, master };
}

/**
 * Does this property need someone to go re-verify who works there?
 *
 * Returns the reason and, when there is one, the durable contact to call to fix
 * it — which is the whole reason the master card exists.
 *
 * @param {{local: any, master: any}} cards
 */
export function verificationNeeded(cards) {
  if (!cards) return null;
  const { local, master } = cards;

  const reasons = [];
  if (!local.office && !local.people.length) reasons.push('nobody on the local card');
  else if (local.state === 'stale') reasons.push(`local card not confirmed in ${local.ageDays} days`);
  else if (local.state === 'unverified') reasons.push('local card has never been confirmed');
  if (local.people.some((p) => p.status === 'unknown')) reasons.push('a local contact stopped responding');

  if (!reasons.length) return null;

  // The point of the two-card model: a dead local card is recoverable as long
  // as the durable one is intact.
  const routeBack = master?.people?.[0] ?? null;

  return {
    property: local.scope,
    reasons,
    routeBack: routeBack
      ? { via: routeBack, at: master.scope, note: `ask ${routeBack.name} who is on site now` }
      : null,
    recoverable: Boolean(routeBack),
  };
}
