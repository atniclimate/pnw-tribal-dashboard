// @ts-check
/**
 * Loader for committed reference files (data/ref, data/geo) through core/net.js fetchLocal. DOM-free.
 *
 * STUB (lane L0). Owner: lane L2. Signatures are the contract; bodies throw until the owner implements them.
 */
const NOT_IMPLEMENTED = 'not implemented';

/**
 * @param {string} file for example 'ref/hazards.json' or 'geo/footprint-ugc.json'
 * @param {{ signal?: AbortSignal }} [opts]
 * @returns {Promise<import('../types.js').NetResult>}
 */
export async function loadReference(file, opts) {
  throw new Error(NOT_IMPLEMENTED);
}
