// @ts-check
/**
 * Water Survey of Canada realtime (no invented categories). DOM-free.
 *
 * Owner: lane L7. Level is metres and discharge is cubic metres per second, as ECCC publishes them.
 */

/** @typedef {import('../types.js').GaugeStatus} GaugeStatus */

const STATION_RE = /^[0-9]{2}[A-Z]{2}[0-9]{3}$/;

/**
 * @param {unknown} v
 * @returns {number | null}
 */
function reading(v) {
  return typeof v === 'number' && Number.isFinite(v) && v > -990 ? v : null;
}

/**
 * Latest reading per station; stages and categories are never invented (category is always null).
 * @param {unknown} json
 * @param {{ fetchedAt: string }} ctx
 * @returns {GaugeStatus[]}
 */
export function normalizeWscRealtime(json, ctx) {
  const features = json && typeof json === 'object' ? /** @type {{ features?: unknown }} */ (json).features : null;
  if (!Array.isArray(features)) throw new Error('ECCC hydrometric realtime: "features" array missing');
  /** @type {Map<string, { time: number, iso: string, level: number | null, discharge: number | null }>} */
  const latest = new Map();
  for (const f of features) {
    const p = f?.properties;
    if (!p || typeof p.STATION_NUMBER !== 'string' || !STATION_RE.test(p.STATION_NUMBER)) continue;
    const iso = typeof p.DATETIME === 'string' ? p.DATETIME : '';
    const time = Date.parse(iso);
    if (!Number.isFinite(time)) continue;
    const prev = latest.get(p.STATION_NUMBER);
    if (!prev || time > prev.time) latest.set(p.STATION_NUMBER, { time, iso, level: reading(p.LEVEL), discharge: reading(p.DISCHARGE) });
  }
  return [...latest.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([station, r]) => ({
      id: `wsc:${station}`,
      observed: { stage: r.level, unit: r.level === null ? null : 'm', flow: r.discharge, flowUnit: r.discharge === null ? null : 'm3/s', category: null, validTime: r.iso },
      forecast: null,
    }));
}

/**
 * Approximate IANA zone for a British Columbia station by position. A heuristic for display only; the
 * Nation's own zone (registry) governs a Nation panel, and boundary cases need maintainer review.
 * @param {number} lat
 * @param {number} lon
 * @returns {string}
 */
export function bcTimeZone(lat, lon) {
  if (lat >= 57.3 && lon >= -123.5 && lon <= -121.5) return 'America/Fort_Nelson';
  if (lat >= 55 && lon >= -122.5 && lon <= -119.5) return 'America/Dawson_Creek';
  if (lon >= -116.9) return 'America/Edmonton';
  return 'America/Vancouver';
}

export const WSC_THRESHOLD_NOTE = 'No official flood thresholds are published for this station; see BC River Forecast Centre advisories.';

/**
 * Station list to reference records; active real-time stations only; no stages, no categories.
 * `ctx.wateroffice` is the station page pattern with a {station} placeholder (the reference build owns the host).
 * @param {unknown} json
 * @param {{ wateroffice?: string }} [ctx]
 * @returns {{ id: string, name: string, lat: number, lon: number, region: 'bc', timeZone: string,
 *   links: Record<string, string>, stages: null, thresholdNote: string, nationIds: string[] }[]}
 */
export function normalizeWscStations(json, ctx) {
  const features = json && typeof json === 'object' ? /** @type {{ features?: unknown }} */ (json).features : null;
  if (!Array.isArray(features)) throw new Error('ECCC hydrometric stations: "features" array missing');
  const seen = new Set();
  const out = [];
  for (const f of features) {
    const p = f?.properties;
    const c = f?.geometry?.coordinates;
    if (!p || typeof p.STATION_NUMBER !== 'string' || !STATION_RE.test(p.STATION_NUMBER)) continue;
    if (p.PROV_TERR_STATE_LOC !== 'BC' || p.STATUS_EN !== 'Active' || p.REAL_TIME !== 1) continue;
    if (!Array.isArray(c) || typeof c[0] !== 'number' || typeof c[1] !== 'number') continue;
    if (seen.has(p.STATION_NUMBER)) continue;
    seen.add(p.STATION_NUMBER);
    const [lon, lat] = c;
    out.push({
      id: `wsc:${p.STATION_NUMBER}`,
      name: String(p.STATION_NAME ?? p.STATION_NUMBER).trim(),
      lat: Math.round(lat * 1e5) / 1e5,
      lon: Math.round(lon * 1e5) / 1e5,
      region: /** @type {'bc'} */ ('bc'),
      timeZone: bcTimeZone(lat, lon),
      links: ctx?.wateroffice ? { wateroffice: ctx.wateroffice.replace('{station}', p.STATION_NUMBER) } : {},
      stages: null,
      thresholdNote: WSC_THRESHOLD_NOTE,
      nationIds: [],
    });
  }
  return out.sort((a, b) => (a.id < b.id ? -1 : 1));
}
