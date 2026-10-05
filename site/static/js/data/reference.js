// @ts-check
/**
 * Loader for committed reference files (data/ref, data/geo, data/registry) through core/net.js fetchLocal.
 * DOM-free. Successful loads are kept in memory for six hours: reference files change monthly.
 */
import { fetchLocal } from '../core/net.js';

const TTL_MS = 6 * 3_600_000;
const FILE = /^(?:ref|geo|registry)\/[A-Za-z0-9._\-/]+\.json$/;

/**
 * @param {string} file for example 'ref/hazards.json' or 'geo/footprint-ugc.json'
 * @param {{ signal?: AbortSignal }} [opts]
 * @returns {Promise<import('../types.js').NetResult>}
 */
export async function loadReference(file, opts = {}) {
  if (!FILE.test(file) || file.includes('..')) {
    return { ok: false, error: { kind: 'unregistered', message: 'Not a reference file path' }, fetchedAt: new Date().toISOString(), sourceId: `local:data/${file}` };
  }
  /** @type {import('../types.js').FetchOptions} */
  const o = { priority: 1, ttlMs: TTL_MS };
  if (opts.signal) o.signal = opts.signal;
  return fetchLocal(`data/${file}`, o);
}
