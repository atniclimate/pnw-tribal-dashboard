// @ts-check
/**
 * The Nation the forecasts page is showing: its headquarters point, time zone, and unit system, read from the
 * committed registry files (never from a person's device). DOM-free.
 */
import { fetchLocal } from '../core/net.js';
import { unitSystemFor } from '../core/units.js';

/** @typedef {import('../types.js').NationRecord} NationRecord */

/**
 * @typedef {{
 *   id: string, name: string, country: 'US' | 'CA', hq: [number, number], timeZone: string, units: 'us' | 'metric',
 *   eccc: NationRecord['eccc'], radar: NationRecord['radar'], gauges: string[], record: NationRecord
 * }} NationContext
 */

/**
 * @param {unknown} record a data/registry/nations/<id>.json document
 * @returns {NationContext | null} null when the record lacks a headquarters point or a time zone
 */
export function nationContextFrom(record) {
  const r = /** @type {any} */ (record);
  if (!r || typeof r.id !== 'string' || typeof r.name !== 'string') return null;
  const lat = r.hq?.lat;
  const lon = r.hq?.lon;
  if (typeof lat !== 'number' || typeof lon !== 'number' || typeof r.timeZone !== 'string') return null;
  return {
    id: r.id, name: r.name, country: r.country === 'CA' ? 'CA' : 'US', hq: [lat, lon], timeZone: r.timeZone,
    units: r.units === 'metric' ? 'metric' : 'us', eccc: r.eccc ?? null, radar: r.radar ?? { nexrad: null, ridgeLoop: null, eccc: null },
    gauges: Array.isArray(r.gauges) ? r.gauges : [], record: /** @type {NationRecord} */ (r),
  };
}

/**
 * @param {string} id
 * @param {{ signal?: AbortSignal }} [opts]
 * @returns {Promise<NationContext | null>}
 */
export async function loadNationContext(id, opts = {}) {
  const res = await fetchLocal(`data/registry/nations/${encodeURIComponent(id)}.json`, { priority: 1, ttlMs: 6 * 3_600_000, ...(opts.signal ? { signal: opts.signal } : {}) });
  return res.ok ? nationContextFrom(res.data) : null;
}

/**
 * Every Nation, by full formal name, for the selector.
 * @param {{ signal?: AbortSignal }} [opts]
 * @returns {Promise<{ id: string, name: string }[]>}
 */
export async function loadNationOptions(opts = {}) {
  const res = await fetchLocal('data/registry/nations-index.json', { priority: 2, ttlMs: 6 * 3_600_000, ...(opts.signal ? { signal: opts.signal } : {}) });
  const list = res.ok ? /** @type {any} */ (res.data)?.nations : null;
  if (!Array.isArray(list)) return [];
  return list.map((/** @type {any} */ n) => ({ id: String(n.id), name: String(n.name) })).sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Nation default, overridden by units= or a stored preference; native when no Nation.
 * @param {NationContext | null} nation
 * @param {'us' | 'metric' | null} override
 * @returns {'us' | 'metric' | 'native'}
 */
export function systemFor(nation, override) {
  return unitSystemFor(nation ? nation.units : null, override);
}
