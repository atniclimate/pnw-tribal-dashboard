// @ts-check
/**
 * ECCC city page forecast for British Columbia Nations, with distance (blueprint 3.14). DOM-free.
 * Text is shown exactly as published by Environment and Climate Change Canada (licence: not altered).
 */
import { haversineKm } from '../core/geo.js';
import { getData } from '../core/sources.js';
import { isoOrNull } from './nws-forecast.js';

/** @typedef {import('../types.js').StatusSnapshot} StatusSnapshot */
/** @typedef {{ name: string, summary: string, temperatures: { value: number, unit: 'C' | 'F', kind: string }[] }} CityPeriod */

/** Half-width of the search box, in degrees, when a Nation record names no city page. */
export const SEARCH_HALF_DEGREES = 0.5;

/**
 * @param {unknown} json one feature or a feature collection
 * @returns {unknown}
 */
function firstFeature(json) {
  const j = /** @type {any} */ (json);
  if (j?.type === 'FeatureCollection') return Array.isArray(j.features) && j.features.length > 0 ? j.features[0] : null;
  return j ?? null;
}

/**
 * @param {unknown} json
 * @returns {{ asOf: string | null, asOfBasis: 'issued' | null }}
 */
function issued(json) {
  const f = /** @type {any} */ (firstFeature(json));
  const t = isoOrNull(f?.properties?.lastUpdated);
  return { asOf: t, asOfBasis: t ? 'issued' : null };
}

/**
 * @param {string} citypageId for example "bc-77"
 * @param {{ signal?: AbortSignal, now?: Date }} [opts]
 * @returns {Promise<{ data: unknown, status: StatusSnapshot }>}
 */
export async function loadCityPage(citypageId, opts = {}) {
  if (!/^[a-z]{2}-\d{1,4}$/.test(citypageId)) throw new Error(`Not a city page id: "${citypageId}"`);
  const res = await getData('eccc-citypage-realtime', { f: 'json', identifier: citypageId }, {
    ...(opts.signal ? { signal: opts.signal } : {}),
    ...(opts.now ? { now: opts.now } : {}),
    asOfOf: issued,
  });
  return { data: res.data ? firstFeature(res.data) : null, status: res.status };
}

/**
 * Text exactly as published by ECCC.
 * @param {unknown} feature
 * @returns {{ siteId: string, name: string, lastUpdated: string | null, periods: CityPeriod[] }}
 */
export function normalizeCityPage(feature) {
  const f = /** @type {any} */ (firstFeature(feature));
  const p = f?.properties ?? {};
  const forecasts = Array.isArray(p.forecastGroup?.forecasts) ? p.forecastGroup.forecasts : [];
  /** @type {CityPeriod[]} */
  const periods = [];
  for (const item of forecasts) {
    const name = item?.period?.textForecastName?.en;
    const summary = item?.textSummary?.en;
    /** @type {CityPeriod['temperatures']} */
    const temperatures = [];
    for (const reading of Array.isArray(item?.temperatures?.temperature) ? item.temperatures.temperature : []) {
      const value = reading?.value?.en; const unit = reading?.units?.en;
      if (typeof value === 'number' && Number.isFinite(value) && (unit === 'C' || unit === 'F')) temperatures.push({
        value, unit, kind: typeof reading?.class?.en === 'string' ? reading.class.en : 'temperature',
      });
    }
    if (typeof name === 'string' && typeof summary === 'string') periods.push({ name, summary, temperatures });
  }
  return {
    siteId: String(p.identifier ?? f?.id ?? ''),
    name: String(p.name?.en ?? ''),
    lastUpdated: isoOrNull(p.lastUpdated),
    periods,
  };
}

/**
 * The city page nearest a point, from a box query, with its distance. Used when a Nation record names none.
 * @param {[number, number]} latLon [lat, lon]
 * @param {{ signal?: AbortSignal, now?: Date }} [opts]
 * @returns {Promise<{ feature: unknown, distanceKm: number, status: StatusSnapshot } | { feature: null, distanceKm: null, status: StatusSnapshot }>}
 */
export async function findNearestCityPage(latLon, opts = {}) {
  const [lat, lon] = latLon;
  const d = SEARCH_HALF_DEGREES;
  const bbox = [lon - d, lat - d, lon + d, lat + d].map((n) => n.toFixed(3)).join(',');
  const res = await getData('eccc-citypage-realtime', { f: 'json', limit: 20, bbox }, {
    ...(opts.signal ? { signal: opts.signal } : {}),
    ...(opts.now ? { now: opts.now } : {}),
    asOfOf: issued,
  });
  const features = /** @type {any[]} */ (/** @type {any} */ (res.data)?.features ?? []);
  /** @type {{ feature: any, km: number } | null} */
  let best = null;
  for (const f of features) {
    const c = f?.geometry?.coordinates;
    if (!Array.isArray(c) || c.length < 2) continue;
    const km = haversineKm(latLon, [c[1], c[0]]);
    if (!best || km < best.km) best = { feature: f, km };
  }
  if (!best) return { feature: null, distanceKm: null, status: res.data ? { ...res.status, state: 'unavailable', asOf: null, asOfBasis: null, detail: 'No Environment and Climate Change Canada city forecast lies within about fifty kilometers of this headquarters.' } : res.status };
  return { feature: best.feature, distanceKm: best.km, status: res.status };
}

/**
 * "Forecast for {city}, {distance} km from {Nation} headquarters."
 * @param {string} city
 * @param {number} distanceKm
 * @param {string} nationName
 * @returns {string}
 */
export function cityForecastLabel(city, distanceKm, nationName) {
  return `Forecast for ${city}, ${Math.round(distanceKm)} km from ${nationName} headquarters.`;
}
