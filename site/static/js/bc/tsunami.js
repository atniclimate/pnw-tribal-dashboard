// @ts-check
/**
 * EMBC tsunami notifications, attributes only (candidate). DOM-free.
 *
 * STUB (lane L0). Owner: lane L3. Signatures are the contract; bodies throw until the owner implements them.
 */

/** @typedef {import('../types.js').BcHazardItem} BcHazardItem */

const NOT_IMPLEMENTED = 'not implemented';

/**
 * @param {unknown} json
 * @param {{ fetchedAt: string }} ctx
 * @returns {{ items: BcHazardItem[], diagnostics: Record<string, number> }}
 */
export function normalizeTsunamiNotifications(json, ctx) {
  throw new Error(NOT_IMPLEMENTED);
}
