// @ts-check
/**
 * WebGL2 capability probe before any library request (blueprint 4.6). DOM module.
 *
 * STUB (lane L0). Owner: lane L8. Signatures are the contract; bodies throw until the owner implements them.
 */

/** @typedef {import('../types.js').MapSupport} MapSupport */

const NOT_IMPLEMENTED = 'not implemented';

/**
 * 1 x 1 canvas, webgl2 with failIfMajorPerformanceCaveat, released at once: 'full', 'caveat', or 'none'.
 * @returns {MapSupport}
 */
export function probeWebGL() {
  throw new Error(NOT_IMPLEMENTED);
}

/**
 * @param {MapSupport} support
 * @param {{ lowData: boolean, requested: boolean }} opts
 * @returns {'interactive' | 'outline' | 'outline-offer-interactive'}
 */
export function chooseMode(support, opts) {
  throw new Error(NOT_IMPLEMENTED);
}
