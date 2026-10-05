// @ts-check
/**
 * Bounded device last-good for direct-only sources: 200 KB per entry, 2 MB total, LRU, every call in try/catch (blueprint 3.13). DOM module (localStorage).
 *
 * STUB (lane L0). Owner: lane L2. Signatures are the contract; bodies throw until the owner implements them.
 */
const NOT_IMPLEMENTED = 'not implemented';

/**
 * @param {string} sourceId
 * @param {string} url
 * @returns {{ asOf: string, savedAt: string, data: unknown } | null}
 */
export function readLastGood(sourceId, url) {
  throw new Error(NOT_IMPLEMENTED);
}

/**
 * False when storage is blocked or the entry is too large.
 * @param {string} sourceId
 * @param {string} url
 * @param {{ asOf: string, data: unknown }} entry
 * @returns {boolean}
 */
export function writeLastGood(sourceId, url, entry) {
  throw new Error(NOT_IMPLEMENTED);
}

/**
 * Least-recently-used eviction to the 2 MB budget.
 * @returns {void}
 */
export function evictLastGood() {
  throw new Error(NOT_IMPLEMENTED);
}
