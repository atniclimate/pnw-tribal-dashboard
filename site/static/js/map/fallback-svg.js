// @ts-check
/**
 * No-WebGL outline mode: inline SVG paths from local TopoJSON, no tiles, no third party (blueprint 4.8). DOM module.
 *
 * STUB (lane L0). Owner: lane L8. Signatures are the contract; bodies throw until the owner implements them.
 */

/** @typedef {import('../types.js').FeatureCollection} FeatureCollection */

const NOT_IMPLEMENTED = 'not implemented';

/**
 * role="img" with a text summary; colors from map.css classes only.
 * @param {HTMLElement} frame
 * @param {{ outlines: FeatureCollection, nation?: FeatureCollection | null, alerts?: FeatureCollection | null, label: string }} opts
 * @returns {{ svg: SVGSVGElement, update(opts: { nation?: FeatureCollection | null, alerts?: FeatureCollection | null }): void, destroy(): void }}
 */
export function renderOutlineMap(frame, opts) {
  throw new Error(NOT_IMPLEMENTED);
}
