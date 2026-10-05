// @ts-check
/**
 * CW3E IVT and IWV cycle resolution (blueprint 5.9, 7.3). Heavy: dynamic import() only. DOM-free.
 *
 * STUB (lane L0). Owner: lane L12. Signatures are the contract; bodies throw until the owner implements them.
 */
const NOT_IMPLEMENTED = 'not implemented';

/**
 * @param {string} template
 * @param {{ product: string, model: string, domain: string, cycle: string, fh: number }} parts
 * @returns {string}
 */
export function cw3eUrl(template, parts) {
  throw new Error(NOT_IMPLEMENTED);
}

/**
 * @param {unknown} manifest ar-products.json envelope
 * @param {Date} now
 * @returns {{ cycle: string, stale: boolean } | null}
 */
export function resolveCycleFromManifest(manifest, now) {
  throw new Error(NOT_IMPLEMENTED);
}

/**
 * Loads candidate images stepping back six hours when the manifest is stale.
 * @param {(cycle: string) => string} urlFor
 * @param {Date} now
 * @param {AbortSignal} [signal]
 * @returns {Promise<string | null>}
 */
export async function probeCycleInBrowser(urlFor, now, signal) {
  throw new Error(NOT_IMPLEMENTED);
}
