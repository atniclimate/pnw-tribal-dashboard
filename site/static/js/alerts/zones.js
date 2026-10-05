// @ts-check
/**
 * Zone geometry resolution by typed key (blueprint 3.7.5). Heavy: loaded by dynamic import() only when a map is shown. DOM-free.
 *
 * STUB (lane L0). Owner: lane L3. Signatures are the contract; bodies throw until the owner implements them.
 */

/** @typedef {import('../types.js').ZoneKey} ZoneKey */
/** @typedef {import('../types.js').Geometry} Geometry */
/** @typedef {import('../types.js').Feature} Feature */

const NOT_IMPLEMENTED = 'not implemented';

/**
 * Local nws-zones.topo.json first; api.weather.gov/zones fallback at priority 3, at most six per page view.
 * @param {ZoneKey[]} keys
 * @param {{ zonesIndex: Record<string, Geometry> | null, fetchZone: (key: ZoneKey) => Promise<Geometry | null>, maxFetches: number }} deps
 * @returns {Promise<{ features: Feature[], missing: ZoneKey[], fetched: number }>}
 */
export async function resolveZoneGeometry(keys, deps) {
  throw new Error(NOT_IMPLEMENTED);
}
