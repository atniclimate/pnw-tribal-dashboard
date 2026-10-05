// @ts-check
/**
 * Tribal Nation land-area representations: the overview at zoom seven and above (or when toggled in the
 * footprint view) and the selected Nation's detail file. Implements MapLayer (blueprint 4.2, 4.4, 4.5).
 *
 * Tribal Magenta (read from its token) marks land. The sovereignty statement travels with this layer: when
 * a Nation is selected, the note's dataset line names the datasets and vintages of that Nation's parts, and
 * a Nation with no published polygon says so (blueprint 4.5).
 *
 * Owner: lane L8.
 */
import { findSource } from '../../core/sources.js';
import { decodeTopo } from '../topo.js';
import { NO_BOUNDARY_TEXT } from '../sovereignty.js';
import { addOrdered, layerStatus, removeAll, setLayersVisible } from '../style.js';

/** @typedef {import('../style.js').MapContext} MapContext */
/** @typedef {import('../style.js').MapLayerX} MapLayerX */

export const OVERVIEW_FILE = 'data/geo/boundaries-overview.topo.json';
export const OVERVIEW_MIN_ZOOM = 7;
export const BOUNDARY_SOURCE_IDS = ['bia-lar', 'census-aiannh-2025', 'nrcan-aboriginal-lands-bc'];

/**
 * @param {any} record a Nation record (data/registry/nations/<id>.json)
 * @returns {{ name: string, vintage: string }[]}
 */
export function datasetsOf(record) {
  /** @type {{ name: string, vintage: string }[]} */
  const out = [];
  for (const part of record?.boundary?.parts ?? []) {
    const title = findSource(part.sourceId)?.title ?? String(part.sourceId);
    const row = { name: title, vintage: `retrieved ${part.vintage}` };
    if (!out.some((d) => d.name === row.name && d.vintage === row.vintage)) out.push(row);
  }
  return out;
}

/**
 * @param {import('maplibre-gl').Map} map
 * @param {string} src
 * @param {string} tag
 * @param {(name: string) => string} token
 * @returns {string[]} layer ids
 */
function addBoundaryLayers(map, src, tag, token) {
  const magenta = token('--tribal-magenta');
  const selected = ['boolean', ['feature-state', 'selected'], false];
  const trust = ['==', ['get', 'kind'], 'off-reservation-trust-land'];
  return [
    addOrdered(map, 'boundaries', { id: `${tag}-fill`, type: 'fill', source: src, paint: { 'fill-color': magenta, 'fill-opacity': ['case', selected, 0.15, 0.08] } }),
    addOrdered(map, 'boundaries', { id: `${tag}-line`, type: 'line', source: src, filter: ['!', trust], paint: { 'line-color': magenta, 'line-width': ['case', selected, 3, 1.5] } }),
    addOrdered(map, 'boundaries', { id: `${tag}-trust`, type: 'line', source: src, filter: trust, paint: { 'line-color': magenta, 'line-width': ['case', selected, 3, 1.5], 'line-dasharray': [4, 3] } }),
  ];
}

/**
 * @param {Record<string, unknown>} [opts]
 * @returns {MapLayerX}
 */
