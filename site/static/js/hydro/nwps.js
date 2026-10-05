// @ts-check
/**
 * NWPS gauges; the NWS flood category is displayed, never a self-computed one (blueprint 5.5). DOM-free.
 *
 * STUB (lane L0). Owner: lane L7. Signatures are the contract; bodies throw until the owner implements them.
 */

/** @typedef {import('../types.js').Gauge} Gauge */
/** @typedef {import('../types.js').GaugeStatus} GaugeStatus */

const NOT_IMPLEMENTED = 'not implemented';

/**
 * Sentinels (-999, -9999) become null; out_of_service kept.
 * @param {unknown} json
 * @param {{ fetchedAt: string, now: Date }} ctx
 * @returns {GaugeStatus[]}
 */
export function normalizeNwpsGaugeList(json, ctx) {
  throw new Error(NOT_IMPLEMENTED);
}

/**
 * Thresholds copied verbatim; nulls stay null.
 * @param {unknown} json
 * @param {{ retrievedAt: string }} ctx
 * @returns {Gauge}
 */
export function normalizeNwpsGauge(json, ctx) {
  throw new Error(NOT_IMPLEMENTED);
}

/**
 * water.noaa.gov/resources/hydrographs/<lid>_hg.png from the registry template.
 * @param {string} lid
 * @returns {string}
 */
export function hydrographImageUrl(lid) {
  throw new Error(NOT_IMPLEMENTED);
}
