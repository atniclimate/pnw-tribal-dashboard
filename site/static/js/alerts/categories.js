// @ts-check
/**
 * Hazard categories from exact-name tables, then ordered fallback rules (blueprint 3.9). DOM-free.
 *
 * STUB (lane L0). Owner: lane L3. Signatures are the contract; bodies throw until the owner implements them.
 */

/** @typedef {import('../types.js').Agency} Agency */
/** @typedef {import('../types.js').HazardCategory} HazardCategory */

const NOT_IMPLEMENTED = 'not implemented';

/**
 * First entry is primary; unknown names use fallback rules specific before general.
 * @param {string} event
 * @param {Agency} agency
 * @param {{ nws: Record<string, HazardCategory[]>, eccc: Record<string, HazardCategory[]> }} tables
 * @returns {HazardCategory[]}
 */
export function categorize(event, agency, tables) {
  throw new Error(NOT_IMPLEMENTED);
}