export function createBoundariesLayer(opts) {
  /** @type {MapContext | null} */
  let ctx = null;
  /** @type {string[]} */
  let overviewIds = [];
  /** @type {string[]} */
  let detailIds = [];
  let userOn = true;
  let forced = false;
  let overviewLoading = false;
  let overviewLoaded = false;
  /** @type {string | null} */
  let selected = null;
  /** @type {(() => void) | null} */
  let offZoom = null;
  /** @type {any} a Nation record chosen before add(), or undefined */
  let pendingRecord;
  /** @type {string[]} */
  const sourceIds = BOUNDARY_SOURCE_IDS;

  function wantOverview() {
    return userOn && (forced || (ctx?.zoomNow() ?? 0) >= OVERVIEW_MIN_ZOOM);
  }

  async function ensureOverview() {
    if (!ctx?.map || overviewLoaded || overviewLoading) return;
    overviewLoading = true;
    const c = ctx;
    const res = await c.fetchLocal(OVERVIEW_FILE, { signal: c.signal, priority: 2 });
    overviewLoading = false;
    if (ctx !== c || !c.map) return;
    if (!res.ok) {
      c.status(layerStatus('unavailable', 'The Nation land-area overview file is not available; headquarters points are shown.', sourceIds));
      return;
    }
    try {
      const objectName = Object.keys(/** @type {any} */ (res.data).objects ?? {})[0];
      if (!objectName) throw new Error('empty topology');
      const data = decodeTopo(res.data, objectName, c.topojson);
      c.map.addSource('boundaries-overview', { type: 'geojson', data, promoteId: 'nationId', tolerance: 0.5, buffer: 64, maxzoom: 12 });
      overviewIds = addBoundaryLayers(c.map, 'boundaries-overview', 'overview', c.token);
      overviewLoaded = true;
      if (selected) markSelected(selected, true);
      c.status(layerStatus('live', 'Nation land-area representations drawn from federal sources.', sourceIds));
      sync();
    } catch (err) {
      c.status(layerStatus('degraded', `The Nation land-area overview file could not be read (${err instanceof Error ? err.message : 'format'}).`, sourceIds));
    }
  }

  function sync() {
    setLayersVisible(ctx?.map ?? null, overviewIds, wantOverview());
    setLayersVisible(ctx?.map ?? null, detailIds, userOn);
    if (wantOverview()) void ensureOverview();
  }

  /** @param {string} id @param {boolean} on */
  function markSelected(id, on) {
    const map = ctx?.map;
    if (!map) return;
    for (const src of ['boundaries-overview', 'boundaries-detail']) {
      if (!map.getSource(src)) continue;
      try { map.setFeatureState({ source: src, id }, { selected: on }); } catch { /* source not ready */ }
    }
  }

  function clearDetail() {
    removeAll(ctx?.map ?? null, detailIds, ['boundaries-detail']);
    detailIds = [];
  }

  return {
    id: 'boundaries',
    sourceIds,
    async add(c) {
      ctx = /** @type {MapContext} */ (c);
      offZoom = ctx.onZoom(() => sync());
      sync();
      // A Nation selected before this layer reached the map is applied now.
      if (pendingRecord !== undefined) {
        const record = pendingRecord;
        pendingRecord = undefined;
        await this.focus?.(record);
      }
    },
    setVisible(on) {
      // A viewer's toggle is a request for the overview at any zoom (blueprint 4.2).
      if (on) forced = true;
      userOn = on;
      sync();
    },
    highlight(id) {
      if (selected) markSelected(selected, false);
      selected = id;
      if (selected) markSelected(selected, true);
    },
    async focus(record) {
      const c = ctx;
      if (!c?.map) { pendingRecord = record; return; }
      clearDetail();
      if (!record) { c.setDatasets([]); return; }
      const part = record.boundary;
      if (!part || part.status !== 'polygon' || !part.detailRef) {
        c.setDatasets([], NO_BOUNDARY_TEXT);
        return;
      }
      const res = await c.fetchLocal(`data/${part.detailRef}`, { signal: c.signal, priority: 1 });
      if (ctx !== c || !c.map) return;
      if (!res.ok) {
        c.setDatasets(datasetsOf(record), 'The land-area detail file is unavailable right now; headquarters location shown.');
        c.status(layerStatus('unavailable', 'The selected Nation\'s land-area file is unavailable.', sourceIds));
        return;
      }
      const raw = /** @type {any} */ (res.data);
      const features = (raw?.features ?? []).map((/** @type {any} */ f) => ({ ...f, properties: { ...f.properties, nationId: f.properties?.nationId ?? record.id } }));
      c.map.addSource('boundaries-detail', { type: 'geojson', data: { type: 'FeatureCollection', features }, promoteId: 'nationId', tolerance: 0.5, buffer: 64, maxzoom: 12 });
      detailIds = addBoundaryLayers(c.map, 'boundaries-detail', 'detail', c.token);
      markSelected(record.id, true);
      c.setDatasets(datasetsOf(record));
    },
    legendItems() {
      return [
        { id: 'boundaries', label: 'Tribal Land Boundary (Representation)', swatchClass: 'legend__swatch--boundary', note: 'Federal sources; not jurisdiction.' },
        { id: 'boundaries-trust', label: 'Off-Reservation Trust Land', swatchClass: 'map-swatch--boundary-trust' },
        { id: 'boundaries-selected', label: 'Selected Nation', swatchClass: 'legend__swatch--selected-nation' },
      ];
    },
    remove() {
      offZoom?.();
      offZoom = null;
      removeAll(ctx?.map ?? null, [...overviewIds, ...detailIds], ['boundaries-overview', 'boundaries-detail']);
      overviewIds = [];
      detailIds = [];
      ctx = null;
    },
  };
}
