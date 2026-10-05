// @ts-check
/**
 * GOES-18 Pacific Northwest sector stills and MP4 animations (blueprint 7.3). DOM-free.
 *
 * STUB (lane L0). Owner: lane L12. Signatures are the contract; bodies throw until the owner implements them.
 */
const NOT_IMPLEMENTED = 'not implemented';

/**
 * Lowercase /pnw/ sector path only.
 * @param {string} product
 * @param {300 | 600} size
 * @returns {string}
 */
export function goesStillUrl(product, size) {
  throw new Error(NOT_IMPLEMENTED);
}

/**
 * Null for Bands 09 and 10 (stills only).
 * @param {string} product
 * @returns {string | null}
 */
export function goesAnimationUrl(product) {
  throw new Error(NOT_IMPLEMENTED);
}
