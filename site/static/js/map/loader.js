// @ts-check
/**
 * The only importer of the vendored MapLibre GL JS modules (blueprint 2.5, 4.1).
 *
 * STUB (lane L0). Owner: lane L8. Signatures are the contract; bodies throw until the owner implements them.
 */
const NOT_IMPLEMENTED = 'not implemented';

/** Must equal the exact maplibre-gl development dependency and the vendored folder (check:vendor). @type {string} */
export const MAPLIBRE_VERSION = '6.12.0';

/** Relative to this module; resolves to v/<sha12>/vendor/maplibre-gl-6.12.0/ in production. @type {string} */
export const MAPLIBRE_BASE = '../../vendor/maplibre-gl-6.12.0/';

/**
 * Preloads maplibre-gl.mjs and maplibre-gl-shared.mjs in parallel, injects maplibre-gl.css, imports the library, sets the same-origin worker URL and one worker.
 * @returns {Promise<typeof import('maplibre-gl')>}
 */
export async function loadMapLibre() {
  throw new Error(NOT_IMPLEMENTED);
}

/**
 * Injects the vendored topojson-client script; used in both modes.
 * @returns {Promise<typeof import('topojson-client')>}
 */
export async function loadTopojson() {
  throw new Error(NOT_IMPLEMENTED);
}
