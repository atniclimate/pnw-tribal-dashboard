// @ts-check
/**
 * Port of @ewm/core-status (STATUS_STATES, validateSnapshot, createStatusRegistry, stateFromAge) extended with deriveStatus and the two dashboard rules: sourceIds non-empty, and asOfBasis set whenever asOf is set (blueprint 3.3).
 *
 * STUB (lane L0). Owner: lane L2. Signatures are the contract; bodies throw until the owner implements them.
 */

/** @typedef {import('../types.js').StatusState} StatusState */
/** @typedef {import('../types.js').StatusSnapshot} StatusSnapshot */
/** @typedef {import('../types.js').FreshnessPolicy} FreshnessPolicy */
/** @typedef {import('../types.js').StatusRegistry} StatusRegistry */
/** @typedef {import('../types.js').StatusInputs} StatusInputs */

const NOT_IMPLEMENTED = 'not implemented';

/** The five honest states, in CAST order. @type {readonly StatusState[]} */
export const STATUS_STATES = Object.freeze(/** @type {StatusState[]} */ (['live', 'cached', 'stale', 'degraded', 'unavailable']));

/**
 * Problems with a snapshot; empty means valid. CAST rules plus the two dashboard rules.
 * @param {StatusSnapshot} snapshot
 * @returns {string[]}
 */
export function validateSnapshot(snapshot) {
  throw new Error(NOT_IMPLEMENTED);
}

/**
 * Registry of panel statuses; throws on unknown ids and dishonest snapshots (CAST semantics).
 * @returns {StatusRegistry}
 */
export function createStatusRegistry() {
  throw new Error(NOT_IMPLEMENTED);
}

/**
 * CAST stateFromAge, unchanged.
 * @param {string} asOf
 * @param {Date} now
 * @param {FreshnessPolicy} policy
 * @returns {'live' | 'stale' | 'degraded'}
 */
export function stateFromAge(asOf, now, policy) {
  throw new Error(NOT_IMPLEMENTED);
}

/**
 * Encodes every row of the blueprint 3.3 status table, including the detail text.
 * @param {StatusInputs} inputs
 * @returns {StatusSnapshot}
 */
export function deriveStatus(inputs) {
  throw new Error(NOT_IMPLEMENTED);
}
