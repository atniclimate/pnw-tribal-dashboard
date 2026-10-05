// @ts-check
/**
 * Latest Area Forecast Discussion for an office (blueprint 7.3). DOM-free.
 *
 * STUB (lane L0). Owner: lane L12. Signatures are the contract; bodies throw until the owner implements them.
 */

/** @typedef {import('../types.js').StatusSnapshot} StatusSnapshot */

const NOT_IMPLEMENTED = 'not implemented';

/**
 * @param {string} wfo
 * @param {{ signal?: AbortSignal }} [opts]
 * @returns {Promise<{ text: string | null, issuedAt: string | null, status: StatusSnapshot }>}
 */
export async function loadLatestAfd(wfo, opts) {
  throw new Error(NOT_IMPLEMENTED);
}
