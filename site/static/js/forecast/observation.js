// @ts-check
/**
 * Current Conditions from a station observation, never from the first forecast period (blueprint 3.14). DOM-free.
 */
import { haversineKm } from '../core/geo.js';
import { getData } from '../core/sources.js';
import { isMissingReading } from '../core/units.js';
import { isoOrNull } from './nws-forecast.js';

/** @typedef {import('../types.js').StatusSnapshot} StatusSnapshot */

/** An observation older than this is not "current"; the panel then says there is none. */
export const MAX_OBSERVATION_AGE_MS = 3 * 3_600_000;
/** How many of the nearest stations are tried before the panel reports no current observation. */
export const MAX_STATIONS_TRIED = 3;

/**
 * @typedef {{
 *   stationId: string, stationName: string, observedAt: string, description: string | null,
 *   temperatureC: number, windKmh: number | null, windGustKmh: number | null, windDirectionDeg: number | null,
 *   humidityPercent: number | null, distanceKm: number | null
 * }} Observation
 */

/**
 * @param {unknown} q a NWS quantitative value
 * @param {string} unitCode the unit the value must carry
 * @returns {number | null} null for a missing value or another unit (never converted by guess)
 */
function quantity(q, unitCode) {
  const v = /** @type {any} */ (q);
  if (!v || v.unitCode !== unitCode) return null;
  return isMissingReading(v.value) ? null : /** @type {number} */ (v.value);
}

/**
 * @param {unknown} json observation feature
 * @param {{ now: Date, hq?: [number, number] }} ctx
 * @returns {Observation | null} null when it has no recent temperature
 */
export function normalizeObservation(json, ctx) {
  const p = /** @type {any} */ (json)?.properties;
  if (!p) return null;
  const observedAt = isoOrNull(p.timestamp);
  const temperatureC = quantity(p.temperature, 'wmoUnit:degC');
  if (!observedAt || temperatureC === null) return null;
  if (ctx.now.getTime() - Date.parse(observedAt) > MAX_OBSERVATION_AGE_MS) return null;
  const coords = /** @type {any} */ (json)?.geometry?.coordinates;
  const distanceKm = ctx.hq && Array.isArray(coords) && coords.length >= 2
    ? haversineKm(ctx.hq, [coords[1], coords[0]]) : null;
  return {
    stationId: String(p.stationId ?? ''),
    stationName: String(p.stationName ?? p.stationId ?? ''),
    observedAt,
    description: typeof p.textDescription === 'string' && p.textDescription ? p.textDescription : null,
    temperatureC,
    windKmh: quantity(p.windSpeed, 'wmoUnit:km_h-1'),
    windGustKmh: quantity(p.windGust, 'wmoUnit:km_h-1'),
    windDirectionDeg: quantity(p.windDirection, 'wmoUnit:degree_(angle)'),
    humidityPercent: quantity(p.relativeHumidity, 'wmoUnit:percent'),
    distanceKm,
  };
}

/**
 * Station identifiers from a stations list, in the published (nearest first) order.
 * @param {unknown} json
 * @returns {string[]}
 */
export function stationIds(json) {
  const features = /** @type {any} */ (json)?.features;
  if (!Array.isArray(features)) return [];
  return features
    .map((f) => f?.properties?.stationIdentifier)
    .filter((s) => typeof s === 'string' && /^[A-Za-z0-9]{3,8}$/.test(s));
}

/**
 * @param {{ wfo: string, x: number, y: number }} grid
 * @param {[number, number]} hq [lat, lon]
 * @param {{ signal?: AbortSignal, now?: Date }} [opts]
 * @returns {Promise<{ observation: Observation | null, status: StatusSnapshot }>}
 */
export async function loadCurrentObservation(grid, hq, opts = {}) {
  const now = opts.now ?? new Date();
  const base = opts.signal ? { signal: opts.signal } : {};
  const list = await getData('nws-stations', { wfo: grid.wfo, x: grid.x, y: grid.y }, { ...base, ttlMs: 3_600_000, now });
  if (!list.data) return { observation: null, status: { ...list.status, sourceIds: ['nws-observations'] } };
  const ids = stationIds(list.data).slice(0, MAX_STATIONS_TRIED);
  /** @type {StatusSnapshot | null} */
  let lastStatus = null;
  for (const station of ids) {
    const res = await getData('nws-observations', { station }, { ...base, now,
      asOfOf: (d) => {
        const t = isoOrNull(/** @type {any} */ (d)?.properties?.timestamp);
        return { asOf: t, asOfBasis: t ? 'observed' : null };
      } });
    lastStatus = res.status;
    if (!res.data) continue;
    const observation = normalizeObservation(res.data, { now, hq });
    if (observation) return { observation, status: res.status };
  }
  return {
    observation: null,
    status: lastStatus ?? { ...list.status, sourceIds: ['nws-observations'] },
  };
}
