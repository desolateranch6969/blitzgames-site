/**
 * Business profile: the *facts* the agent's replies must be consistent with.
 *
 * Kept strictly separate from the voice profile. Voice is how he sounds; this
 * is what is true. Swapping voices must never change a fee, and correcting a
 * fee must never require touching a phrase bank. Every fact here is optional —
 * anything left unset simply never gets asserted in a reply.
 */
import { createMarket } from './market.js';

/**
 * @typedef {Object} BusinessProfile
 * @property {string} agentName
 * @property {string} [brand]
 * @property {import('./market.js').Market} market
 * @property {Object} fees
 * @property {boolean} fees.freeToRenter          Locators are paid by the property, not the renter.
 * @property {string} [fees.explanation]
 * @property {Object} screening
 * @property {number} screening.incomeMultiple    Typical gross-income-to-rent multiple (commonly 3).
 * @property {Object} service
 * @property {string} [service.bookingUrl]
 * @property {string} [service.applicationUrl]
 * @property {string} [service.phone]
 * @property {string} [service.email]
 * @property {string} [service.website]
 * @property {Object} compliance
 * @property {string} [compliance.licenseDisclosure]  Required disclosure text, if the state requires one.
 * @property {boolean} compliance.requireGuestCard    Referral must be recorded before a tour.
 * @property {string[]} [compliance.extraDisclaimers]
 * @property {Object} hours
 * @property {number} hours.quietStart
 * @property {number} hours.quietEnd
 * @property {string} [hours.timezone]
 */

/** @type {BusinessProfile} */
const DEFAULTS = {
  agentName: 'the agent',
  brand: undefined,
  market: createMarket({ name: 'unset', areas: [] }),
  fees: {
    freeToRenter: true,
    explanation:
      'The property pays the locator fee, so the search costs the renter nothing.',
  },
  screening: {
    incomeMultiple: 3,
  },
  service: {},
  compliance: {
    licenseDisclosure: undefined,
    requireGuestCard: true,
    extraDisclaimers: [],
  },
  hours: { quietStart: 21, quietEnd: 8, timezone: 'America/Chicago' },
};

/**
 * @param {Partial<BusinessProfile>} overrides
 * @returns {BusinessProfile}
 */
export function createBusinessProfile(overrides = {}) {
  return {
    ...DEFAULTS,
    ...overrides,
    market: overrides.market ? createMarket(overrides.market) : DEFAULTS.market,
    fees: { ...DEFAULTS.fees, ...(overrides.fees ?? {}) },
    screening: { ...DEFAULTS.screening, ...(overrides.screening ?? {}) },
    service: { ...DEFAULTS.service, ...(overrides.service ?? {}) },
    compliance: { ...DEFAULTS.compliance, ...(overrides.compliance ?? {}) },
    hours: { ...DEFAULTS.hours, ...(overrides.hours ?? {}) },
  };
}
