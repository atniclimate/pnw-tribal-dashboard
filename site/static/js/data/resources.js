// @ts-check
/**
 * Compiled resources (blueprint 5.6). DOM-free.
 *
 * STUB (lane L0). Owner: lane L13. Signatures are the contract; bodies throw until the owner implements them.
 */

/** @typedef {import('../types.js').Resource} Resource */

const NOT_IMPLEMENTED = 'not implemented';

/**
 * data/curated/resources.json.
 * @param {{ signal?: AbortSignal }} [opts]
 * @returns {Promise<import('../types.js').NetResult<Resource[]>>}
 */
export async function loadResources(opts) {
  throw new Error(NOT_IMPLEMENTED);
}

/**
 * Evergreen first; seasonal items only in season.
 * @param {Resource[]} items
 * @param {{ region?: string[], category?: string[], hazard?: string[], nationId?: string | null, q?: string }} filters
 * @param {Date} now
 * @returns {Resource[]}
 */
export function filterResources(items, filters, now) {
  throw new Error(NOT_IMPLEMENTED);
}
