// @ts-check
/**
 * Zone geometry resolution by typed key (blueprint 3.7.5). Heavy: loaded by dynamic import() only when a
 * map is shown. DOM-free.
 *
 * Order: (1) the alert's own polygon is drawn by the caller and never reaches here; (2) each typed key is
 * looked up in the local `nws-zones.topo.json` index (decoded by the map module into a key-to-geometry
 * record); (3) a key missing locally is fetched from `api.weather.gov/zones/{type}/{id}` through the
 * caller's `fetchZone` (priority 3, cached), at most `maxFetches` per page view; (4) anything still
 * missing is returned in `missing`, and the list shows "Area shown as text; map outline unavailable."
 * Each zone is its own feature: no client-side union, holes kept as published.
 */
import { splitZoneKey } from './model.js';

/** @typedef {import('../types.js').ZoneKey} ZoneKey */
/** @typedef {import('../types.js').Geometry} Geometry */
/** @typedef {import('../types.js').Feature} Feature */

/**
 * Path parameters for `nws-zones-api` (`/zones/{type}/{id}`). Marine zones are served under the
 * forecast type, as the alerts' own `affectedZones` URLs show.
 * @param {ZoneKey} key
 * @returns {{ type: 'forecast' | 'county' | 'fire', id: string }}
 */
export function zoneApiParams(key) {
  const { type, code } = splitZoneKey(key);
  return { type: type === 'marine' ? 'forecast' : type, id: code };
}

/**
 * The polygon of a `/zones/{type}/{id}` response, or null when it has none.
 * @param {unknown} data
 * @returns {Geometry | null}
 */
export function zoneGeometryFromResponse(data) {
  if (typeof data !== 'object' || data === null) return null;
  const g = /** @type {{ geometry?: unknown }} */ (data).geometry;
  if (typeof g !== 'object' || g === null) return null;
  const t = /** @type {{ type?: unknown }} */ (g).type;
  if (t === 'Polygon' || t === 'MultiPolygon' || t === 'GeometryCollection') return /** @type {Geometry} */ (g);
  return null;
}

/**
 * Local nws-zones.topo.json first; api.weather.gov/zones fallback at priority 3, at most six per page view.
 * @param {ZoneKey[]} keys
 * @param {{ zonesIndex: Record<string, Geometry> | null, fetchZone: (key: ZoneKey) => Promise<Geometry | null>, maxFetches: number }} deps
 * @returns {Promise<{ features: Feature[], missing: ZoneKey[], fetched: number }>}
 */
export async function resolveZoneGeometry(keys, deps) {
  /** @type {Feature[]} */
  const features = [];
  /** @type {ZoneKey[]} */
  const missing = [];
  let fetched = 0;
  const seen = new Set();
  for (const key of keys) {
    if (seen.has(key)) continue;
    seen.add(key);
    const local = deps.zonesIndex && Object.prototype.hasOwnProperty.call(deps.zonesIndex, key) ? deps.zonesIndex[key] : undefined;
    if (local) {
      features.push({ type: 'Feature', id: key, properties: { zoneKey: key, basis: 'zone', origin: 'local' }, geometry: local });
      continue;
    }
    if (fetched >= deps.maxFetches) {
      missing.push(key);
      continue;
    }
    fetched += 1;
    /** @type {Geometry | null} */
    let geometry = null;
    try {
      geometry = await deps.fetchZone(key);
    } catch {
      geometry = null;
    }
    if (geometry) features.push({ type: 'Feature', id: key, properties: { zoneKey: key, basis: 'zone', origin: 'api' }, geometry });
    else missing.push(key);
  }
  return { features, missing, fetched };
}
