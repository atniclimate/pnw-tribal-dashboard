// @ts-check
/**
 * NWS CAP normalizer and request plan (blueprint 3.7.3). Ports CAST ingest-nws, with the dashboard failure policy (ADR 0007). DOM-free.
 *
 * STUB (lane L0). Owner: lane L3. Signatures are the contract; bodies throw until the owner implements them.
 */

/** @typedef {import('../types.js').DashboardAlert} DashboardAlert */
/** @typedef {import('../types.js').AlertDiagnostics} AlertDiagnostics */
/** @typedef {import('../types.js').AlertScope} AlertScope */
/** @typedef {import('../types.js').FeatureCollection} FeatureCollection */

const NOT_IMPLEMENTED = 'not implemented';

/**
 * Every valid item is kept; failures are counted, never fatal. Test and Exercise messages are excluded and counted.
 * @param {unknown} collection a GeoJSON FeatureCollection from /alerts/active
 * @param {{ fetchedAt: string, now: Date }} ctx
 * @returns {{ alerts: DashboardAlert[], diagnostics: AlertDiagnostics, failures: { id: string | null, reason: string }[] }}
 */
export function normalizeNwsCollection(collection, ctx) {
  throw new Error(NOT_IMPLEMENTED);
}

/**
 * Throws on a malformed item (the collection normalizer catches it).
 * @param {unknown} feature
 * @param {{ fetchedAt: string, now: Date }} ctx
 * @returns {DashboardAlert}
 */
export function normalizeNwsFeature(feature, ctx) {
  throw new Error(NOT_IMPLEMENTED);
}

/**
 * Footprint: area=WA,OR,ID,PZ plus zone= chunks of 50 edge codes. Nation: one zone= request.
 * @param {AlertScope} scope
 * @param {{ edgeCodes: string[] }} footprintUgc
 * @returns {Array<{ sourceId: string, params: Record<string, string> }>}
 */
export function nwsRequestPlan(scope, footprintUgc) {
  throw new Error(NOT_IMPLEMENTED);
}

/**
 * forecast.weather.gov product page from parameters.AWIPSidentifier, else https://www.weather.gov/<office>/.
 * @param {Record<string, unknown>} properties
 * @returns {string | null}
 */
export function nwsWebUrl(properties) {
  throw new Error(NOT_IMPLEMENTED);
}
