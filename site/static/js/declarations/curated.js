// @ts-check
/**
 * Curated declaration status, computed at render and never stored (blueprint 5.7). DOM-free.
 *
 * STUB (lane L0). Owner: lane L11. Signatures are the contract; bodies throw until the owner implements them.
 */

/** @typedef {import('../types.js').CuratedDeclaration} CuratedDeclaration */

const NOT_IMPLEMENTED = 'not implemented';

/**
 * @param {CuratedDeclaration} declaration
 * @param {Date} now
 * @returns {{ kind: 'in-effect' | 'not-reconfirmed' | 'ended', since: string }}
 */
export function curatedStatus(declaration, now) {
  throw new Error(NOT_IMPLEMENTED);
}
