// @ts-check
/**
 * The May 2026 gridpoint QPF aggregator, ported with Nation-zone day keys and hourly splitting (blueprint 3.14). DOM-free.
 *
 * STUB (lane L0). Owner: lane L12. Signatures are the contract; bodies throw until the owner implements them.
 */

/** @typedef {import('../types.js').QpfDay} QpfDay */

const NOT_IMPLEMENTED = 'not implemented';

/**
 * Preserves ISO 8601 durations, proportional distribution, mm to in by WMO unit, max PoP per day, and the partial Today label.
 * @param {unknown} props forecastGridData properties
 * @param {string} timeZone
 * @param {Date} now
 * @returns {QpfDay[]}
 */
export function aggregateGridpointDaily(props, timeZone, now) {
  throw new Error(NOT_IMPLEMENTED);
}
