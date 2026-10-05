// @ts-check
/**
 * Radar helpers: nearest RIDGE site by haversine, IEM valid time, five-minute tile bucket (blueprint 4.4, 7.3). DOM-free.
 *
 * STUB (lane L0). Owner: lane L12. Signatures are the contract; bodies throw until the owner implements them.
 */
const NOT_IMPLEMENTED = 'not implemented';

/**
 * @param {[number, number]} latLon
 * @param {{ id: string, lat: number, lon: number }[]} sites
 * @returns {{ id: string, distanceKm: number } | null}
 */
export function nearestRadarSite(latLon, sites) {
  throw new Error(NOT_IMPLEMENTED);
}

/**
 * meta.valid as ISO, or null.
 * @param {unknown} json n0q_0.json
 * @returns {string | null}
 */
export function iemValidTime(json) {
  throw new Error(NOT_IMPLEMENTED);
}

/**
 * Five-minute bucket for the ?t= tile parameter.
 * @param {Date} now
 * @returns {string}
 */
export function radarTimeBucket(now) {
  throw new Error(NOT_IMPLEMENTED);
}
