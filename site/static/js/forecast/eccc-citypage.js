// @ts-check
/**
 * ECCC city page forecast for British Columbia Nations, with distance (blueprint 3.14). DOM-free.
 *
 * STUB (lane L0). Owner: lane L12. Signatures are the contract; bodies throw until the owner implements them.
 */

/** @typedef {import('../types.js').StatusSnapshot} StatusSnapshot */

const NOT_IMPLEMENTED = 'not implemented';

/**
 * @param {string} citypageId
 * @param {{ signal?: AbortSignal }} [opts]
 * @returns {Promise<{ data: unknown, status: StatusSnapshot }>}
 */
export async function loadCityPage(citypageId, opts) {
  throw new Error(NOT_IMPLEMENTED);
}

/**
 * Text exactly as published by ECCC.
 * @param {unknown} feature
 * @returns {{ siteId: string, name: string, lastUpdated: string | null, periods: { name: string, summary: string }[] }}
 */
export function normalizeCityPage(feature) {
  throw new Error(NOT_IMPLEMENTED);
}
