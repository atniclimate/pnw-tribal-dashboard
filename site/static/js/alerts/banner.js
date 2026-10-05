// @ts-check
/**
 * Banner computation: none only when every required source is live and complete (blueprint 3.8). ui/alert-banner.js renders it. DOM-free.
 *
 * STUB (lane L0). Owner: lane L3. Signatures are the contract; bodies throw until the owner implements them.
 */

/** @typedef {import('../types.js').StatusSnapshot} StatusSnapshot */
/** @typedef {import('../types.js').DashboardAlert} DashboardAlert */
/** @typedef {import('../types.js').AlertScope} AlertScope */
/** @typedef {import('../types.js').Banner} Banner */

const NOT_IMPLEMENTED = 'not implemented';

/**
 * US Nation: NWS. BC Nation: ECCC (plus BC River Forecast Centre once active). Footprint: NWS and ECCC.
 * @param {AlertScope} scope
 * @returns {string[]}
 */
export function requiredSourcesFor(scope) {
  throw new Error(NOT_IMPLEMENTED);
}

/**
 * Rules 1 to 4 of blueprint 3.8.
 * @param {DashboardAlert[]} alerts
 * @param {Map<string, StatusSnapshot>} statuses
 * @param {string[]} requiredSourceIds
 * @param {Date} now
 * @returns {Banner}
 */
export function summarizeForBanner(alerts, statuses, requiredSourceIds, now) {
  throw new Error(NOT_IMPLEMENTED);
}

/**
 * House-style copy from the 3.8 table.
 * @param {Banner} banner
 * @param {{ scopeName: string, timeZone: string }} opts
 * @returns {{ headline: string, detail: string | null }}
 */
export function bannerCopy(banner, opts) {
  throw new Error(NOT_IMPLEMENTED);
}
