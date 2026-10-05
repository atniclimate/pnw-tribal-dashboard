// @ts-check
/**
 * ECCC GeoMet weather-alerts normalizer (port of CAST parseEcccGeoMet; blueprint 3.7.4). English and French kept verbatim. DOM-free.
 *
 * STUB (lane L0). Owner: lane L3. Signatures are the contract; bodies throw until the owner implements them.
 */

/** @typedef {import('../types.js').PageId} PageId */
/** @typedef {import('../types.js').DashboardAlert} DashboardAlert */
/** @typedef {import('../types.js').AlertDiagnostics} AlertDiagnostics */
/** @typedef {import('../types.js').AlertScope} AlertScope */

const NOT_IMPLEMENTED = 'not implemented';

/**
 * numberMatched above the features returned sets diagnostics.truncated.
 * @param {unknown} collection
 * @param {{ fetchedAt: string, now: Date }} ctx
 * @returns {{ alerts: DashboardAlert[], diagnostics: AlertDiagnostics, failures: { id: string | null, reason: string }[] }}
 */
export function normalizeEcccCollection(collection, ctx) {
  throw new Error(NOT_IMPLEMENTED);
}

/**
 * filter=properties.province=BC&limit=500 plus bbox in browser top-ups.
 * @param {AlertScope} scope
 * @param {{ bbox?: [number, number, number, number], skipGeometry?: boolean }} [opts]
 * @returns {Record<string, string>}
 */
export function ecccRequestParams(scope, opts) {
  throw new Error(NOT_IMPLEMENTED);
}

/**
 * Direct ECCC top-up runs only when British Columbia is in scope.
 * @param {AlertScope} scope
 * @param {PageId} page
 * @returns {boolean}
 */
export function ecccInScope(scope, page) {
  throw new Error(NOT_IMPLEMENTED);
}
