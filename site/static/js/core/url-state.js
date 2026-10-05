// @ts-check
/**
 * URL as state: query string, unknown keys preserved, id-redirects applied to n= (blueprint 3.5).
 *
 * STUB (lane L0). Owner: lane L2. Signatures are the contract; bodies throw until the owner implements them.
 */

/** @typedef {import('../types.js').UrlStateSchema} UrlStateSchema */
/** @typedef {import('../types.js').UrlState} UrlState */

const NOT_IMPLEMENTED = 'not implemented';

/**
 * Pure parser: typed values; invalid values dropped.
 * @param {string} search
 * @param {UrlStateSchema} schema
 * @returns {UrlState}
 */
export function parseQuery(search, schema) {
  throw new Error(NOT_IMPLEMENTED);
}

/**
 * Pure serializer; stable key order.
 * @param {UrlState} state
 * @param {string} [baseSearch] existing query whose unknown keys are preserved
 * @returns {string}
 */
export function serializeQuery(state, baseSearch) {
  throw new Error(NOT_IMPLEMENTED);
}

/**
 * parseQuery over location.search.
 * @param {UrlStateSchema} schema
 * @returns {UrlState}
 */
export function readState(schema) {
  throw new Error(NOT_IMPLEMENTED);
}

/**
 * Merges a patch into the URL.
 * @param {UrlState} patch
 * @param {{ push?: boolean }} [opts] replaceState for filters (default); pushState for Nation and view
 * @returns {void}
 */
export function writeState(patch, opts) {
  throw new Error(NOT_IMPLEMENTED);
}

/**
 * popstate and programmatic writes.
 * @param {(state: URLSearchParams) => void} fn
 * @returns {() => void}
 */
export function onStateChange(fn) {
  throw new Error(NOT_IMPLEMENTED);
}

/**
 * A link that carries the kept keys.
 * @param {string} href
 * @param {string[]} [keep] default ['n', 'embed', 'units', 'lowdata']
 * @returns {string}
 */
export function linkWithState(href, keep) {
  throw new Error(NOT_IMPLEMENTED);
}
