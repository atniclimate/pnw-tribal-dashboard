// @ts-check
/**
 * Focusable feature list mirroring what the map draws (blueprint 4.6). DOM module.
 *
 * STUB (lane L0). Owner: lane L8. Signatures are the contract; bodies throw until the owner implements them.
 */

/** @typedef {import('../types.js').FeatureItem} FeatureItem */

const NOT_IMPLEMENTED = 'not implemented';

/**
 * Capped at the 50 nearest the center.
 * @param {HTMLElement} container
 * @param {{ onActivate: (item: FeatureItem) => void, onFocus?: (item: FeatureItem) => void, cap?: number }} opts
 * @returns {{ update(items: FeatureItem[]): void, focusItem(kind: string, id: string): void, destroy(): void }}
 */
export function createFeatureList(container, opts) {
  throw new Error(NOT_IMPLEMENTED);
}
