// @ts-check
/**
 * Relevance to Nations by typed zone membership and point-in-polygon of samples (blueprint 3.7.8). DOM-free.
 *
 * STUB (lane L0). Owner: lane L3. Signatures are the contract; bodies throw until the owner implements them.
 */

/** @typedef {import('../types.js').DashboardAlert} DashboardAlert */
/** @typedef {import('../types.js').NationRecord} NationRecord */

const NOT_IMPLEMENTED = 'not implemented';

/**
 * Exact zone set membership for NWS; samples in polygon for polygon alerts.
 * @param {DashboardAlert} alert
 * @param {NationRecord[]} nations
 * @returns {string[]}
 */
export function nationIdsForAlert(alert, nations) {
  throw new Error(NOT_IMPLEMENTED);
}

/**
 * Alerts page grouping.
 * @param {DashboardAlert[]} alerts
 * @param {NationRecord} nation
 * @returns {{ forNation: DashboardAlert[], nearby: DashboardAlert[], elsewhere: DashboardAlert[] }}
 */
export function groupForNation(alerts, nation) {
  throw new Error(NOT_IMPLEMENTED);
}
