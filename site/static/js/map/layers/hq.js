// @ts-check
/**
 * Nation headquarters points. Implements MapLayer (blueprint 4.4).
 *
 * Every Nation shows below zoom seven; at every zoom for Nations with no published land-area polygon.
 * Names are never drawn on the canvas (no glyphs, blueprint 4.7): they live in the feature list and the
 * DOM label of the selected Nation.
 *
 * Owner: lane L8.
 */
import { addOrdered, layerStatus, removeAll, setLayersVisible } from '../style.js';

/** @typedef {import('../style.js').MapContext} MapContext */
/** @typedef {import('../style.js').MapLayerX} MapLayerX */
/** @typedef {import('../../types.js').FeatureItem} FeatureItem */

export const HQ_FILE = 'data/geo/hq-points.json';
export const NATIONS_INDEX_FILE = 'data/registry/nations-index.json';
/** Reference files are cached in memory for an hour, so a prefetch and the layer's own read are one request. */
const DATA_TTL_MS = 3_600_000;

/**
 * Joins the headquarters points with the registry index (full formal names, boundary availability). A point
 * whose Nation is not in the index is dropped: a point with no name would be an unnamed feature.
 * @param {any} points GeoJSON FeatureCollection of Points with properties.nationId
 * @param {any} index nations-index.json
 * @returns {{ type: 'FeatureCollection', features: any[] }}
 */
export function joinHq(points, index) {
  /** @type {Map<string, any>} */
  const byId = new Map((index?.nations ?? []).map((/** @type {any} */ n) => [n.id, n]));
  const features = [];
  for (const f of points?.features ?? []) {
    const id = f?.properties?.nationId;
    const n = byId.get(id);
    if (!n || f.geometry?.type !== 'Point') continue;
    features.push({
      type: 'Feature',
      geometry: f.geometry,
      properties: { nationId: id, name: n.name, hasBoundary: n.hasBoundary === true },
    });
  }
  return { type: 'FeatureCollection', features };
}

/**
 * @param {Record<string, unknown>} [opts]
 * @returns {MapLayerX}
 */
export function createHqLayer(opts) {
  const sourceKey = 'hq';
  const ids = ['hq:overview', 'hq:no-polygon', 'selection:hq'];
  /** @type {MapContext | null} */
  let ctx = null;
  /** @type {Map<string, { name: string, lngLat: [number, number], hasBoundary: boolean }>} */
  const items = new Map();
  /** @type {string | null} */
  let selected = null;

  /** @param {string | null} id @param {boolean} on */
  function mark(id, on) {
    if (!id || !ctx?.map || !ctx.map.getSource(sourceKey)) return;
    try { ctx.map.setFeatureState({ source: sourceKey, id }, { selected: on }); } catch { /* source not ready */ }
  }

  return {
    id: 'hq',
    sourceIds: ['cthd-registry'],
    prefetch(io) {
      void io.fetchLocal(HQ_FILE, { signal: io.signal, priority: 1, ttlMs: DATA_TTL_MS });
      void io.fetchLocal(NATIONS_INDEX_FILE, { signal: io.signal, priority: 1, ttlMs: DATA_TTL_MS });
    },
    async add(c) {
      ctx = /** @type {MapContext} */ (c);
      const map = ctx.map;
      if (!map) return;
      const [pts, idx] = await Promise.all([
        ctx.fetchLocal(HQ_FILE, { signal: ctx.signal, priority: 1, ttlMs: DATA_TTL_MS }),
        ctx.fetchLocal(NATIONS_INDEX_FILE, { signal: ctx.signal, priority: 1, ttlMs: DATA_TTL_MS }),
      ]);
      if (!pts.ok || !idx.ok) {
        ctx.status(layerStatus('unavailable', 'Headquarters points are unavailable; the Nation list is the fallback.', this.sourceIds));
        return;
      }
      const data = joinHq(pts.data, idx.data);
      for (const f of data.features) {
        const g = /** @type {any} */ (f.geometry);
        items.set(f.properties.nationId, { name: f.properties.name, lngLat: [g.coordinates[0], g.coordinates[1]], hasBoundary: f.properties.hasBoundary });
      }
      const fill = ctx.token('--ink-heading');
      const ring = ctx.token('--ground');
      map.addSource(sourceKey, { type: 'geojson', data, promoteId: 'nationId', tolerance: 0.5, buffer: 64, maxzoom: 12 });
      const circle = { 'circle-radius': 5, 'circle-color': fill, 'circle-stroke-color': ring, 'circle-stroke-width': 1.5 };
      addOrdered(map, 'hq', { id: 'overview', type: 'circle', source: sourceKey, maxzoom: 7, paint: circle });
      addOrdered(map, 'hq', { id: 'no-polygon', type: 'circle', source: sourceKey, minzoom: 7, filter: ['==', ['get', 'hasBoundary'], false], paint: circle });
      addOrdered(map, 'selection', {
        id: 'hq', type: 'circle', source: sourceKey,
        paint: {
          'circle-radius': 11, 'circle-color': ring, 'circle-opacity': 0,
          'circle-stroke-color': fill, 'circle-stroke-width': 3,
          'circle-stroke-opacity': ['case', ['boolean', ['feature-state', 'selected'], false], 1, 0],
        },
      });
      if (selected) mark(selected, true);
      ctx.status(layerStatus('live', 'Headquarters points drawn from the Nation registry.', this.sourceIds));
    },
    setVisible(on) { setLayersVisible(ctx?.map ?? null, ids, on); },
    highlight(id) {
      mark(selected, false);
      selected = id;
      mark(selected, true);
    },
    lookup(id) { return items.get(id) ?? null; },
    legendItems() {
      return [{ id: 'hq', label: 'Nation Headquarters', swatchClass: 'map-swatch--hq', note: 'Shown below zoom seven, and at every zoom for Nations with no published land-area boundary.' }];
    },
    /** @returns {FeatureItem[]} */
    featureItems() {
      return [...items.entries()].map(([id, v]) => ({ kind: /** @type {const} */ ('nation'), id, name: v.name, lngLat: v.lngLat }));
    },
    remove() {
      removeAll(ctx?.map ?? null, ids, [sourceKey]);
      items.clear();
      ctx = null;
    },
  };
}
