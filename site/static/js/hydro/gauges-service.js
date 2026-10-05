// @ts-check
/**
 * Gauge loading for panels: reference plus live status. DOM-free.
 *
 * STUB (lane L0). Owner: lane L7. Signatures are the contract; bodies throw until the owner implements them.
 */

/** @typedef {import('../types.js').StatusSnapshot} StatusSnapshot */
/** @typedef {import('../types.js').NationRecord} NationRecord */
/** @typedef {import('../types.js').Gauge} Gauge */
/** @typedef {import('../types.js').GaugeStatus} GaugeStatus */

const NOT_IMPLEMENTED = 'not implemented';

/**
 * @param {{ nation: NationRecord | null, signal?: AbortSignal }} opts
 * @returns {Promise<{ gauges: Gauge[], statuses: Map<string, GaugeStatus>, status: StatusSnapshot }>}
 */
export async function loadGauges(opts) {
  throw new Error(NOT_IMPLEMENTED);
}

/**
 * The Nation record gauges list first, nearest first ("Nearby gauges").
 * @param {NationRecord} nation
 * @param {Gauge[]} gauges
 * @returns {Gauge[]}
 */
export function nearbyGauges(nation, gauges) {
  throw new Error(NOT_IMPLEMENTED);
}
