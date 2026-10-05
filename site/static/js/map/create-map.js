// @ts-check
/**
 * The one place a MapLibre map is constructed (blueprint 4.1). Mounts the sovereignty note, attribution, and outline layer before resolving; switches to outline mode on GPU failure. DOM module.
 *
 * STUB (lane L0). Owner: lane L8. Signatures are the contract; bodies throw until the owner implements them.
 */

/** @typedef {import('../types.js').CreateMapOptions} CreateMapOptions */
/** @typedef {import('../types.js').CthdMap} CthdMap */

const NOT_IMPLEMENTED = 'not implemented';

/**
 * Throws if opts.sovereignty is missing or lists no source ids, in either mode.
 * @param {HTMLElement} frame
 * @param {CreateMapOptions} opts
 * @returns {Promise<CthdMap>}
 */
export async function createMap(frame, opts) {
  throw new Error(NOT_IMPLEMENTED);
}
