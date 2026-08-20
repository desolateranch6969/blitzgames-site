/**
 * Market configuration: the neighborhoods this agent works.
 *
 * Deliberately data, not code. The engine ships knowing no city. Hand it a
 * market file and it understands that city's areas; hand it a different one and
 * it works there instead. A future portal module edits these objects directly.
 *
 * @typedef {Object} MarketArea
 * @property {string} name              Canonical display name.
 * @property {string[]} [aliases]       How people actually type it in a DM.
 * @property {string[]} [zips]
 * @property {string} [note]            Internal only; never sent to a lead.
 *
 * @typedef {Object} Market
 * @property {string} name
 * @property {string} [metro]
 * @property {MarketArea[]} areas
 */

/** @type {Market} */
export const EMPTY_MARKET = { name: 'unset', areas: [] };

/**
 * @param {Partial<Market>} config
 * @returns {Market}
 */
export function createMarket(config = {}) {
  return {
    name: config.name ?? EMPTY_MARKET.name,
    metro: config.metro,
    areas: (config.areas ?? []).map((a) => ({
      name: a.name,
      aliases: a.aliases ?? [],
      zips: a.zips ?? [],
      note: a.note,
    })),
  };
}

/**
 * Resolve a lead-typed area string back to a canonical area, if we know it.
 * @param {Market} market
 * @param {string} input
 */
export function resolveArea(market, input) {
  const needle = String(input).toLowerCase().trim();
  return (
    market.areas.find(
      (a) =>
        a.name.toLowerCase() === needle ||
        (a.aliases ?? []).some((x) => x.toLowerCase() === needle) ||
        (a.zips ?? []).includes(needle),
    ) ?? null
  );
}
