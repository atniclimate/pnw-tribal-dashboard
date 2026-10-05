// @ts-check
/**
 * British Columbia River Forecast Centre advisories and EMCR evacuation orders and alerts. Implements MapLayer (blueprint 4.4).
 *
 * The layer draws what a page gives it through setData({ bc }): a FeatureCollection whose features carry
 * `bcId`, `band`, `designation`, `name`, and `posture`. Posture is a word in the popup and the feature
 * list, never canvas text. The feeds are `candidate` sources, so the page passes nothing until the
 * maintainer enables them, and the layer then simply draws nothing.
 *
 * Owner: lane L8.
 */
import { addOrdered, bandColor, removeAll, setLayersVisible } from '../style.js';
import { centerOf, emptyCollection } from '../topo.js';

/** @typedef {import('../style.js').MapContext} MapContext */
/** @typedef {import('../style.js').MapLayerX} MapLayerX */
/** @typedef {import('../../types.js').FeatureItem} FeatureItem */

const POSTURE_WORDS = Object.freeze({ 'act-now': 'act now', prepare: 'prepare', monitor: 'monitor', ended: 'ended' });

/**
 * @param {any} collection
 * @returns {{ collection: import('../../types.js').FeatureCollection, items: FeatureItem[] }}
 */
export function buildBcFeatures(collection) {
  const features = [];
  /** @type {FeatureItem[]} */
  const items = [];
  for (const f of collection?.features ?? []) {
    const p = f?.properties ?? {};
    if (!f?.geometry || typeof p.bcId !== 'string' || typeof p.name !== 'string') continue;
    const posture = /** @type {Record<string, string>} */ (POSTURE_WORDS)[p.posture];
    const name = `${p.name}${posture ? `, ${posture}` : ''}`;
    features.push({ type: 'Feature', geometry: f.geometry, properties: { bcId: p.bcId, band: p.band ?? 'unstated', designation: p.designation ?? 'other', name } });
    const c = centerOf(f.geometry);
    if (c) items.push({ kind: 'bc-hazard', id: p.bcId, name, lngLat: c });
  }
  return { collection: { type: 'FeatureCollection', features: /** @type {any} */ (features) }, items };
}

/**
 * @param {Record<string, unknown>} [opts]
 * @returns {MapLayerX}
 */
export function createBcLayer(opts) {
  const sourceKey = 'bc';
  const ids = ['bc:fill', 'bc:line'];
  /** @type {MapContext | null} */
  let ctx = null;
  /** @type {FeatureItem[]} */
  let items = [];
  /** @type {any} */
  let pending = null;

  function apply() {
    const map = ctx?.map;
    if (!map) return;
    const built = buildBcFeatures(pending);
    items = built.items;
    /** @type {import('maplibre-gl').GeoJSONSource | undefined} */ (map.getSource(sourceKey))?.setData(/** @type {any} */ (built.collection));
  }

  return {
    id: 'bc',
    sourceIds: ['bc-rfc-flood-advisories', 'bc-emcr-evacuations'],
    async add(c) {
      ctx = /** @type {MapContext} */ (c);
      const map = ctx.map;
      if (!map) return;
      map.addSource(sourceKey, { type: 'geojson', data: emptyCollection(), promoteId: 'bcId', tolerance: 0.5, buffer: 64, maxzoom: 12 });
      const color = bandColor(ctx.token);
      addOrdered(map, 'bc', { id: 'fill', type: 'fill', source: sourceKey, paint: { 'fill-color': color, 'fill-opacity': 0.3 } });
      addOrdered(map, 'bc', {
        id: 'line', type: 'line', source: sourceKey,
        paint: { 'line-color': color, 'line-width': ['case', ['==', ['get', 'designation'], 'emergency'], 3, 2] },
      });
      apply();
    },
    setData(data) {
      const d = /** @type {{ bc?: unknown }} */ (data ?? {});
      if (!('bc' in d)) return;
      pending = d.bc;
      apply();
    },
    setVisible(on) { setLayersVisible(ctx?.map ?? null, ids, on); },
    legendItems() {
      return [{ id: 'bc', label: 'British Columbia Advisories, Orders, and Alerts', swatchClass: 'map-swatch--alert map-swatch--severe', note: 'Provincial sources; shape and word carry the meaning.' }];
    },
    featureItems() { return items; },
    remove() {
      removeAll(ctx?.map ?? null, ids, [sourceKey]);
      items = [];
      pending = null;
      ctx = null;
    },
  };
}
