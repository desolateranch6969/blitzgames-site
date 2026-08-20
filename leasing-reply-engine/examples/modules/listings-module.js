/**
 * Example bolt-on: listing search.
 *
 * This is the whole point of the capability registry. Without this module the
 * engine promises to send a list by hand ("let me pull a few and send them
 * over"). Register it and the exact same conversation starts returning real
 * units — the planner was already asking whether anyone could do this.
 *
 * Nothing in src/ changes to add it. Swap the fake index below for an MLS feed,
 * a property database, or a scraper and the behavior is identical.
 */
export function createListingsModule({ inventory = SAMPLE_INVENTORY } = {}) {
  return {
    name: 'listings',
    version: '0.1.0',
    provides: ['listings.search'],

    setup(ctx) {
      ctx.provide('listings.search', async ({ slots, limit = 3 }) => {
        const matches = inventory
          .filter((unit) => matchesBeds(unit, slots))
          .filter((unit) => matchesBudget(unit, slots))
          .filter((unit) => matchesArea(unit, slots))
          .filter((unit) => matchesPets(unit, slots))
          .sort((a, b) => (a.rentMin ?? 0) - (b.rentMin ?? 0));

        ctx.logger.info('listing search', { matches: matches.length, beds: slots.beds });
        return matches.slice(0, limit);
      });

      // The engine announces when a lead is complete enough to search for.
      ctx.bus.on(ctx.EVENTS.LEAD_QUALIFIED, ({ summary }) => {
        ctx.logger.info('lead ready for a list', { thread: summary.threadId, budget: summary.budget });
      });
    },
  };
}

function matchesBeds(unit, slots) {
  return slots.beds == null || unit.beds === slots.beds;
}

function matchesBudget(unit, slots) {
  const max = slots.budget?.max;
  const min = slots.budget?.min;
  if (max != null && (unit.rentMin ?? 0) > max) return false;
  if (min != null && (unit.rentMax ?? Infinity) < min) return false;
  return true;
}

function matchesArea(unit, slots) {
  const areas = slots.areas ?? [];
  if (!areas.length) return true;
  return areas.some((a) => unit.area.toLowerCase().includes(String(a).toLowerCase()) || (unit.zips ?? []).includes(a));
}

function matchesPets(unit, slots) {
  if (!slots.pets?.has) return true;
  if (slots.pets.kind === 'assistance_animal') return true; // never filtered as a pet
  if (!unit.petFriendly) return false;
  if (slots.pets.weightLb && unit.petWeightLimitLb && slots.pets.weightLb > unit.petWeightLimitLb) return false;
  return true;
}

/** Stand-in inventory. Replace with a real feed. */
export const SAMPLE_INVENTORY = [
  { name: 'The Maple', area: 'uptown', zips: ['75204'], beds: 2, baths: 2, rentMin: 1795, rentMax: 1950, special: '4 weeks free', petFriendly: true, petWeightLimitLb: 75 },
  { name: 'Bishop Flats', area: 'downtown', zips: ['75201'], beds: 2, baths: 2, rentMin: 1850, rentMax: 2100, special: null, petFriendly: true, petWeightLimitLb: 50 },
  { name: 'Cedar Row', area: 'uptown', zips: ['75204'], beds: 1, baths: 1, rentMin: 1295, rentMax: 1400, special: '1 month free', petFriendly: false },
  { name: 'Lark House', area: 'uptown', zips: ['75219'], beds: 2, baths: 2, rentMin: 1975, rentMax: 2200, special: 'look and lease $500 off', petFriendly: true, petWeightLimitLb: 100 },
];
