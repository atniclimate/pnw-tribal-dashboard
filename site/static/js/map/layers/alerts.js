// @ts-check
/**
 * Forecaster-drawn alert polygons, solid, with the extreme keyline. Implements MapLayer (blueprint 4.4).
 *
 * Only alerts whose own geometry is a polygon reach this layer; zone-basis alerts are drawn dashed by
 * layers/zones.js so zone coverage never looks like a storm-based polygon. The page decides which alerts
 * to pass (active ones on live maps); this layer draws what it is given.
 *
 * Owner: lane L8.
 */
import { addOrdered, bandColor, layerStatus, removeAll, setLayersVisible } from '../style.js';
import { centerOf, emptyCollection } from '../topo.js';
import { alertPolygons, geometryBounds, hasOwnPolygon } from '../topo.js';

export { alertPolygons, hasOwnPolygon };

/** @typedef {import('../style.js').MapContext} MapContext */
/** @typedef {import('../style.js').MapLayerX} MapLayerX */
/** @typedef {import('../../types.js').DashboardAlert} DashboardAlert */
/** @typedef {import('../../types.js').FeatureItem} FeatureItem */

/**
 * @param {Record<string, unknown>} [opts]
 * @returns {MapLayerX}
 */
export function createAlertsLayer(opts) {
  const sourceKey = 'alerts';
  const ids = ['alerts:keyline', 'alerts:fill', 'alerts:line', 'selection:alerts'];
  /** @type {MapContext | null} */
  let ctx = null;
  /** @type {DashboardAlert[]} */
  let pending = [];
  /** @type {import('../../types.js').StatusSnapshot | null} */
  let feedStatus = null;
  /** @type {FeatureItem[]} */
  let items = [];
  /** @type {string | null} */
  let selected = null;

  /** @param {string | null} id @param {boolean} on */
  function mark(id, on) {
    if (!id || !ctx?.map?.getSource(sourceKey)) return;
    try { ctx.map.setFeatureState({ source: sourceKey, id }, { selected: on }); } catch { /* not ready */ }
  }

  function apply() {
    const map = ctx?.map;
    if (!map) return;
    const fc = alertPolygons(pending);
    items = fc.features.map((f) => {
      const p = /** @type {any} */ (f.properties);
      return { kind: /** @type {const} */ ('alert'), id: p.alertId, name: p.name, lngLat: centerOf(f.geometry) ?? [0, 0] };
    }).filter((i) => i.lngLat[0] !== 0 || i.lngLat[1] !== 0);
    const src = /** @type {import('maplibre-gl').GeoJSONSource | undefined} */ (map.getSource(sourceKey));
    src?.setData(/** @type {any} */ (fc));
    if (selected) mark(selected, true);
    const detail = `${fc.features.length} forecaster-drawn alert areas. ${feedStatus?.detail ?? 'Feed status and issue times are shown with the alerts.'}`;
    ctx?.status(feedStatus ? { ...feedStatus, detail } : layerStatus('unavailable', detail + ' Feed freshness was not supplied to this map.', ['nws-alerts-active', 'eccc-geomet-weather-alerts']));
  }

  return {
    id: 'alerts',
    sourceIds: ['nws-alerts-active', 'eccc-geomet-weather-alerts'],
    async add(c) {
      ctx = /** @type {MapContext} */ (c);
      const map = ctx.map;
      if (!map) return;
      map.addSource(sourceKey, { type: 'geojson', data: emptyCollection(), promoteId: 'alertId', tolerance: 0.5, buffer: 64, maxzoom: 12 });
      const color = bandColor(ctx.token);
      addOrdered(map, 'alerts', { id: 'keyline', type: 'line', source: sourceKey, filter: ['==', ['get', 'band'], 'extreme'], paint: { 'line-color': ctx.token('--band-extreme-keyline'), 'line-width': 4 } });
      addOrdered(map, 'alerts', { id: 'fill', type: 'fill', source: sourceKey, paint: { 'fill-color': color, 'fill-opacity': 0.3 } });
      addOrdered(map, 'alerts', { id: 'line', type: 'line', source: sourceKey, paint: { 'line-color': color, 'line-width': 2 } });
      addOrdered(map, 'selection', {
        id: 'alerts', type: 'line', source: sourceKey,
        paint: { 'line-color': ctx.token('--ink-heading'), 'line-width': 4, 'line-opacity': ['case', ['boolean', ['feature-state', 'selected'], false], 1, 0] },
      });
      apply();
    },
    setData(data) {
      const d = /** @type {{ alerts?: DashboardAlert[], status?: import('../../types.js').StatusSnapshot | null }} */ (data ?? {});
      if (!Array.isArray(d.alerts)) return;
      pending = d.alerts;
      feedStatus = d.status ?? null;
      apply();
    },
    setVisible(on) { setLayersVisible(ctx?.map ?? null, ids, on); },
    highlight(id) {
      mark(selected, false);
      selected = id;
      mark(selected, true);
    },
    legendItems() {
      return [
        { id: 'alert-extreme', label: 'Extreme Alert Area (Drawn by Forecasters)', swatchClass: 'map-swatch--alert map-swatch--extreme' },
        { id: 'alert-severe', label: 'Severe', swatchClass: 'map-swatch--alert map-swatch--severe' },
        { id: 'alert-moderate', label: 'Moderate', swatchClass: 'map-swatch--alert map-swatch--moderate' },
        { id: 'alert-minor', label: 'Minor', swatchClass: 'map-swatch--alert map-swatch--minor' },
        { id: 'alert-unstated', label: 'Unstated', swatchClass: 'map-swatch--alert map-swatch--unstated' },
      ];
    },
    featureItems() { return items; },
    bounds(id) { return geometryBounds(pending.find((a) => a.alertId === id && hasOwnPolygon(a))?.geometry); },
    remove() {
      removeAll(ctx?.map ?? null, ids, [sourceKey]);
      items = [];
      pending = [];
      ctx = null;
    },
  };
}
