// @ts-check
/**
 * BC River Forecast Centre advisories (candidate source; blueprint 3.7.2). DOM-free.
 *
 * STUB (lane L0). Owner: lane L3. Signatures are the contract; bodies throw until the owner implements them.
 */

/** @typedef {import('../types.js').BcHazardItem} BcHazardItem */

const NOT_IMPLEMENTED = 'not implemented';

/**
 * Advisory domain 1 No Advisory, 2 High Streamflow Advisory, 3 Flood Watch, 4 Flood Warning; exceededTransferLimit sets degraded.
 * @param {unknown} geojson
 * @param {{ fetchedAt: string, ratified: boolean }} ctx
 * @returns {{ items: BcHazardItem[], diagnostics: Record<string, number> }}
 */
export function normalizeRfcAdvisories(geojson, ctx) {
  throw new Error(NOT_IMPLEMENTED);
}
