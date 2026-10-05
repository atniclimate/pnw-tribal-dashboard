// @ts-check
/**
 * Always-visible attribution lines from registry records (blueprint 4.3). DOM module.
 *
 * STUB (lane L0). Owner: lane L8. Signatures are the contract; bodies throw until the owner implements them.
 */

/** @typedef {import('../types.js').SourceRecord} SourceRecord */

const NOT_IMPLEMENTED = 'not implemented';

/**
 * @param {string[]} sourceIds
 * @param {(id: string) => SourceRecord} lookup
 * @returns {string[]}
 */
export function attributionLines(sourceIds, lookup) {
  throw new Error(NOT_IMPLEMENTED);
}

/**
 * Used by outline mode; the interactive map uses AttributionControl with compact false.
 * @param {HTMLElement} frame
 * @param {string[]} lines
 * @returns {HTMLElement}
 */
export function mountAttribution(frame, lines) {
  throw new Error(NOT_IMPLEMENTED);
}
