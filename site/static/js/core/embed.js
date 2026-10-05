// @ts-check
/**
 * Embed behavior: framed defaults, new-tab links, height messages (blueprint 1.4). DOM module.
 *
 * STUB (lane L0). Owner: lane L1. Signatures are the contract; bodies throw until the owner implements them.
 */

/** @typedef {import('../types.js').PageId} PageId */

const NOT_IMPLEMENTED = 'not implemented';

/**
 * Wires embed mode for the page; returns a teardown function.
 * @param {{ page: PageId }} opts
 * @returns {() => void}
 */
export function initEmbed(opts) {
  throw new Error(NOT_IMPLEMENTED);
}

/**
 * True when html[data-embed] is set by boot/flags.js.
 * @returns {boolean}
 */
export function isEmbedMode() {
  throw new Error(NOT_IMPLEMENTED);
}

/**
 * @returns {boolean}
 */
export function isFramed() {
  throw new Error(NOT_IMPLEMENTED);
}

/**
 * Posts { source: 'cthd', type: 'resize', page, height } to the parent, at most once per 250 ms.
 * @param {PageId} page
 * @returns {void}
 */
export function postHeight(page) {
  throw new Error(NOT_IMPLEMENTED);
}
