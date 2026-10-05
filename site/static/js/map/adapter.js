// @ts-check
/**
 * Page-facing entry to maps, loaded by dynamic import() only after alerts-painted and a map request (blueprint 4.1, 4.6). Pages call requestMap; it probes support and calls createMap. DOM module.
 *
 * Pages wait for `performance.mark('alerts-painted')` and a map request (a tap on "Show Map", a map view
 * in the URL, "Show on Map" from an alert card, or the stored "Always show the map" choice) before they
 * `import('../map/adapter.js')`. This module repeats the first check, so even a page that imports it early
 * cannot make it pull in `create-map.js`, the layers, or the vendored library before the alerts have
 * painted: those are imported dynamically inside requestMap, after the mark.
 *
 * It imports nothing from map/ statically. That keeps the module chain short: once this small file runs, it
 * tells the browser to fetch the whole graph of create-map.js, the stylesheet, topojson-client, and the
 * outlines file at once (and, for the interactive map, the layers and the library), instead of discovering
 * them one import depth at a time over a slow connection.
 *
 * Owner: lane L8.
 */
import { h } from '../core/dom.js';
import { fetchLocal } from '../core/net.js';
import { APP } from '../config/app.js';

/** @typedef {import('../types.js').CreateMapOptions} CreateMapOptions */
/** @typedef {import('../types.js').CthdMap} CthdMap */

/**
 * The static import graph of create-map.js inside map/, preloaded in parallel before create-map.js is
 * imported. tests/unit/map/preload.test.mjs keeps this list equal to that graph.
 */
export const CREATE_MAP_GRAPH = Object.freeze(['create-map.js', 'attribution.js', 'fallback-svg.js', 'feature-list.js', 'legend.js', 'loader.js',
  'sovereignty.js', 'style.js', 'support.js', 'topo.js']);

/** Layer module names create-map can import (kept equal to the files in layers/ by the preload test). */
export const LAYER_FILES = Object.freeze(['basemap', 'radar', 'outlines', 'boundaries', 'zones', 'alerts', 'bc', 'gauges', 'hq']);

/** Same values as map/loader.js and map/topo.js; tests/unit/map/preload.test.mjs asserts they stay equal. */
export const LIBRARY_BASE = '../../vendor/maplibre-gl-6.12.0/';
export const TOPOJSON_FILE = '../../vendor/topojson-client-3.1.0/topojson-client.min.js';
export const MAP_CSS = '../../css/map.css';
export const OUTLINES_PATH = 'data/geo/outlines.topo.json';

/** Label of the offer shown in outline mode on a device that could draw the interactive map. */
export const INTERACTIVE_OFFER = `Load Interactive Map (about ${Math.round(APP.map.interactiveLabelBytes / 1000)} KB)`;

/**
 * @param {string[]} names paths relative to `base`
 * @param {string} [base] directory the names are relative to, itself relative to this module
 * @returns {void}
 */
function preloadModules(names, base = './') {
  for (const name of names) {
    const href = new URL(base + name, import.meta.url).href;
    if (document.querySelector(`link[rel="modulepreload"][href="${href}"]`)) continue;
    const link = document.createElement('link');
    link.rel = 'modulepreload';
    link.href = href;
    document.head.append(link);
  }
}

/**
 * @param {string} path relative to this module
 * @param {'style' | 'script'} as
 * @returns {void}
 */
function preloadAsset(path, as) {
  const href = new URL(path, import.meta.url).href;
  if (document.querySelector(`link[rel="preload"][href="${href}"]`)) return;
  const link = document.createElement('link');
  link.rel = 'preload';
  link.as = as;
  link.href = href;
  document.head.append(link);
}

/**
 * Everything that does not depend on the capability probe starts downloading: the map module graph, the
 * stylesheet, topojson-client, and the outlines file (create-map joins this request, not a second one).
 * @param {readonly string[]} layers the layer ids the page asked for
 * @param {boolean} [interactive] also hint the layers and the library (the timing tests model a GPU device)
 * @returns {void}
 */
export function startMapLoad(layers, interactive = false) {
  preloadModules([...CREATE_MAP_GRAPH]);
  preloadAsset(MAP_CSS, 'style');
  preloadAsset(TOPOJSON_FILE, 'script');
  void fetchLocal(OUTLINES_PATH, { priority: 1, ttlMs: 3_600_000 });
  if (interactive) preloadInteractive(layers);
}

