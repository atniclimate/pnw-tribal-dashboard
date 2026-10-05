// @ts-check
/**
 * Image viewer with size-labeled taps and stamps (blueprint 7.3, 8.3). DOM module.
 *
 * STUB (lane L0). Owner: lane L12. Signatures are the contract; bodies throw until the owner implements them.
 */

/** @typedef {import('../types.js').ImageryProduct} ImageryProduct */

const NOT_IMPLEMENTED = 'not implemented';

/**
 * @param {HTMLElement} el
 * @param {{ product: ImageryProduct, stamp: string | null, timeZone: string, lowData: boolean }} opts
 * @returns {{ setProduct(product: ImageryProduct, stamp: string | null): void, destroy(): void }}
 */
export function createMediaViewer(el, opts) {
  throw new Error(NOT_IMPLEMENTED);
}
