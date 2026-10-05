// @ts-check
/**
 * Footprint filter and jurisdictions from UGC prefixes, never from areaDesc (blueprint 3.7.3, 3.7.8). DOM-free.
 *
 * STUB (lane L0). Owner: lane L3. Signatures are the contract; bodies throw until the owner implements them.
 */

/** @typedef {import('../types.js').Jurisdiction} Jurisdiction */
/** @typedef {import('../types.js').RegionCode} RegionCode */
/** @typedef {import('../types.js').ZoneKey} ZoneKey */
/** @typedef {import('../types.js').DashboardAlert} DashboardAlert */

const NOT_IMPLEMENTED = 'not implemented';

/**
 * Any UGC in footprint-ugc.json, or the polygon intersects the footprint.
 * @param {DashboardAlert} alert
 * @param {{ ugc: ReadonlySet<string>, bbox: [number, number, number, number] }} footprint
 * @returns {boolean}
 */
export function inFootprint(alert, footprint) {
  throw new Error(NOT_IMPLEMENTED);
}

/**
 * PZZ and PKZ map to MARINE; never derived from areaDesc text.
 * @param {ZoneKey[]} zones
 * @param {Record<string, RegionCode>} marineToRegion
 * @returns {Jurisdiction[]}
 */
export function jurisdictionsOf(zones, marineToRegion) {
  throw new Error(NOT_IMPLEMENTED);
}
