// @ts-check
/**
 * Update and Cancel resolution; only current messages render (blueprint 3.7.7). DOM-free.
 *
 * STUB (lane L0). Owner: lane L3. Signatures are the contract; bodies throw until the owner implements them.
 */

/** @typedef {import('../types.js').DashboardAlert} DashboardAlert */

const NOT_IMPLEMENTED = 'not implemented';

/**
 * References supersede; Cancel cancels its event; ends ?? expires in the past drops the alert.
 * @param {DashboardAlert[]} alerts
 * @param {Date} now
 * @returns {{ current: DashboardAlert[], superseded: string[], cancelled: string[], expired: string[] }}
 */
export function resolveLifecycle(alerts, now) {
  throw new Error(NOT_IMPLEMENTED);
}

/**
 * @param {DashboardAlert} alert
 * @param {Date} now
 * @returns {boolean}
 */
export function isExpired(alert, now) {
  throw new Error(NOT_IMPLEMENTED);
}
