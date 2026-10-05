// @ts-check
/**
 * The only sanctioned way to put data on screen (blueprint 3.3). Writes the provenance footer after every load; aborts superseded loads with a generation counter. DOM module.
 *
 * STUB (lane L0). Owner: lane L2. Signatures are the contract; bodies throw until the owner implements them.
 */

/** @typedef {import('../types.js').PanelHandle} PanelHandle */

const NOT_IMPLEMENTED = 'not implemented';

/**
 * Asserts in development that slot.dataset.sources matches spec.sourceIds.
 * @param {HTMLElement} slot a [data-panel] section with data-sources
 * @param {import('../types.js').PanelSpec} spec
 * @returns {PanelHandle}
 */
export function mountPanel(slot, spec) {
  throw new Error(NOT_IMPLEMENTED);
}
