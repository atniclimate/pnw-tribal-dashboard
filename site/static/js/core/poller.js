// @ts-check
/**
 * Visibility-aware poller: pauses when hidden, backs off on failure up to ten minutes, resumes on online (blueprint 3.13). DOM module.
 *
 * STUB (lane L0). Owner: lane L2. Signatures are the contract; bodies throw until the owner implements them.
 */

/** @typedef {import('../types.js').Poller} Poller */
/** @typedef {import('../types.js').PollerOptions} PollerOptions */

const NOT_IMPLEMENTED = 'not implemented';

/**
 * @param {PollerOptions} opts
 * @returns {Poller}
 */
export function createPoller(opts) {
  throw new Error(NOT_IMPLEMENTED);
}
