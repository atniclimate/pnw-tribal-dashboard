// @ts-check
/**
 * Alert card: event as issued, designation badge, band chip, posture, area, times in the right zone; expands to description and What to Do verbatim (blueprint 7.2). DOM module.
 *
 * STUB (lane L0). Owner: lane L11. Signatures are the contract; bodies throw until the owner implements them.
 */

/** @typedef {import('../types.js').AlertLanguageBlock} AlertLanguageBlock */
/** @typedef {import('../types.js').DashboardAlert} DashboardAlert */
/** @typedef {import('../types.js').DashboardAlertIndexEntry} DashboardAlertIndexEntry */

const NOT_IMPLEMENTED = 'not implemented';

/**
 * @param {DashboardAlert | DashboardAlertIndexEntry} alert
 * @param {{ timeZone: string, lang?: string, onShowOnMap?: (alertId: string) => void, loadText?: (alertId: string) => Promise<Record<string, AlertLanguageBlock> | null> }} opts
 * @returns {HTMLElement}
 */
export function alertCard(alert, opts) {
  throw new Error(NOT_IMPLEMENTED);
}
