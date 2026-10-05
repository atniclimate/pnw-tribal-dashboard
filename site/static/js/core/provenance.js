// @ts-check
/**
 * Renders the provenance footer (status pill, source links, "as of" stamp, checked time) in house style (blueprint 3.3). DOM module.
 *
 * STUB (lane L0). Owner: lane L2. Signatures are the contract; bodies throw until the owner implements them.
 */

/** @typedef {import('../types.js').AsOfBasis} AsOfBasis */
/** @typedef {import('../types.js').StatusSnapshot} StatusSnapshot */
/** @typedef {import('../types.js').SourceRecord} SourceRecord */

const NOT_IMPLEMENTED = 'not implemented';

/**
 * Writes the footer; ui/panel.js calls it after every load so a renderer cannot skip it.
 * @param {HTMLElement} footer the [data-provenance] element
 * @param {StatusSnapshot} status
 * @param {SourceRecord[]} sources
 * @returns {void}
 */
export function renderProvenance(footer, status, sources) {
  throw new Error(NOT_IMPLEMENTED);
}

/**
 * The stamp verb: "Issued as of", "Observed as of", "Valid as of", "Model run", or "Retrieved".
 * @param {AsOfBasis | null} basis
 * @returns {string}
 */
export function asOfLabel(basis) {
  throw new Error(NOT_IMPLEMENTED);
}