/**
 * The interactive map will start: its layer modules and the library download alongside create-map.js. Called
 * by requestMap once the probe says the device can draw it (never before: a device with no WebGL2 must not
 * request the library at all), and by the timing tests to model a device with a GPU.
 * @param {readonly string[]} layers the layer ids the page asked for
 * @returns {void}
 */
export function preloadInteractive(layers) {
  preloadModules([...new Set(['outlines', ...layers])].filter((n) => LAYER_FILES.includes(n)).map((n) => `layers/${n}.js`));
  preloadModules(['maplibre-gl.mjs', 'maplibre-gl-shared.mjs'], LIBRARY_BASE);
  preloadAsset(`${LIBRARY_BASE}maplibre-gl.css`, 'style');
}

/**
 * Resolves once performance.mark('alerts-painted') exists.
 * @returns {Promise<void>}
 */
export function whenAlertsPainted() {
  return new Promise((resolve) => {
    if (performance.getEntriesByName('alerts-painted').length > 0) { resolve(); return; }
    /** @type {PerformanceObserver | null} */
    let observer = null;
    /** @type {ReturnType<typeof setInterval> | null} */
    let poll = null;
    const done = () => {
      observer?.disconnect();
      if (poll) clearInterval(poll);
      resolve();
    };
    try {
      observer = new PerformanceObserver((list) => {
        if (list.getEntries().some((e) => e.name === 'alerts-painted')) done();
      });
      observer.observe({ type: 'mark', buffered: true });
    } catch { observer = null; }
    // Browsers without mark observation, and a mark placed between the check and the observer.
    poll = setInterval(() => { if (performance.getEntriesByName('alerts-painted').length > 0) done(); }, 100);
  });
}

/**
 * Waits for performance.mark('alerts-painted'), probes WebGL, and creates the map in the right mode.
 * `full` hardware WebGL2 builds the interactive map; `caveat` (software rendering), low-data mode, and
 * Save-Data start in outline mode with a "Load Interactive Map" offer; `none` is outline mode only.
 * @param {HTMLElement} frame
 * @param {CreateMapOptions} opts
 * @returns {Promise<CthdMap>}
 */
export async function requestMap(frame, opts) {
  await whenAlertsPainted();
  const lowData = document.documentElement.hasAttribute('data-lowdata');
  // support.js is requested first, so the probe is not queued behind the rest of the graph.
  const supportModule = import('./support.js');
  startMapLoad(opts.layers);
  const { chooseMode, probeWebGL } = await supportModule;
  const mode = chooseMode(probeWebGL(), { lowData, requested: false });
  // 'none' stays 'auto' so createMap itself states why the interactive map is not drawn.
  const createMode = opts.mode === 'outline' || mode === 'outline-offer-interactive' ? 'outline' : 'auto';
  if (createMode === 'auto' && mode === 'interactive') preloadInteractive(opts.layers);
  const { createMap } = await import('./create-map.js');
  const map = await createMap(frame, { ...opts, mode: createMode });
  if (mode === 'outline-offer-interactive' && opts.mode !== 'outline') offerInteractive(frame, /** @type {any} */ (map));
  return map;
}

/**
 * Adds the "Load Interactive Map" button next to the outline map.
 * @param {HTMLElement} frame
 * @param {CthdMap & { loadInteractive?: () => Promise<boolean> }} map
 * @returns {void}
 */
function offerInteractive(frame, map) {
  const host = frame.parentElement?.querySelector(':scope > .map-extras');
  if (!host || typeof map.loadInteractive !== 'function') return;
  const msg = h('span', { class: 'map-offer__message', role: 'status' });
  const button = /** @type {HTMLButtonElement} */ (h('button', { type: 'button', class: 'btn btn--secondary map-offer__button' }, INTERACTIVE_OFFER));
  const offer = h('div', { class: 'map-offer' }, button, msg);
  host.prepend(offer);
  button.addEventListener('click', async () => {
    button.disabled = true;
    msg.textContent = 'Loading the interactive map.';
    const ok = await /** @type {() => Promise<boolean>} */ (map.loadInteractive)();
    if (ok) offer.remove();
    else {
      button.disabled = false;
      msg.textContent = 'The interactive map could not start on this device; outlines remain.';
    }
  });
}
