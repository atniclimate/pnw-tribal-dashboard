// @ts-check
/**
 * Declarations loading for panels. DOM-free.
 *
 * STUB (lane L0). Owner: lane L11. Signatures are the contract; bodies throw until the owner implements them.
 */

/** @typedef {import('../types.js').StatusSnapshot} StatusSnapshot */
/** @typedef {import('../types.js').AlertScope} AlertScope */
/** @typedef {import('../types.js').CuratedDeclaration} CuratedDeclaration */
/** @typedef {import('../types.js').FemaDeclaration} FemaDeclaration */

const NOT_IMPLEMENTED = 'not implemented';

/**
 * @param {{ scope: AlertScope, signal?: AbortSignal }} opts
 * @returns {Promise<{ fema: FemaDeclaration[], curated: CuratedDeclaration[], statuses: Map<string, StatusSnapshot> }>}
 */
export async function loadDeclarations(opts) {
  throw new Error(NOT_IMPLEMENTED);
}
