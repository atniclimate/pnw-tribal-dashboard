// @ts-check
/**
 * Page-facing entry to maps, loaded by dynamic import() only after alerts-painted and a map request (blueprint 4.1, 4.6). Pages call requestMap; it probes support and calls createMap. DOM module.
 *
 * STUB (lane L0). Owner: lane L8. Signatures are the contract; bodies throw until the owner implements them.
 */

/** @typedef {import('../types.js').CreateMapOptions} CreateMapOptions */
/** @typedef {import('../types.js').CthdMap} CthdMap */

const NOT_IMPLEMENTED = 'not implemented';

/**
 * Waits for performance.mark('alerts-painted'), probes WebGL, and creates the map in the right mode.
 * @param {HTMLElement} frame
 * @param {CreateMapOptions} opts
 * @returns {Promise<CthdMap>}
 */
export async function requestMap(frame, opts) {
  throw new Error(NOT_IMPLEMENTED);
}

/**
 * Resolves once performance.mark('alerts-painted') exists.
 * @returns {Promise<void>}
 */
export async function whenAlertsPainted() {
  throw new Error(NOT_IMPLEMENTED);
}
