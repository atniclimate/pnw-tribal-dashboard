// @ts-check
/**
 * Radar helpers: nearest RIDGE site by haversine, IEM valid time, five-minute tile bucket (blueprint 4.4, 7.3). DOM-free.
 * The legacy page picked a site by raw degree difference; this uses great-circle distance over real site coordinates.
 */
import { haversineKm } from '../core/geo.js';

const FIVE_MIN_MS = 300_000;

/**
 * @param {[number, number]} latLon [lat, lon]
 * @param {{ id: string, lat: number, lon: number }[]} sites
 * @returns {{ id: string, distanceKm: number } | null}
 */
export function nearestRadarSite(latLon, sites) {
  /** @type {{ id: string, distanceKm: number } | null} */
  let best = null;
  for (const s of sites) {
    if (!Number.isFinite(s.lat) || !Number.isFinite(s.lon)) continue;
    const distanceKm = haversineKm(latLon, [s.lat, s.lon]);
    if (!best || distanceKm < best.distanceKm) best = { id: s.id, distanceKm };
  }
  return best;
}

/**
 * meta.valid as ISO, or null.
 * @param {unknown} json n0q_0.json
 * @returns {string | null}
 */
export function iemValidTime(json) {
  const v = /** @type {any} */ (json)?.meta?.valid;
  if (typeof v !== 'string') return null;
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

/**
 * Five-minute bucket for the ?t= tile parameter.
 * @param {Date} now
 * @returns {string} UTC, YYYYMMDDHHMM
 */
export function radarTimeBucket(now) {
  const floored = new Date(Math.floor(now.getTime() / FIVE_MIN_MS) * FIVE_MIN_MS);
  return floored.toISOString().replace(/[-:T]/g, '').slice(0, 12);
}

/**
 * Imagery catalog ids for a RIDGE site (data/imagery/products.yaml).
 * @param {string} siteId for example "KATX", or "PACNORTHWEST" for the regional mosaic
 * @returns {{ still: string, loop: string }}
 */
export function ridgeProductIds(siteId) {
  const l = siteId.toLowerCase();
  return { still: `ridge-${l}-still`, loop: `ridge-${l}-loop` };
}

/** The regional mosaic's site id. */
export const RIDGE_MOSAIC = 'PACNORTHWEST';

/**
 * Sites the reference file marks as RIDGE-capable NWS radars.
 * @param {{ sites?: { id: string, agency: string, lat: number, lon: number, ridge: boolean }[] } | null | undefined} ref radar-sites.json
 * @returns {{ id: string, lat: number, lon: number }[]}
 */
export function ridgeSites(ref) {
  return (ref?.sites ?? []).filter((s) => s.agency === 'NWS' && s.ridge).map((s) => ({ id: s.id, lat: s.lat, lon: s.lon }));
}
