// @ts-check
/**
 * Access mode as configuration (blueprint 3.12). Every URL in the browser comes from here. DOM-free.
 *
 * STUB (lane L0). Owner: lane L2. Signatures are the contract; bodies throw until the owner implements them.
 */

/** @typedef {import('../types.js').StatusSnapshot} StatusSnapshot */
/** @typedef {import('../types.js').FetchOptions} FetchOptions */
/** @typedef {import('../types.js').SourceRecord} SourceRecord */

const NOT_IMPLEMENTED = 'not implemented';

/**
 * Loads data/curated/sources.json once.
 * @param {AbortSignal} [signal]
 * @returns {Promise<void>}
 */
export async function loadSources(signal) {
  throw new Error(NOT_IMPLEMENTED);
}

/**
 * Throws on an unknown id (CAST registry invariant).
 * @param {string} id
 * @returns {SourceRecord}
 */
export function source(id) {
  throw new Error(NOT_IMPLEMENTED);
}

/**
 * Fills urlTemplate, encodes params, appends defaults.
 * @param {string} id
 * @param {Record<string, string | number | string[]>} [params]
 * @returns {string}
 */
export function url(id, params) {
  throw new Error(NOT_IMPLEMENTED);
}

/**
 * False for status 'candidate' unless config flag enableCandidateSources is on.
 * @param {string} id
 * @returns {boolean}
 */
export function isEnabled(id) {
  throw new Error(NOT_IMPLEMENTED);
}

/**
 * Resolves by access.mode: direct, direct+snapshot, snapshot, image, video, tiles, link, build.
 * @param {string} id
 * @param {Record<string, string | number | string[]>} [params]
 * @param {FetchOptions} [opts]
 * @returns {Promise<{ data: unknown, status: StatusSnapshot }>}
 */
export async function getData(id, params, opts) {
  throw new Error(NOT_IMPLEMENTED);
}
