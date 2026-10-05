// @ts-check
/**
 * NWS point forecast: 14 periods labeled 7-Day; Current Conditions only from an observation (blueprint 3.14). DOM-free.
 *
 * Every request names a registered source (core/sources.js getData), so the registry's headers, timeouts,
 * and device last-good apply. A period list is shown as published; nothing is inferred or filled in.
 */
import { APP } from '../config/app.js';
import { getData } from '../core/sources.js';

/** @typedef {import('../types.js').StatusSnapshot} StatusSnapshot */
/** @typedef {import('../types.js').ForecastPeriod} ForecastPeriod */

/** The label for the full period list (the May 2026 page labeled four or five days with it). */
export const FORECAST_LABEL = '7-Day Forecast';

/**
 * @typedef {{
 *   wfo: string, x: number, y: number, timeZone: string | null, radarStation: string | null,
 *   city: string | null, state: string | null
 * }} NwsPoint
 */

/**
 * @param {number} n
 * @returns {string} at most four decimals, as NWS requires (more digits cause a redirect)
 */
function coordText(n) {
  return String(Math.round(n * 10_000) / 10_000);
}

/**
 * ISO 8601 with an offset to canonical UTC, or null.
 * @param {unknown} value
 * @returns {string | null}
 */
export function isoOrNull(value) {
  if (typeof value !== 'string') return null;
  const t = Date.parse(value);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

/**
 * Reads the grid cell, zone, and radar station out of a /points response. Null when the response lacks a grid.
 * @param {unknown} json
 * @returns {NwsPoint | null}
 */
export function parsePoint(json) {
  const p = /** @type {any} */ (json)?.properties;
  if (!p || typeof p.gridId !== 'string' || !Number.isInteger(p.gridX) || !Number.isInteger(p.gridY)) return null;
  const rel = p.relativeLocation?.properties;
  return {
    wfo: p.gridId,
    x: p.gridX,
    y: p.gridY,
    timeZone: typeof p.timeZone === 'string' ? p.timeZone : null,
    radarStation: typeof p.radarStation === 'string' ? p.radarStation : null,
    city: typeof rel?.city === 'string' ? rel.city : null,
    state: typeof rel?.state === 'string' ? rel.state : null,
  };
}

/**
 * /points, held in memory for one hour.
 * @param {[number, number]} latLon [lat, lon]
 * @param {{ signal?: AbortSignal }} [opts]
 * @returns {Promise<{ point: NwsPoint | null, status: StatusSnapshot }>}
 */
export async function loadPoint(latLon, opts = {}) {
  const res = await getData('nws-points', { lat: coordText(latLon[0]), lon: coordText(latLon[1]) }, {
    ttlMs: APP.net.pointsTtlMs,
    ...(opts.signal ? { signal: opts.signal } : {}),
  });
  return { point: res.data ? parsePoint(res.data) : null, status: res.status };
}

/**
 * /points (one-hour cache), then forecast.
 * @param {[number, number]} latLon
 * @param {{ signal?: AbortSignal }} [opts]
 * @returns {Promise<{ periods: ForecastPeriod[], office: string | null, status: StatusSnapshot, point: NwsPoint | null, updateTime: string | null }>}
 */
export async function loadPointForecast(latLon, opts = {}) {
  const { point, status: pointStatus } = await loadPoint(latLon, opts);
  if (!point) {
    const reason = pointStatus.state === 'unavailable'
      ? (pointStatus.detail ?? 'The forecast grid could not be found.')
      : 'The National Weather Service returned no forecast grid for this location.';
    return {
      periods: [], office: null, point: null, updateTime: null,
      status: { ...pointStatus, state: 'unavailable', asOf: null, asOfBasis: null, detail: reason, sourceIds: ['nws-forecast'] },
    };
  }
  const res = await getData('nws-forecast', { wfo: point.wfo, x: point.x, y: point.y }, {
    ...(opts.signal ? { signal: opts.signal } : {}),
    asOfOf: (d) => {
      const t = isoOrNull(/** @type {any} */ (d)?.properties?.updateTime);
      return { asOf: t, asOfBasis: t ? 'issued' : null, completeness: normalizeForecastPeriods(d).length >= 14 ? 'complete' : 'partial' };
    },
  });
  return {
    periods: res.data ? normalizeForecastPeriods(res.data) : [],
    office: point.wfo,
    point,
    updateTime: isoOrNull(/** @type {any} */ (res.data)?.properties?.updateTime),
    status: res.status,
  };
}

/**
 * Fields are copied as published. A period missing its name or times is skipped, never repaired.
 * @param {unknown} json forecast response (GeoJSON feature) or its properties
 * @returns {ForecastPeriod[]}
 */
export function normalizeForecastPeriods(json) {
  const root = /** @type {any} */ (json);
  const list = root?.properties?.periods ?? root?.periods;
  if (!Array.isArray(list)) return [];
  /** @type {ForecastPeriod[]} */
  const out = [];
  for (const p of list) {
    if (!p || typeof p.name !== 'string' || typeof p.startTime !== 'string' || typeof p.endTime !== 'string') continue;
    const pop = p.probabilityOfPrecipitation?.value;
    out.push({
      name: p.name,
      startTime: p.startTime,
      endTime: p.endTime,
      isDaytime: p.isDaytime === true,
      temperature: typeof p.temperature === 'number' && Number.isFinite(p.temperature) ? p.temperature : null,
      temperatureUnit: p.temperatureUnit === 'C' ? 'C' : 'F',
      windSpeed: typeof p.windSpeed === 'string' && p.windSpeed ? p.windSpeed : null,
      windDirection: typeof p.windDirection === 'string' && p.windDirection ? p.windDirection : null,
      shortForecast: typeof p.shortForecast === 'string' ? p.shortForecast : '',
      detailedForecast: typeof p.detailedForecast === 'string' ? p.detailedForecast : '',
      probabilityOfPrecipitation: typeof pop === 'number' && Number.isFinite(pop) ? pop : null,
    });
  }
  return out;
}
