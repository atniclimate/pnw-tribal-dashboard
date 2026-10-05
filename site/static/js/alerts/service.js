// @ts-check
/**
 * Load orchestration: snapshot first, live second (blueprint 3.7.6). The same module runs in Node for the alerts snapshot task. DOM-free.
 *
 * STUB (lane L0). Owner: lane L3. Signatures are the contract; bodies throw until the owner implements them.
 */

/** @typedef {import('../types.js').DashboardAlert} DashboardAlert */
/** @typedef {import('../types.js').AlertScope} AlertScope */
/** @typedef {import('../types.js').LoadAllAlertsResult} LoadAllAlertsResult */
/** @typedef {import('../types.js').Banner} Banner */
/** @typedef {import('../types.js').NationsIndex} NationsIndex */

const NOT_IMPLEMENTED = 'not implemented';

/**
 * Banner, lists, map, and the snapshot task never call adapters directly.
 * @param {{ scope: AlertScope, registry: { index: NationsIndex | null }, signal?: AbortSignal }} opts
 * @returns {Promise<LoadAllAlertsResult>}
 */
export async function loadAllAlerts(opts) {
  throw new Error(NOT_IMPLEMENTED);
}

/**
 * Complete direct replaces; partial direct is the union with non-superseded snapshot items.
 * @param {DashboardAlert[]} direct
 * @param {DashboardAlert[]} snapshot
 * @param {'complete' | 'partial'} completeness
 * @param {Date} now
 * @returns {DashboardAlert[]}
 */
export function mergeDirectWithSnapshot(direct, snapshot, completeness, now) {
  throw new Error(NOT_IMPLEMENTED);
}
