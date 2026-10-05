// @ts-check
/**
 * Designation from the event as issued (blueprint 3.8). DOM-free.
 *
 * STUB (lane L0). Owner: lane L3. Signatures are the contract; bodies throw until the owner implements them.
 */

/** @typedef {import('../types.js').Agency} Agency */
/** @typedef {import('../types.js').Designation} Designation */

const NOT_IMPLEMENTED = 'not implemented';

/**
 * Suffix rules: Emergency, Warning, Watch, Advisory, Statement; else other.
 * @param {string} event
 * @param {Agency} agency
 * @returns {Designation}
 */
export function designationOf(event, agency) {
  throw new Error(NOT_IMPLEMENTED);
}

/**
 * Solid for Emergency and Warning, outline for Watch, left bar for Advisory, text only for Statement.
 * @param {Designation} designation
 * @returns {'solid' | 'outline' | 'bar' | 'text'}
 */
export function designationShape(designation) {
  throw new Error(NOT_IMPLEMENTED);
}
