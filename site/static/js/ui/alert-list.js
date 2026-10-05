// @ts-check
/**
 * Alert list with grouping and a polite live region for count changes (blueprint 7.2). DOM module.
 *
 * STUB (lane L0). Owner: lane L11. Signatures are the contract; bodies throw until the owner implements them.
 */

/** @typedef {import('../types.js').DashboardAlert} DashboardAlert */
/** @typedef {import('../types.js').NationRecord} NationRecord */

const NOT_IMPLEMENTED = 'not implemented';

/**
 * @param {HTMLElement} el
 * @param {DashboardAlert[]} alerts
 * @param {{ timeZone: string, groupBy: 'nation' | 'jurisdiction', nation?: NationRecord | null }} opts
 * @returns {void}
 */
export function renderAlertList(el, alerts, opts) {
  throw new Error(NOT_IMPLEMENTED);
}
