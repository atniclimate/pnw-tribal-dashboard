// @ts-check
/**
 * The one place a MapLibre map is constructed (blueprint 4.1). Mounts the sovereignty note, attribution, and outline layer before resolving; switches to outline mode on GPU failure. DOM module.
 *
 * Structure (blueprint 4.1, 4.5, 4.6, 4.8):
 *   frame (the page's `.map-frame__viewport`)
 *     div.map-canvas           MapLibre container, or the outline SVG
 *     div.map-status           status pill and its detail
 *   div.sovereignty-note       a sibling after the frame, never inside the canvas; mounted first
 *   p.map-attribution          outline mode (interactive mode uses the AttributionControl)
 *   div.map-extras             legend, notices, "Features on the Map"
 *
 * `createMap` throws without `opts.sovereignty.sourceIds`. The note and the structural mounts happen before
 * anything is loaded, so a failed library, tile, or file never removes them. A GPU failure, a worker
 * error, a 20 second load timeout, or a lost context that does not restore within 5 seconds swaps the
 * interactive map for outline mode in place, keeping the note.
 *
 * Owner: lane L8.
 */
import { clear, h } from '../core/dom.js';
import { fetchLocal } from '../core/net.js';
import { findSource, loadSources } from '../core/sources.js';
import { APP } from '../config/app.js';
import { statusPill, updateStatusPill } from '../ui/status-pill.js';
import { attributionLines, mountAttribution } from './attribution.js';
import { createFeatureList } from './feature-list.js';
import { renderOutlineMap } from './fallback-svg.js';
import { renderLegend } from './legend.js';
import { loadMapLibre, loadMapStyles, loadTopojson } from './loader.js';
import { mountSovereigntyNote, setSovereigntyDatasets, sovereigntyControl } from './sovereignty.js';
import { buildStyle } from './style.js';
import { probeWebGL } from './support.js';
import { OUTLINES_FILE, alertPolygons, boundsForViewport, decodeOutlines, paddedBounds } from './topo.js';

/** @typedef {import('../types.js').CreateMapOptions} CreateMapOptions */
/** @typedef {import('../types.js').CthdMap} CthdMap */
/** @typedef {import('../types.js').FeatureItem} FeatureItem */
/** @typedef {import('../types.js').FeatureCollection} FeatureCollection */
/** @typedef {import('./style.js').MapLayerX} MapLayerX */
/** @typedef {import('./style.js').MapContext} MapContext */
/**
 * The contract handle plus additions: `loadInteractive` (the "Load Interactive Map" offer), `camera` and
 * `inspect` (read-only, for the page and the tests), and `reason` (why outline mode is showing).
 * @typedef {CthdMap & {
 *   loadInteractive(): Promise<boolean>,
 *   setBcHazards(collection: unknown): void,
 *   camera(): { lng: number, lat: number, zoom: number } | null,
 *   rendered(): { kind: string, id: string, name: string, source: string }[],
 *   inspect(): { glyphs: string | null, sprite: unknown, layers: { id: string, type: string, text: boolean, visible: boolean, minzoom: number | null, maxzoom: number | null, dashed: boolean }[], sources: string[] } | null,
 *   readonly reason: string,
 * }} CthdMapHandle
 */

export const DEGRADED_TEXT = 'Interactive map unavailable on this device right now; outlines shown.';
export const NONE_TEXT = 'This device cannot draw the interactive map. Outlines and the alert list are shown.';
const FALLBACK_BOX = /** @type {[number, number, number, number]} */ ([-143, 36, -104, 62]);
const NATION_ID = /^[a-z0-9-]{3,100}$/;

/** House-style strings for every MapLibre UI string (blueprint 4.1). */
const LOCALE = Object.freeze({
  'NavigationControl.ZoomIn': 'Zoom In',
  'NavigationControl.ZoomOut': 'Zoom Out',
  'NavigationControl.ResetBearing': 'Reset Bearing',
  'AttributionControl.ToggleAttribution': 'Toggle Attribution',
  'AttributionControl.MapFeedback': 'Map Feedback',
  'Popup.Close': 'Close Popup',
  'Marker.Title': 'Selected Nation',
  'CooperativeGesturesHandler.WindowsHelpText': 'Use Ctrl plus scroll to zoom the map',
  'CooperativeGesturesHandler.MacHelpText': 'Use Command plus scroll to zoom the map',
  'CooperativeGesturesHandler.MobileHelpText': 'Use two fingers to move the map',
});

/**
 * Layer factories by requested id, imported only when the interactive map starts: outline mode needs no
 * layer module, so it never requests one. Outlines is always added.
 * @type {Readonly<Record<string, () => Promise<(o?: Record<string, unknown>) => MapLayerX>>>}
 */
const LAYER_MODULES = Object.freeze({
  basemap: () => import('./layers/basemap.js').then((m) => m.createBasemapLayer),
  radar: () => import('./layers/radar.js').then((m) => m.createRadarLayer),
  outlines: () => import('./layers/outlines.js').then((m) => m.createOutlinesLayer),
  boundaries: () => import('./layers/boundaries.js').then((m) => m.createBoundariesLayer),
  zones: () => import('./layers/zones.js').then((m) => m.createZonesLayer),
  alerts: () => import('./layers/alerts.js').then((m) => m.createAlertsLayer),
  bc: () => import('./layers/bc.js').then((m) => m.createBcLayer),
  gauges: () => import('./layers/gauges.js').then((m) => m.createGaugesLayer),
  hq: () => import('./layers/hq.js').then((m) => m.createHqLayer),
});

/** Draw order for adding layers; outlines first, then the basemap beneath, as blueprint 4.1 specifies. */
const ADD_ORDER = Object.freeze(['outlines', 'basemap', 'radar', 'boundaries', 'zones', 'alerts', 'bc', 'gauges', 'hq']);
/** Layers that need no network before the first idle; awaited before createMap resolves. */
const AWAITED = new Set(['outlines', 'basemap']);

