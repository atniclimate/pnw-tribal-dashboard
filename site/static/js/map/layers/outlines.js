// @ts-check
/**
 * Local outlines (states, British Columbia, footprint counties) drawn on every map, so boundaries are
 * visible even when no tile loads. Implements MapLayer (blueprint 4.3, 4.4).
 *
 * The coastline is the outer edge of the state and province polygons (the L4 file has no separate
 * coastline object). Colors come from tokens.
 *
 * Owner: lane L8.
 */
import { OUTLINES_FILE, centerOf, decodeOutlines } from '../topo.js';
import { addOrdered, layerStatus, removeAll, setLayersVisible } from '../style.js';

/** @typedef {import('../style.js').MapContext} MapContext */
/** @typedef {import('../../types.js').MapLayer} MapLayer */
/** @typedef {import('../../types.js').FeatureCollection} FeatureCollection */

export { OUTLINES_FILE };
export const OUTLINES_ATTRIBUTION = 'Outlines: U.S. Census Bureau, Province of British Columbia';

/**
 * Fetches and decodes the outlines file (used by both modes).
 * @param {(path: string, opts?: import('../../types.js').FetchOptions) => Promise<import('../../types.js').NetResult>} fetchLocal
 * @param {typeof import('topojson-client')} topojson
 * @param {AbortSignal} [signal]
 * @returns {Promise<{ ok: true, data: FeatureCollection } | { ok: false, message: string }>}
 */
export async function loadOutlines(fetchLocal, topojson, signal) {
  const res = await fetchLocal(OUTLINES_FILE, signal ? { signal, priority: 1 } : { priority: 1 });
  if (!res.ok) return { ok: false, message: res.error.message };
  try { return { ok: true, data: decodeOutlines(res.data, topojson) }; } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : 'Outlines file could not be decoded' };
  }
}

/**
 * @param {Record<string, unknown>} [opts]
 * @returns {MapLayer}
 */
export function createOutlinesLayer(opts) {
  const sourceKey = 'outlines';
  const ids = ['basemap:local-land', 'outlines:counties', 'outlines:states', 'outlines:province'];
  /** @type {MapContext | null} */
  let ctx = null;
  /** @type {import('maplibre-gl').Marker[]} */
  const labels = [];
  /** @type {(() => void) | null} */
  let offZoom = null;
  return {
    id: 'outlines',
    sourceIds: ['census-cartographic-boundaries'],
    async add(c) {
      ctx = /** @type {MapContext} */ (c);
      const map = ctx.map;
      if (!map) return;
      let data = ctx.outlines;
      if (!data) {
        const loaded = await loadOutlines(ctx.fetchLocal, ctx.topojson, ctx.signal);
        if (!loaded.ok) { ctx.status(layerStatus('unavailable', `Outlines unavailable: ${loaded.message}`, this.sourceIds)); return; }
        data = loaded.data;
      }
      const ink = ctx.token('--ink-muted');
      map.addSource(sourceKey, { type: 'geojson', data, tolerance: 0.5, buffer: 64, maxzoom: 12, attribution: OUTLINES_ATTRIBUTION });
      addOrdered(map, 'basemap', { id: 'local-land', type: 'fill', source: sourceKey, filter: ['in', ['get', 'layer'], ['literal', ['states', 'province']]], paint: { 'fill-color': ctx.token('--surface-overlay'), 'fill-opacity': 1 } });
      const line = (/** @type {string} */ id, /** @type {string} */ layer, /** @type {number} */ width, /** @type {number} */ opacity) => addOrdered(map, 'outlines', {
        id, type: 'line', source: sourceKey, filter: ['==', ['get', 'layer'], layer],
        layout: { 'line-join': 'round' }, paint: { 'line-color': ink, 'line-width': width, 'line-opacity': opacity },
      });
      line('counties', 'counties', 0.75, 0.5);
      line('states', 'states', 1, 0.9);
      line('province', 'province', 1.5, 0.9);
      const lib = ctx.maplibregl;
      if (lib) for (const f of data.features) {
        const p = /** @type {{layer?: string, name?: string}} */ (f.properties);
        if (!['states', 'province'].includes(p?.layer ?? '') || !p.name) continue;
        const at = centerOf(f.geometry);
        if (!at) continue;
        const element = document.createElement('span');
        element.className = 'map-region-label';
        element.textContent = p.name;
        element.setAttribute('aria-hidden', 'true');
        labels.push(new lib.Marker({ element, anchor: 'center' }).setLngLat(at).addTo(map));
      }
      const syncLabels = () => { for (const label of labels) label.getElement().hidden = map.getZoom() >= 8; };
      offZoom = ctx.onZoom(syncLabels);
      syncLabels();
      ctx.status(layerStatus('live', 'Local state, province, and county reference geometry. Road and terrain tiles are not enabled.', this.sourceIds));
    },
    setVisible(on) { setLayersVisible(ctx?.map ?? null, ids, on); },
    legendItems() { return [{ id: 'outlines', label: 'State, Province, and County Outlines', swatchClass: 'map-swatch--outline' }]; },
    remove() {
      offZoom?.(); offZoom = null;
      for (const label of labels.splice(0)) label.remove();
      removeAll(ctx?.map ?? null, ids, [sourceKey]);
      ctx = null;
    },
  };
}
