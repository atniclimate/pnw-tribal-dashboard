// @ts-check
/**
 * OpenFEMA DisasterDeclarationsSummaries grouped per disaster (blueprint 5.7). DOM-free.
 *
 * STUB (lane L0). Owner: lane L11. Signatures are the contract; bodies throw until the owner implements them.
 */

/** @typedef {import('../types.js').NationIndexEntry} NationIndexEntry */
/** @typedef {import('../types.js').FemaDeclaration} FemaDeclaration */

const NOT_IMPLEMENTED = 'not implemented';

/**
 * $filter for the footprint states over 730 days, explicit $select, $orderby, $skip paging.
 * @param {Date} now
 * @param {number} skip
 * @returns {Record<string, string>}
 */
export function femaQueryParams(now, skip) {
  throw new Error(NOT_IMPLEMENTED);
}

/**
 * One record per femaDeclarationString; never infers "active".
 * @param {unknown[]} rows
 * @param {{ nations: NationIndexEntry[] }} ctx
 * @returns {FemaDeclaration[]}
 */
export function groupFemaRows(rows, ctx) {
  throw new Error(NOT_IMPLEMENTED);
}