/** Map style source name to the feature kind and id property used to select it. */
const SOURCE_KIND = Object.freeze({
  hq: ['nation', 'nationId'],
  alerts: ['alert', 'alertId'],
  zones: ['alert', 'alertId'],
  gauges: ['gauge', 'gaugeId'],
  bc: ['bc-hazard', 'bcId'],
});
const HIT_LAYERS = Object.freeze(['hq:overview', 'hq:no-polygon', 'gauges:nwps', 'gauges:wsc', 'alerts:fill', 'zones:fill', 'bc:fill']);

/**
 * Lets the browser run other work (input, paint) before the next step; `scheduler.yield` where it exists.
 * @returns {Promise<void>}
 */
const yieldToMain = () => {
  const sched = /** @type {any} */ (globalThis).scheduler;
  return typeof sched?.yield === 'function' ? sched.yield() : new Promise((resolve) => setTimeout(resolve, 0));
};

/** @returns {boolean} */
const reducedMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

/**
 * Rejects after `ms` unless the promise settles first.
 * @template T
 * @param {Promise<T>} p
 * @param {number} ms
 * @param {string} what
 * @returns {Promise<T>}
 */
function withTimeout(p, ms, what) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${what} timed out`)), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

/**
 * @param {FeatureCollection | null} fc
 * @returns {[number, number, number, number]}
 */
function footprintBox(fc) {
  let w = Infinity; let s = Infinity; let e = -Infinity; let n = -Infinity;
  const walk = (/** @type {any} */ c) => {
    if (typeof c?.[0] === 'number') {
      if (c[0] < w) w = c[0]; if (c[0] > e) e = c[0]; if (c[1] < s) s = c[1]; if (c[1] > n) n = c[1];
    } else if (Array.isArray(c)) for (const x of c) walk(x);
  };
  for (const f of fc?.features ?? []) walk(/** @type {any} */ (f.geometry)?.coordinates);
  return Number.isFinite(w) ? [w, s, e, n] : FALLBACK_BOX;
}

/**
 * Throws if opts.sovereignty is missing or lists no source ids, in either mode.
 * @param {HTMLElement} frame
 * @param {CreateMapOptions} opts
 * @returns {Promise<CthdMapHandle>}
 */
export async function createMap(frame, opts) {
  if (!opts || !opts.sovereignty || !Array.isArray(opts.sovereignty.sourceIds) || opts.sovereignty.sourceIds.length === 0) {
    throw new Error('createMap requires opts.sovereignty.sourceIds: every map carries the sovereignty statement (blueprint 4.5)');
  }
  if (!(frame instanceof HTMLElement)) throw new Error('createMap needs a map frame element');
  if (typeof opts.label !== 'string' || !opts.label.trim()) throw new Error('createMap needs opts.label');
  const sourceIds = opts.sovereignty.sourceIds.slice();
  const lowData = document.documentElement.hasAttribute('data-lowdata');
  const controller = new AbortController();
  const startedAt = performance.now();
  // The outlines file is the one data file both modes need; fetch it at once, decode it when topojson-client is in.
  const outlinesRequest = fetchLocal(OUTLINES_FILE, { signal: controller.signal, priority: 1, ttlMs: 3_600_000 });

  // ---- Structural mounts: synchronous, before anything is loaded -------------------------------
  frame.classList.add('map-frame__viewport');
  frame.setAttribute('role', 'region');
  frame.setAttribute('aria-label', opts.label);
  const canvas = h('div', { class: 'map-canvas' });
  const statusEl = h('div', { class: 'map-status', 'aria-live': 'polite' }, h('span', { class: 'map-status__loading' }, 'Loading Map'));
  const summary = h('p', { class: 'visually-hidden map-summary' }, `${opts.label}. The same information is in the list on this page.`);
  const printHost = h('div', { class: 'map-print', 'aria-hidden': 'true' });
  frame.replaceChildren(canvas, statusEl, summary, printHost);
  const note = mountSovereigntyNote(frame, { sourceIds, datasets: [] });
  const extras = h('div', { class: 'map-extras' });
  note.after(extras);
  const notice = h('p', { class: 'map-notice', hidden: true });
  const legendEl = h('ul', { class: 'map-legend', 'aria-label': 'Map Legend' });
  const listHost = h('div', { class: 'map-feature-list-host' });
  extras.append(notice, legendEl, listHost);
  frame.dataset.mapMode = 'loading';

  /**
   * State shared by both modes.
   * @type {{
   *   mode: 'interactive' | 'outline', destroyed: boolean, reason: string,
   *   alerts: import('../types.js').DashboardAlert[], gauges: import('../types.js').GaugeStatus[], bc: unknown,
   *   nationId: string | null, nationRecord: any, nationDetail: FeatureCollection | null,
   *   layerOn: Map<string, boolean>, listeners: Set<(mode: 'interactive' | 'outline', reason: string) => void>,
   *   datasets: { name: string, vintage: string }[],
   *   outlines: FeatureCollection | null, topojson: typeof import('topojson-client') | null,
   * }}
   */
  const S = {
    mode: 'outline', destroyed: false, reason: '', alerts: [], gauges: [], bc: null, nationId: null, nationRecord: null,
    nationDetail: null, layerOn: new Map(), listeners: new Set(), datasets: [], outlines: null, topojson: null,
  };

  /** @type {import('maplibre-gl').Map | null} */
  let map = null;
  /** @type {typeof import('maplibre-gl') | null} */
  let maplibregl = null;
  /** @type {Map<string, MapLayerX>} */
  const layers = new Map();
  /** @type {Map<string, import('../types.js').StatusSnapshot>} */
  const layerStatuses = new Map();
  /** @type {ReturnType<typeof renderOutlineMap> | null} */
  let outline = null;
  /** @type {ReturnType<typeof createFeatureList> | null} */
  let list = null;
  /** @type {import('maplibre-gl').Popup | null} */
  let popup = null;
  /** @type {import('maplibre-gl').Marker | null} */
  let marker = null;
  /** @type {(() => void)[]} */
  let mapCleanups = [];
  /** @type {ReturnType<typeof setTimeout> | null} */
  let moveTimer = null;
  /** @type {ReturnType<typeof setTimeout> | null} */
  let lossTimer = null;
  /** @type {Promise<unknown>} */
  let transition = Promise.resolve();
  /** @type {[number, number, number, number]} */
  let footprint = FALLBACK_BOX;
  /** @type {{ lng: number, lat: number, zoom: number } | null} */
  let initialCamera = null;
  let selectedKey = '';
  let readyMarked = false;

  const token = (/** @type {string} */ name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const lookup = (/** @type {string} */ id) => findSource(id);

  /** @param {import('../types.js').StatusState} state @param {string} label @param {string} [detail] */
  function setPill(state, label, detail) {
    if (S.destroyed) return;
    frame.dataset.mapState = state;
    const pill = /** @type {HTMLElement | null} */ (statusEl.querySelector('.status-pill'));
    if (pill) updateStatusPill(pill, state, label);
    else statusEl.replaceChildren(statusPill(state, label));
    let d = statusEl.querySelector('.map-status__detail');
    if (!d) { d = h('span', { class: 'map-status__detail' }); statusEl.append(d); }
    d.textContent = detail ?? '';
  }

  /** @param {string} text */
  function setNotice(text) {
    notice.textContent = text;
    notice.hidden = !text;
  }

  function refreshLegend() {
    if (S.destroyed) return;
    /** @type {import('../types.js').LegendItem[]} */
    let items = [];
    if (S.mode === 'interactive') {
      for (const name of ADD_ORDER) {
        const l = layers.get(name);
        if (l && S.layerOn.get(name) !== false) items.push(...l.legendItems());
      }
    } else {
      items = [
        { id: 'outlines', label: 'State, Province, and County Outlines', swatchClass: 'map-swatch--outline' },
        { id: 'nation', label: 'Selected Nation Land Area', swatchClass: 'legend__swatch--selected-nation' },
        { id: 'zone-only', label: 'Zone-Based Alerts', swatchClass: 'map-swatch--none', note: 'Named in the alert list; not drawn in outline mode.' },
        { id: 'alert-polygon', label: 'Alert Areas Drawn by Forecasters', swatchClass: 'map-swatch--alert map-swatch--severe' },
        { id: 'radar', label: 'Radar', swatchClass: 'map-swatch--none', note: 'Needs the interactive map.' },
        { id: 'gauges', label: 'River Gauges', swatchClass: 'map-swatch--none', note: 'Needs the interactive map.' },
      ];
    }
    renderLegend(legendEl, items);
  }

  /** @returns {FeatureItem[]} */
  function collectItems() {
    /** @type {FeatureItem[]} */
    const items = [];
    if (S.mode === 'interactive') {
      for (const [name, l] of layers) {
        if (S.layerOn.get(name) === false || !l.featureItems) continue;
        items.push(...l.featureItems());
      }
      return items;
    }
    const hq = S.nationRecord?.hq;
    if (S.nationId && S.nationRecord && hq) items.push({ kind: 'nation', id: S.nationId, name: S.nationRecord.preferredName ?? S.nationRecord.name, lngLat: [hq.lon, hq.lat] });
    for (const f of alertPolygons(S.alerts).features) {
      const p = /** @type {any} */ (f.properties);
      items.push({ kind: 'alert', id: p.alertId, name: p.name, lngLat: [0, 0] });
    }
    return items;
  }

  function refreshList() {
    if (S.destroyed || !list) return;
    let items = collectItems();
    /** @type {[number, number] | null} */
    let center = null;
    if (S.mode === 'interactive' && map) {
      // The view plus a margin: an icon whose center is just off screen can still be partly drawn.
      const pad = 32;
      const w = canvas.clientWidth;
      const h2 = canvas.clientHeight;
      const sw = map.unproject([-pad, h2 + pad]);
      const ne = map.unproject([w + pad, -pad]);
      items = items.filter((i) => i.lngLat[0] >= sw.lng && i.lngLat[0] <= ne.lng && i.lngLat[1] >= sw.lat && i.lngLat[1] <= ne.lat);
      const c = map.getCenter();
      center = [c.lng, c.lat];
    }
    list.update(items, center);
  }

  /** @type {ReturnType<typeof setTimeout> | null} */
  let refreshTimer = null;
  /** Layers report in bursts while they load; one coalesced refresh keeps that from becoming a long task. */
  function scheduleRefresh() {
    if (refreshTimer || S.destroyed) return;
    refreshTimer = setTimeout(() => { refreshTimer = null; refreshLegend(); refreshList(); }, 80);
  }

  /** @param {(mode: 'interactive' | 'outline', reason: string) => void} fn */
  function notify(fn) { try { fn(S.mode, S.reason); } catch { /* a listener must not break the map */ } }

  // ---- Registry, datasets, and files -----------------------------------------------------------
  /** @returns {Promise<void>} */
  async function loadRegistry() {
    try { await loadSources(controller.signal); } catch { /* the note and attribution fall back to what they have */ }
  }

  function datasetsFromRegistry() {
    /** @type {{ name: string, vintage: string }[]} */
    const out = [];
    for (const id of sourceIds) {
      const rec = lookup(id);
      if (rec) out.push({ name: rec.title, vintage: `verified ${usDate(String(rec.verifiedAt))}` });
    }
    return out;
  }

  /** @param {string} iso */
  function usDate(iso) {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
    return m ? `${m[2]}/${m[3]}/${m[1]}` : iso;
  }

  /**
   * @param {{ name: string, vintage: string }[]} datasets
   * @param {string} [extra]
   */
  function setDatasets(datasets, extra) {
    S.datasets = datasets;
    setSovereigntyDatasets(note, datasets.length ? datasets : datasetsFromRegistry(), extra);
  }

  async function ensureOutlines() {
    if (S.outlines || !S.topojson) return;
    const res = await outlinesRequest;
    if (!res.ok) return;
    try {
      S.outlines = decodeOutlines(res.data, S.topojson);
      footprint = footprintBox(S.outlines);
    } catch { /* an undecodable file leaves outline data unavailable, which the map states */ }
  }

  // ---- Outline mode ---------------------------------------------------------------------------
  /** @returns {FeatureCollection | null} */
  function nationCollection() {
    if (!S.nationId) return null;
    /** @type {any[]} */
    const features = [...(S.nationDetail?.features ?? [])];
    const hq = S.nationRecord?.hq;
    if (hq) features.push({ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [hq.lon, hq.lat] } });
    return { type: 'FeatureCollection', features };
  }

  function drawOutline() {
    if (!S.outlines) {
      canvas.replaceChildren(h('p', { class: 'map-canvas__empty' }, 'Outline data is unavailable. The alert list has the same information.'));
      return;
    }
    const opts2 = { outlines: S.outlines, nation: nationCollection(), alerts: alertPolygons(S.alerts), label: opts.label };
    if (outline && outline.svg.isConnected) outline.update({ nation: opts2.nation, alerts: opts2.alerts });
    else outline = renderOutlineMap(canvas, opts2);
  }

  /**
   * @param {string} reason
   * @param {'live' | 'degraded'} state
   * @param {string} pillLabel
   */
  async function showOutline(reason, state, pillLabel) {
    S.mode = 'outline';
    S.reason = reason;
    frame.dataset.mapMode = 'outline';
    setNotice(state === 'live' ? reason : '');
    canvas.classList.remove('map-canvas--interactive');
    canvas.classList.add('map-canvas--outline');
    await ensureOutlines();
    if (S.destroyed) return;
    drawOutline();
    // Outline mode requests no tile (blueprint 4.8), so its line credits only what it draws: the boundary
    // datasets the sovereignty note names, and the outlines. No basemap or layer source appears here.
    mountAttribution(frame, attributionLines([...new Set(sourceIds)], lookup).concat(['Outlines: U.S. Census Bureau, Province of British Columbia']));
    setPill(state, pillLabel, state === 'degraded' ? reason : '');
    refreshLegend();
    refreshList();
    if (!readyMarked) { readyMarked = true; performance.mark('map-ready'); }
  }

  // ---- Interactive mode -----------------------------------------------------------------------
  function teardownInteractive() {
    if (lossTimer) clearTimeout(lossTimer);
    lossTimer = null;
    if (moveTimer) clearTimeout(moveTimer);
    moveTimer = null;
    for (const c of mapCleanups.splice(0)) { try { c(); } catch { /* already detached */ } }
    popup?.remove();
    popup = null;
    marker?.remove();
    marker = null;
    for (const l of layers.values()) { try { l.remove(); } catch { /* map already gone */ } }
    layers.clear();
    layerStatuses.clear();
    const m = map;
    map = null;
    if (m) {
      try {
        const gl = /** @type {any} */ (m.getCanvas().getContext('webgl2'));
        gl?.getExtension('WEBGL_lose_context')?.loseContext();
      } catch { /* the context is already lost */ }
      try { m.remove(); } catch { /* removal after a lost context can throw */ }
    }
    canvas.replaceChildren();
    canvas.classList.remove('map-canvas--interactive');
  }

  /** @param {string} reason */
  function fallback(reason) {
    if (S.destroyed || S.mode === 'outline') return;
    transition = transition.then(async () => {
      if (S.destroyed || S.mode === 'outline') return;
      teardownInteractive();
      await showOutline(reason, 'degraded', 'Map Degraded');
      for (const fn of [...S.listeners]) notify(fn);
    });
  }

  /** @param {string} kind @param {string} id */
  function highlight(kind, id) {
    const key = `${kind}:${id}`;
    if (selectedKey === key) return;
    for (const l of layers.values()) l.highlight?.(null);
    selectedKey = key;
    const target = kind === 'nation' ? layers.get('hq') : layers.get(kind === 'alert' ? 'alerts' : kind === 'gauge' ? 'gauges' : 'bc');
    target?.highlight?.(id);
    if (kind === 'nation') layers.get('boundaries')?.highlight?.(id);
  }

  function clearHighlight() {
    selectedKey = '';
    for (const l of layers.values()) l.highlight?.(null);
  }

  /** @param {FeatureItem} item */
  function openPopup(item) {
    if (!map || !maplibregl) return;
    popup?.remove();
    const lines = [h('strong', { class: 'map-popup__title' }, item.name)];
    if (item.kind === 'nation') {
      lines.push(h('p', { class: 'map-popup__line' }, 'Representation, not jurisdiction.'));
      if (S.datasets.length) lines.push(h('p', { class: 'map-popup__line' }, S.datasets.map((d) => `${d.name}, ${d.vintage}`).join('; ')));
    }
    const content = h('div', { class: 'map-popup' }, lines);
    const p = new maplibregl.Popup({ closeOnClick: false, closeButton: true, maxWidth: '280px' }).setLngLat(item.lngLat).setDOMContent(content).addTo(map);
    popup = p;
    /** @param {KeyboardEvent} e */
    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      p.remove();
    };
    document.addEventListener('keydown', onKey);
    p.on('close', () => {
      document.removeEventListener('keydown', onKey);
      if (popup === p) popup = null;
      list?.focusItem(item.kind, item.id);
    });
  }

  /** @param {FeatureItem} item */
  function activate(item) {
    highlight(item.kind, item.id);
    if (S.mode === 'interactive') openPopup(item);
    opts.onSelect?.({ kind: item.kind, id: item.id });
  }

  /** @param {string} name */
  function layerCtx(name) {
    /** @type {MapContext} */
    const ctx = {
      mode: 'interactive',
      map,
      maplibregl,
      fetchLocal,
      token,
      lowData,
      signal: controller.signal,
      status: (snapshot) => { layerStatuses.set(name, snapshot); onLayerStatus(name, snapshot); },
      topojson: /** @type {typeof import('topojson-client')} */ (S.topojson),
      outlines: name === 'outlines' ? S.outlines : null,
      select: (kind, id) => opts.onSelect?.({ kind, id }),
      setDatasets,
      zoomNow: () => map?.getZoom() ?? 0,
      onZoom: (fn) => {
        const m = map;
        if (!m) return () => {};
        m.on('zoomend', fn);
        return () => m.off('zoomend', fn);
      },
    };
    return ctx;
  }

  /** @param {string} name @param {import('../types.js').StatusSnapshot} snapshot */
  function onLayerStatus(name, snapshot) {
    if (S.destroyed || S.mode !== 'interactive') return;
    if (name === 'basemap') {
      // `degraded` is a real tile failure. `unavailable` is a basemap that is off by configuration (Q10: no key
      // yet); that is not a fault, so the pill stays live and the legend states the absence.
      if (snapshot.state === 'degraded') setPill('degraded', 'Map Degraded', snapshot.detail ?? '');
      else if (snapshot.state === 'live' || snapshot.state === 'unavailable') setPill('live', 'Map Live', '');
    }
    scheduleRefresh();
  }

  /** @returns {Promise<boolean>} */
  async function startInteractive() {
    // One deadline from the request (blueprint 4.8: no `load` within 20 s of the request), shared by the
    // library download and the map's own load, so a slow library leaves less time for the style, not more.
    const deadline = performance.now() + APP.map.loadTimeoutMs;
    const remaining = () => Math.max(0, deadline - performance.now());
    statusEl.replaceChildren(h('span', { class: 'map-status__loading' }, `Loading Map (about ${Math.round(APP.map.interactiveLabelBytes / 1000)} KB)`));
    // The layer modules and the library download together; each layer is built and starts fetching its
    // data files as soon as its module arrives, so the data is waiting when the map exists.
    const requested = new Set(opts.layers);
    requested.add('outlines');
    const maxZoom = innerWidth < 640 ? APP.map.phoneMaxZoom : APP.map.desktopMaxZoom;
    /** @type {Promise<Map<string, MapLayerX>>} */
    const layersPromise = Promise.all(ADD_ORDER.filter((name) => requested.has(name)).map(async (name) => /** @type {const} */ ([name, await LAYER_MODULES[name]?.()])))
      .then((pairs) => {
        /** @type {Map<string, MapLayerX>} */
        const built = new Map();
        for (const [name, factory] of pairs) {
          if (typeof factory !== 'function') continue;
          const layer = factory({ maxZoom });
          built.set(name, layer);
        }
        return built;
      })
      .catch(() => /** @type {Map<string, MapLayerX>} */ (new Map()));
    try {
      maplibregl = await withTimeout(loadMapLibre(), remaining(), 'The map library');
    } catch {
      return false;
    }
    performance.mark('map-lib-loaded');
    // Data files start downloading only now: before this point every byte belongs to the library, and on a
    // slow connection a parallel data download would delay it. The map builds while the files arrive.
    for (const layer of (await layersPromise).values()) layer.prefetch?.({ fetchLocal, signal: controller.signal });
    if (S.destroyed) return false;
    await yieldToMain();
    await ensureOutlines();
    await yieldToMain();
    if (S.destroyed) return false;
    const box = paddedBounds(footprint);
    const limitFor = () => boundsForViewport(box, canvas.clientWidth, canvas.clientHeight);
    const view = opts.view;
    /** @type {import('maplibre-gl').Map} */
    let m;
    const ctorStart = performance.now();
    try {
      m = new maplibregl.Map({
        container: canvas,
        style: buildStyle({ token, lowData }),
        ...(view ? { center: [view.lon, view.lat], zoom: view.zoom } : { bounds: /** @type {any} */ (footprint), fitBoundsOptions: { padding: 8, animate: false } }),
        maxBounds: /** @type {any} */ (limitFor()),
        minZoom: 3,
        maxZoom,
        attributionControl: { compact: false },
        maplibreLogo: false,
        cooperativeGestures: true,
        dragRotate: false,
        pitchWithRotate: false,
        maxPitch: 0,
        renderWorldCopies: false,
        fadeDuration: 0,
        pixelRatio: lowData ? 1 : Math.min(devicePixelRatio || 1, 2),
        maxTileCacheSize: 64,
        refreshExpiredTiles: false,
        canvasContextAttributes: { antialias: false },
        locale: { ...LOCALE, 'Map.Title': opts.label },
      });
    } catch {
      return false;
    }
    // MapLibre's own constructor time is recorded apart from this module's, so the timing tests can tell them
    // apart (blueprint 8.2: the library's work is measured and recorded, not gated).
    performance.measure('map-ctor', { start: ctorStart, end: performance.now() });
    map = m;
    m.touchZoomRotate.disableRotation();
    m.keyboard.disableRotation();
    m.addControl(new maplibregl.NavigationControl({ showCompass: false, showZoom: true }), 'top-right');
    m.addControl(resetControl(), 'top-right');
    m.addControl(sovereigntyControl(note.id), 'bottom-left');

    // Failure watchers (blueprint 4.8).
    /** @param {any} e */
    const onError = (e) => {
      const msg = String(e?.error?.message ?? e?.message ?? '');
      if (!e?.sourceId && /webgl|gpu|worker|context/i.test(msg)) fallback(DEGRADED_TEXT);
    };
    m.on('error', onError);
    const cv = m.getCanvas();
    const onLost = () => {
      if (lossTimer) clearTimeout(lossTimer);
      lossTimer = setTimeout(() => fallback(DEGRADED_TEXT), APP.map.contextRestoreMs);
    };
    const onRestored = () => { if (lossTimer) clearTimeout(lossTimer); lossTimer = null; };
    cv.addEventListener('webglcontextlost', onLost);
    cv.addEventListener('webglcontextrestored', onRestored);
    const onMove = () => {
      if (moveTimer) clearTimeout(moveTimer);
      moveTimer = setTimeout(refreshList, 300);
    };
    m.on('moveend', onMove);
    // Observable camera state on the frame (read by the end-to-end motion checks, blueprint 4.6 and 10.2
    // scenario 17): the settled view as "lng,lat,zoom", and the count of camera frames drawn so far.
    let moves = 0;
    const onCameraFrame = () => { moves += 1; frame.dataset.mapMoves = String(moves); };
    const exposeCamera = () => { const c = m.getCenter(); frame.dataset.mapCamera = `${c.lng.toFixed(5)},${c.lat.toFixed(5)},${m.getZoom().toFixed(3)}`; };
    m.on('move', onCameraFrame);
    m.on('moveend', exposeCamera);
    exposeCamera();
    mapCleanups.push(() => m.off('move', onCameraFrame), () => m.off('moveend', exposeCamera), () => { delete frame.dataset.mapMoves; delete frame.dataset.mapCamera; });
    const onResize = () => { m.setMaxBounds(/** @type {any} */ (limitFor())); };
    m.on('resize', onResize);
    /** @param {any} e */
    const onClick = (e) => {
      const present = HIT_LAYERS.filter((id) => m.getLayer(id));
      if (!present.length) return;
      const f = m.queryRenderedFeatures(e.point, { layers: present })[0];
      if (!f) { popup?.remove(); clearHighlight(); return; }
      const spec = /** @type {Record<string, string[]>} */ (SOURCE_KIND)[f.source];
      if (!spec) return;
      const props = /** @type {any} */ (f.properties ?? {});
      const id = String(props[/** @type {string} */ (spec[1])] ?? '');
      if (!id) return;
      const known = collectItems().find((i) => i.kind === spec[0] && i.id === id);
      activate(known ?? { kind: /** @type {any} */ (spec[0]), id, name: String(props.name ?? id), lngLat: [e.lngLat.lng, e.lngLat.lat] });
      list?.focusItem(/** @type {string} */ (spec[0]), id);
    };
    m.on('click', onClick);
    mapCleanups.push(
      () => m.off('error', onError), () => m.off('moveend', onMove), () => m.off('resize', onResize), () => m.off('click', onClick),
      () => cv.removeEventListener('webglcontextlost', onLost), () => cv.removeEventListener('webglcontextrestored', onRestored),
    );

    /** @type {((e: any) => void) | null} */
    let onLoadError = null;
    try {
      await withTimeout(new Promise((resolve, reject) => {
        if (m.loaded() && m.isStyleLoaded()) { resolve(undefined); return; }
        m.once('load', () => resolve(undefined));
        // `on`, not `once`: a tile error (it carries a sourceId) must not use up the listener, so a later
        // non-source error still rejects. The listener is removed below either way.
        onLoadError = (e) => { if (!e?.sourceId) reject(e?.error ?? new Error('map error')); };
        m.on('error', onLoadError);
      }), remaining(), 'The map');
    } catch {
      return false;
    } finally {
      if (onLoadError) m.off('error', onLoadError);
    }
    if (S.destroyed || map !== m) return false;
    S.mode = 'interactive';
    S.reason = '';
    frame.dataset.mapMode = 'interactive';
    canvas.classList.add('map-canvas--interactive');
    setNotice('');
    const c0 = m.getCenter();
    initialCamera = { lng: c0.lng, lat: c0.lat, zoom: m.getZoom() };

    // Layers: outlines first, then the basemap beneath; the rest load without holding the map back.
    const instances = await layersPromise;
    performance.mark('map-load');
    if (S.destroyed || map !== m) return false;
    /** @param {string} name @param {MapLayerX} layer */
    const addLayer = (name, layer) => Promise.resolve().then(() => layer.add(layerCtx(name))).then(() => {
      if (S.destroyed || map !== m) return;
      pushData(layer);
      // A viewer may have switched this layer off before it reached the map.
      if (S.layerOn.get(name) === false) layer.setVisible(false);
      scheduleRefresh();
    }).catch((err) => {
      layerStatuses.set(name, { state: 'unavailable', asOf: null, detail: `Layer unavailable: ${err instanceof Error ? err.message : 'error'}`, asOfBasis: null, sourceIds: layer.sourceIds, origin: 'direct', completeness: 'partial', checkedAt: new Date().toISOString() });
    });
    for (const name of ADD_ORDER) {
      const layer = instances.get(name);
      if (!layer) continue;
      layers.set(name, layer);
      S.layerOn.set(name, true);
    }
    // map-ready (blueprint 4.6, 8.2): the outlines are drawn, the sovereignty note is mounted, and the first
    // frame with them has rendered. Basemap tiles are not required, so a slow tile host never delays it. The
    // data layers (radar, boundaries, zones, alerts, gauges, headquarters) start right after it, in draw order;
    // a two second timer starts them if this device never reports the outline source as loaded.
    let restStarted = false;
    const startRest = () => {
      if (restStarted || S.destroyed || map !== m) return;
      restStarted = true;
      void (async () => {
        // One layer per task, so a long list never makes one long task on a slow phone.
        for (const name of ADD_ORDER.filter((n) => !AWAITED.has(n))) {
          const layer = layers.get(name);
          if (layer && !S.destroyed && map === m) void addLayer(name, layer);
          await yieldToMain();
        }
      })();
    };
    const markReady = () => {
      if (!readyMarked && !S.destroyed) { readyMarked = true; performance.mark('map-ready'); }
      startRest();
    };
    /** @param {any} e */
    const onOutlinesLoaded = (e) => {
      if (e?.sourceId !== 'outlines' || !e.isSourceLoaded) return;
      m.off('sourcedata', onOutlinesLoaded);
      m.once('render', markReady);
    };
    m.on('sourcedata', onOutlinesLoaded);
    m.once('idle', markReady);
    const restTimer = setTimeout(startRest, 2000);
    mapCleanups.push(() => m.off('sourcedata', onOutlinesLoaded), () => clearTimeout(restTimer));
    // Phase one: the outline layer, then the basemap beneath it. Neither waits on the network.
    for (const name of ADD_ORDER.filter((n) => AWAITED.has(n))) {
      const layer = layers.get(name);
      if (layer) await addLayer(name, layer);
      if (S.destroyed || map !== m) return false;
    }
    mountAttributionNote();
    setPill('live', 'Map Live', '');
    refreshLegend();
    refreshList();
    return true;
  }

  function mountAttributionNote() {
    // The AttributionControl prints each source's attribution; nothing else is needed in interactive mode.
    const stale = frame.parentElement?.querySelector(':scope > .map-attribution');
    stale?.remove();
  }

  /** @returns {import('maplibre-gl').IControl} */
  function resetControl() {
    /** @type {HTMLElement | null} */
    let el = null;
    return {
      onAdd() {
        const b = h('button', { type: 'button', class: 'cthd-reset-view', 'aria-label': 'Reset View', title: 'Reset View' }, 'Reset');
        b.addEventListener('click', () => {
          if (!map || !initialCamera) return;
          map.jumpTo({ center: [initialCamera.lng, initialCamera.lat], zoom: initialCamera.zoom });
        });
        el = h('div', { class: 'maplibregl-ctrl maplibregl-ctrl-group cthd-reset-ctrl' }, b);
        return el;
      },
      onRemove() { el?.remove(); el = null; },
    };
  }

  /** @param {MapLayerX} layer */
  function pushData(layer) {
    if (!layer.setData) return;
    if (layer.id === 'alerts' || layer.id === 'zones') layer.setData({ alerts: S.alerts });
    else if (layer.id === 'gauges') layer.setData({ gauges: S.gauges });
    else if (layer.id === 'bc' && S.bc !== null) layer.setData({ bc: S.bc });
  }

  // ---- Nation focus ---------------------------------------------------------------------------
  /** @param {string | null} id */
  async function focus(id) {
    if (S.destroyed) return;
    marker?.remove();
    marker = null;
    if (!id || !NATION_ID.test(id)) {
      S.nationId = null; S.nationRecord = null; S.nationDetail = null;
      clearHighlight();
      setDatasets([]);
      await layers.get('boundaries')?.focus?.(null);
      if (S.mode === 'outline') { drawOutline(); refreshList(); }
      return;
    }
    S.nationId = id;
    const rec = await fetchLocal(`data/registry/nations/${id}.json`, { signal: controller.signal, priority: 1 });
    if (S.destroyed || S.nationId !== id) return;
    S.nationRecord = rec.ok ? rec.data : null;
    S.nationDetail = null;
    const record = S.nationRecord;
    if (S.mode === 'interactive') {
      highlight('nation', id);
      await layers.get('boundaries')?.focus?.(record);
      const hq = record?.hq ?? null;
      const known = layers.get('hq')?.lookup?.(id) ?? null;
      const name = record ? (record.preferredName ?? record.name) : known?.name;
      const at = hq ? /** @type {[number, number]} */ ([hq.lon, hq.lat]) : known?.lngLat;
      if (maplibregl && map && at && name) {
        marker = new maplibregl.Marker({ element: h('div', { class: 'map-nation-label' }, name), anchor: 'bottom', offset: [0, -10] }).setLngLat(at).addTo(map);
      }
      if (map && record?.bbox) moveCamera(/** @type {[number, number, number, number]} */ (record.bbox), record.boundary?.status === 'point-only');
      else if (map && at) map.jumpTo({ center: at, zoom: 9 });
    } else {
      setDatasets([], record?.boundary?.status === 'point-only' ? 'No land-area boundary is published in the federal sources used here; headquarters location shown.' : undefined);
      const ref = record?.boundary?.detailRef;
      if (ref) {
        const d = await fetchLocal(`data/${ref}`, { signal: controller.signal, priority: 1 });
        if (S.destroyed || S.nationId !== id) return;
        S.nationDetail = d.ok ? /** @type {any} */ (d.data) : null;
      }
      drawOutline();
      refreshList();
    }
  }

  /**
   * Camera change with no flyTo: jumpTo under reduced motion, otherwise an ease of at most 300 ms.
   * @param {[number, number, number, number]} bbox
   * @param {boolean} pointOnly
   */
  function moveCamera(bbox, pointOnly) {
    if (!map) return;
    const options = { padding: 32, maxZoom: pointOnly ? 9 : 12 };
    if (reducedMotion()) {
      const cam = map.cameraForBounds(/** @type {any} */ (bbox), options);
      if (cam) map.jumpTo(cam);
    } else {
      map.fitBounds(/** @type {any} */ (bbox), { ...options, linear: true, duration: 300 });
    }
  }

  // Print always uses the outline picture: a WebGL canvas prints blank (blueprint 4.8).
  /** @type {ReturnType<typeof renderOutlineMap> | null} */
  let printed = null;
  function onBeforePrint() {
    if (S.destroyed || S.mode !== 'interactive' || !S.outlines) return;
    printed = renderOutlineMap(printHost, { outlines: S.outlines, nation: nationCollection(), alerts: alertPolygons(S.alerts), label: opts.label });
  }
  function onAfterPrint() {
    printed?.destroy();
    printed = null;
    printHost.replaceChildren();
  }
  addEventListener('beforeprint', onBeforePrint);
  addEventListener('afterprint', onAfterPrint);

  // ---- Start ---------------------------------------------------------------------------------
  list = createFeatureList(listHost, {
    onActivate: (item) => activate(item),
    onFocus: (item) => highlight(item.kind, item.id),
    cap: APP.map.featureListCap,
  });
  // Everything outline mode needs downloads at once: styles, the registry, topojson-client, and the outlines file.
  const [, , topojson] = await Promise.all([loadMapStyles(), loadRegistry(), loadTopojson().catch(() => null)]);
  S.topojson = topojson;
  setDatasets([]);
  // Attribution is mounted for outline mode and replaced by the AttributionControl in interactive mode.
  const wanted = opts.mode === 'outline' ? 'outline' : probeWebGL() === 'none' ? 'none' : 'interactive';
  if (wanted === 'interactive') {
    const ok = await startInteractive();
    if (!ok && !S.destroyed) {
      teardownInteractive();
      await showOutline(DEGRADED_TEXT, 'degraded', 'Map Degraded');
    }
  } else if (wanted === 'none') {
    await showOutline(NONE_TEXT, 'live', 'Outline Map');
  } else {
    await showOutline('Outlines shown. The interactive map is available on request.', 'live', 'Outline Map');
  }
  if (!topojson) {
    setPill('degraded', 'Map Degraded', 'Map data could not be loaded.');
  }
  refreshList();
  performance.measure?.('map-create', { start: startedAt });

  /** @type {CthdMapHandle} */
  const handle = {
    get mode() { return S.mode; },
    get reason() { return S.reason; },
    setAlerts(a) {
      S.alerts = Array.isArray(a) ? a : [];
      for (const l of layers.values()) if (l.id === 'alerts' || l.id === 'zones') l.setData?.({ alerts: S.alerts });
      if (S.mode === 'outline') drawOutline();
      refreshList();
    },
    setGauges(g) {
      S.gauges = Array.isArray(g) ? g : [];
      layers.get('gauges')?.setData?.({ gauges: S.gauges });
      refreshList();
    },
    setBcHazards(collection) {
      S.bc = collection ?? null;
      layers.get('bc')?.setData?.({ bc: S.bc });
      scheduleRefresh();
    },
    focusNation(id) { void focus(id); },
    setLayer(id, on) {
      S.layerOn.set(id, on);
      layers.get(id)?.setVisible(on);
      refreshLegend();
      refreshList();
    },
    onModeChange(fn) {
      S.listeners.add(fn);
      return () => { S.listeners.delete(fn); };
    },
    async loadInteractive() {
      if (S.destroyed || S.mode === 'interactive') return S.mode === 'interactive';
      if (probeWebGL() === 'none') return false;
      let ok = false;
      transition = transition.then(async () => {
        if (S.destroyed) return;
        outline?.destroy();
        outline = null;
        frame.parentElement?.querySelector(':scope > .map-attribution')?.remove();
        ok = await startInteractive();
        if (!ok && !S.destroyed) {
          teardownInteractive();
          await showOutline(DEGRADED_TEXT, 'degraded', 'Map Degraded');
        }
        for (const fn of [...S.listeners]) notify(fn);
      });
      await transition;
      return ok;
    },
    inspect() {
      if (!map) return null;
      const style = map.getStyle();
      return {
        glyphs: style.glyphs ?? null,
        sprite: style.sprite ?? null,
        layers: style.layers.map((l) => ({
          id: l.id,
          type: l.type,
          text: l.type === 'symbol' && Boolean(/** @type {any} */ (l).layout?.['text-field']),
          visible: /** @type {any} */ (l).layout?.visibility !== 'none',
          minzoom: /** @type {any} */ (l).minzoom ?? null,
          maxzoom: /** @type {any} */ (l).maxzoom ?? null,
          dashed: Boolean(/** @type {any} */ (l).paint?.['line-dasharray']),
        })),
        sources: Object.keys(style.sources),
      };
    },
    rendered() {
      if (!map) return [];
      const present = HIT_LAYERS.filter((id) => map?.getLayer(id));
      if (!present.length) return [];
      /** @type {Map<string, { kind: string, id: string, name: string, source: string }>} */
      const out = new Map();
      for (const f of map.queryRenderedFeatures(undefined, { layers: present })) {
        const spec = /** @type {Record<string, string[]>} */ (SOURCE_KIND)[f.source];
        const props = /** @type {any} */ (f.properties ?? {});
        const id = spec ? String(props[/** @type {string} */ (spec[1])] ?? '') : '';
        if (spec && id) out.set(`${spec[0]}:${id}`, { kind: /** @type {string} */ (spec[0]), id, name: String(props.name ?? ''), source: f.source });
      }
      return [...out.values()];
    },
    camera() {
      if (!map) return null;
      const c = map.getCenter();
      return { lng: c.lng, lat: c.lat, zoom: map.getZoom() };
    },
    destroy() {
      if (S.destroyed) return;
      S.destroyed = true;
      if (refreshTimer) clearTimeout(refreshTimer);
      controller.abort();
      teardownInteractive();
      outline?.destroy();
      outline = null;
      list?.destroy();
      list = null;
      S.listeners.clear();
      removeEventListener('beforeprint', onBeforePrint);
      removeEventListener('afterprint', onAfterPrint);
      note.remove();
      extras.remove();
      frame.parentElement?.querySelector(':scope > .map-attribution')?.remove();
      clear(frame);
      frame.removeAttribute('data-map-mode');
      frame.removeAttribute('data-map-state');
    },
  };
  return handle;
}
