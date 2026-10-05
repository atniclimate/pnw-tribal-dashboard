// @ts-check
/**
 * EMCR evacuation orders and alerts (candidate; never merged into alert counts). DOM-free.
 *
 * STUB (lane L0). Owner: lane L3. Signatures are the contract; bodies throw until the owner implements them.
 */

/** @typedef {import('../types.js').BcHazardItem} BcHazardItem */

const NOT_IMPLEMENTED = 'not implemented';

/**
 * @param {unknown} geojson
 * @param {{ fetchedAt: string, now: Date }} ctx
 * @returns {{ items: BcHazardItem[], diagnostics: Record<string, number> }}
 */
export function normalizeEvacuations(geojson, ctx) {
  throw new Error(NOT_IMPLEMENTED);
}
