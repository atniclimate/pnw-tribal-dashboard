// @ts-check
/**
 * Registers site/sw.js only in top-level contexts on https (blueprint 8.4); L9 owns the worker. DOM module.
 *
 * STUB (lane L0). Owner: lane L2. Signatures are the contract; bodies throw until the owner implements them.
 */
const NOT_IMPLEMENTED = 'not implemented';

/**
 * Never registers inside an iframe; honors build-info swDisabled.
 * @param {{ scriptUrl: string }} opts
 * @returns {Promise<boolean>}
 */
export async function registerServiceWorker(opts) {
  throw new Error(NOT_IMPLEMENTED);
}
