// @ts-check
/**
 * NWS point forecast: 14 periods labeled 7-Day; Current Conditions only from an observation (blueprint 3.14). DOM-free.
 *
 * STUB (lane L0). Owner: lane L12. Signatures are the contract; bodies throw until the owner implements them.
 */

/** @typedef {import('../types.js').StatusSnapshot} StatusSnapshot */
/** @typedef {import('../types.js').ForecastPeriod} ForecastPeriod */

const NOT_IMPLEMENTED = 'not implemented';

/**
 * /points (one-hour cache), then forecast.
 * @param {[number, number]} latLon
 * @param {{ signal?: AbortSignal }} [opts]
 * @returns {Promise<{ periods: ForecastPeriod[], office: string | null, status: StatusSnapshot }>}
 */
export async function loadPointForecast(latLon, opts) {
  throw new Error(NOT_IMPLEMENTED);
}

/**
 * @param {unknown} json
 * @returns {ForecastPeriod[]}
 */
export function normalizeForecastPeriods(json) {
  throw new Error(NOT_IMPLEMENTED);
}
