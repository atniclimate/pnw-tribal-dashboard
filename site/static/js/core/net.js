// @ts-check
/**
 * Fetch with timeout, retry, priority, dedupe, and in-memory TTL (blueprint 3.2). The only place in site/ that calls fetch(). Never throws for network outcomes.
 *
 * STUB (lane L0). Owner: lane L2. Signatures are the contract; bodies throw until the owner implements them.
 */

/** @typedef {import('../types.js').FetchOptions} FetchOptions */

const NOT_IMPLEMENTED = 'not implemented';

/**
 * Never throws for network outcomes; every caller handles failure explicitly. Checks response.ok before parsing.
 * @param {string} sourceId registered source id; the URL comes from core/sources.js
 * @param {FetchOptions} [opts]
 * @returns {Promise<import('../types.js').NetResult>}
 */
export async function fetchJson(sourceId, opts) {
  throw new Error(NOT_IMPLEMENTED);
}

/**
 * As fetchJson, for text bodies (Area Forecast Discussion product text).
 * @param {string} sourceId
 * @param {FetchOptions} [opts]
 * @returns {Promise<import('../types.js').NetResult<string>>}
 */
export async function fetchText(sourceId, opts) {
  throw new Error(NOT_IMPLEMENTED);
}

/**
 * Follows pagination up to maxPages and reports truncation.
 * @param {string} sourceId
 * @param {FetchOptions} opts
 * @param {(data: unknown) => string | null} nextOf returns the next page URL (NWS pagination.next or an OGC next link) or null
 * @param {number} [maxPages] default 5
 * @returns {Promise<import('../types.js').PagedResult>}
 */
export async function fetchAllPages(sourceId, opts, nextOf, maxPages) {
  throw new Error(NOT_IMPLEMENTED);
}

/**
 * Same-origin data files only.
 * @param {string} path site-relative data path under data/registry, data/geo, data/ref, data/curated, or data/live
 * @param {FetchOptions} [opts]
 * @returns {Promise<import('../types.js').NetResult>}
 */
export async function fetchLocal(path, opts) {
  throw new Error(NOT_IMPLEMENTED);
}

/**
 * Drops the in-memory TTL cache (tests and Nation changes).
 * @returns {void}
 */
export function clearMemoryCache() {
  throw new Error(NOT_IMPLEMENTED);
}
