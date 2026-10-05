// @ts-check
/**
 * Nation registry loaders (L5) and search ranking (L10) (blueprint 3.6). DOM-free.
 *
 * STUB (lane L0). Owner: lane L5. Signatures are the contract; bodies throw until the owner implements them.
 */

/** @typedef {import('../types.js').NationRecord} NationRecord */
/** @typedef {import('../types.js').NationIndexEntry} NationIndexEntry */
/** @typedef {import('../types.js').NationsIndex} NationsIndex */
/** @typedef {import('../types.js').IdRedirects} IdRedirects */

import { fetchLocal } from '../core/net.js';
import { isNationId, resolveNationId } from './ids.js';

const NOT_IMPLEMENTED = 'not implemented';

/**
 * data/registry/nations-index.json.
 * @param {{ signal?: AbortSignal }} [opts]
 * @returns {Promise<import('../types.js').NetResult<NationsIndex>>}
 */
export async function loadNationsIndex(opts) {
  const result = await fetchLocal('registry/nations-index.json', opts ?? {});
  return /** @type {import('../types.js').NetResult<NationsIndex>} */ (result);
}

/**
 * The redirect table (data/registry/id-redirects.json), or null when it cannot be loaded; a missing table
 * means no redirects, never a failure to load a Nation.
 * @param {{ signal?: AbortSignal }} [opts]
 * @returns {Promise<IdRedirects | null>}
 */
async function loadRedirects(opts) {
  const result = await fetchLocal('registry/id-redirects.json', opts ?? {});
  return result.ok ? /** @type {IdRedirects} */ (result.data) : null;
}

/**
 * data/registry/nations/<id>.json.
 * @param {string} id redirects applied first
 * @param {{ signal?: AbortSignal }} [opts]
 * @returns {Promise<import('../types.js').NetResult<NationRecord>>}
 */
export async function loadNation(id, opts) {
  const redirects = isNationId(id) ? await loadRedirects(opts) : null;
  let current = id;
  try {
    current = resolveNationId(id, redirects).id;
  } catch {
    current = id; // a malformed table never blocks a Nation that exists under its own id
  }
  if (!isNationId(current)) {
    return { ok: false, error: { kind: 'unregistered', message: `"${id}" is not a Nation id` }, fetchedAt: new Date().toISOString(), sourceId: 'cthd-registry' };
  }
  const result = await fetchLocal(`registry/nations/${current}.json`, opts ?? {});
  return /** @type {import('../types.js').NetResult<NationRecord>} */ (result);
}

/**
 * NFD with marks stripped; ʔ, 7, ’, ', and the ISC ? placeholder equivalent; case folded; whitespace collapsed. Matching only, never display.
 * @param {string} text
 * @returns {string}
 */
export function searchKey(text) {
  throw new Error(NOT_IMPLEMENTED);
}

/**
 * Exact alias, then token prefix on name and preferredName, then substring.
 * @param {NationIndexEntry[]} nations
 * @param {string} query
 * @returns {NationIndexEntry[]}
 */
export function searchNations(nations, query) {
  throw new Error(NOT_IMPLEMENTED);
}

/**
 * Full formal name first; preferredName second (display order pending Q4).
 * @param {NationIndexEntry | NationRecord} nation
 * @returns {{ primary: string, secondary: string | null }}
 */
export function displayName(nation) {
  throw new Error(NOT_IMPLEMENTED);
}
