// @ts-check
/**
 * The only importer of the vendored MapLibre GL JS modules (blueprint 2.5, 4.1). DOM module.
 *
 * Everything is same origin: the library and its worker load from the vendored folder, so the Content
 * Security Policy needs no `blob:` and no `'unsafe-eval'` (blueprint 2.6). Nothing here runs before a page
 * calls it, and pages call it only after `alerts-painted` and a map request (blueprint 4.6).
 *
 * Owner: lane L8.
 */

/** Must equal the exact maplibre-gl development dependency and the vendored folder (check:vendor). @type {string} */
export const MAPLIBRE_VERSION = '6.12.0';

/** Relative to this module; resolves to v/<sha12>/vendor/maplibre-gl-6.12.0/ in production. @type {string} */
export const MAPLIBRE_BASE = '../../vendor/maplibre-gl-6.12.0/';

const TOPOJSON_FILE = '../../vendor/topojson-client-3.1.0/topojson-client.min.js';
const MAP_CSS = '../../css/map.css';

/** @type {Promise<typeof import('maplibre-gl')> | null} */
let mapLibrePromise = null;
/** @type {Promise<typeof import('topojson-client')> | null} */
let topojsonPromise = null;
/** @type {Map<string, Promise<void>>} */
const sheets = new Map();

/**
 * @param {string} href
 * @returns {void}
 */
function preloadModule(href) {
  if (document.querySelector(`link[rel="modulepreload"][href="${href}"]`)) return;
  const link = document.createElement('link');
  link.rel = 'modulepreload';
  link.href = href;
  document.head.append(link);
}

/**
 * Adds a same-origin stylesheet once and resolves when it has loaded. A stylesheet that fails to load
 * resolves too: the map stays usable and the failure is not allowed to block the sovereignty note.
 * @param {string} href
 * @returns {Promise<void>}
 */
function injectStylesheet(href) {
  const known = sheets.get(href);
  if (known) return known;
  const p = new Promise((resolve) => {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = href;
    link.addEventListener('load', () => resolve(undefined), { once: true });
    link.addEventListener('error', () => resolve(undefined), { once: true });
    document.head.append(link);
  });
  sheets.set(href, /** @type {Promise<void>} */ (p));
  return /** @type {Promise<void>} */ (p);
}

/**
 * Injects map.css (outline mode and the controls around the canvas use it, so both modes call this).
 * @returns {Promise<void>}
 */
export function loadMapStyles() {
  return injectStylesheet(new URL(MAP_CSS, import.meta.url).href);
}

/**
 * Preloads maplibre-gl.mjs and maplibre-gl-shared.mjs in parallel, injects maplibre-gl.css, imports the library, sets the same-origin worker URL and one worker.
 * @returns {Promise<typeof import('maplibre-gl')>}
 */
export function loadMapLibre() {
  if (mapLibrePromise) return mapLibrePromise;
  const base = new URL(MAPLIBRE_BASE, import.meta.url);
  const entry = new URL('maplibre-gl.mjs', base).href;
  const shared = new URL('maplibre-gl-shared.mjs', base).href;
  mapLibrePromise = (async () => {
    // Parallel, not chained: the entry module imports the shared module, which the browser would otherwise
    // discover only after parsing the first.
    preloadModule(entry);
    preloadModule(shared);
    const css = injectStylesheet(new URL('maplibre-gl.css', base).href);
    // eslint-disable-next-line no-unsanitized/method -- a same-origin URL built from import.meta.url and a constant
    const maplibregl = /** @type {typeof import('maplibre-gl')} */ (await import(entry));
    // The worker URL is set explicitly and is same origin: MapLibre then builds a module worker directly
    // from the vendored file and never creates a blob URL (blueprint 2.3).
    maplibregl.setWorkerUrl(new URL('maplibre-gl-worker.mjs', base).href);
    maplibregl.setWorkerCount(1);
    await css;
    return maplibregl;
  })();
  mapLibrePromise.catch(() => { mapLibrePromise = null; });
  return mapLibrePromise;
}

/**
 * Injects the vendored topojson-client script; used in both modes.
 * @returns {Promise<typeof import('topojson-client')>}
 */
export function loadTopojson() {
  if (topojsonPromise) return topojsonPromise;
  const src = new URL(TOPOJSON_FILE, import.meta.url).href;
  topojsonPromise = new Promise((resolve, reject) => {
    const have = /** @type {any} */ (globalThis).topojson;
    if (have) { resolve(have); return; }
    const script = document.createElement('script');
    script.src = src;
    script.async = true;
    script.addEventListener('load', () => {
      const lib = /** @type {any} */ (globalThis).topojson;
      if (lib) resolve(lib); else reject(new Error('topojson-client did not register'));
    }, { once: true });
    script.addEventListener('error', () => reject(new Error('topojson-client failed to load')), { once: true });
    document.head.append(script);
  });
  topojsonPromise.catch(() => { topojsonPromise = null; });
  return topojsonPromise;
}
