// @ts-check
/**
 * Flood category words and freshness (blueprint 5.5). DOM-free.
 *
 * STUB (lane L0). Owner: lane L7. Signatures are the contract; bodies throw until the owner implements them.
 */

/** @typedef {import('../types.js').FloodCategory} FloodCategory */

const NOT_IMPLEMENTED = 'not implemented';

/**
 * 'No flood categories defined for this gauge' for not_defined; never 'normal'.
 * @param {FloodCategory | 'out_of_service' | null} category
 * @returns {string}
 */
export function categoryLabel(category) {
  throw new Error(NOT_IMPLEMENTED);
}

/**
 * False when older than six hours ("Observation not current").
 * @param {string | null} validTime
 * @param {Date} now
 * @returns {boolean}
 */
export function isObservationCurrent(validTime, now) {
  throw new Error(NOT_IMPLEMENTED);
}
