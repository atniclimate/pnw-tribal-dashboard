// @ts-check
/**
 * National Tsunami Warning Center Atom normalizer (blueprint 3.7.2). Takes an already-parsed feed object (the snapshot task parses XML with DOCTYPE and entities disabled). DOM-free.
 *
 * STUB (lane L0). Owner: lane L3. Signatures are the contract; bodies throw until the owner implements them.
 */

/** @typedef {import('../types.js').DashboardAlert} DashboardAlert */
/** @typedef {import('../types.js').AlertDiagnostics} AlertDiagnostics */

const NOT_IMPLEMENTED = 'not implemented';

/**
 * Tsunami Warning act-now; Advisory and Watch prepare; Information Statement monitor.
 * @param {unknown} feed fast-xml-parser output of PAAQAtom.xml
 * @param {{ fetchedAt: string, now: Date }} ctx
 * @returns {{ alerts: DashboardAlert[], diagnostics: AlertDiagnostics }}
 */
export function normalizeNtwcFeed(feed, ctx) {
  throw new Error(NOT_IMPLEMENTED);
}
