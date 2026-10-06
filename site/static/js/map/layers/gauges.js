// @ts-check
/**
 * NWPS circles and WSC squares (icon-only symbol, no glyphs) colored by NWS flood category. Implements MapLayer (blueprint 4.4).
 *
 * Color is never the only cue: NWPS gauges are circles and Water Survey of Canada stations are squares.
 * A gauge with no current status is drawn as a hollow ring and says "no current reading" in the feature
 * list; the map never implies "no flooding" for a gauge it has no reading for.
 *
 * Owner: lane L8.
 */
import { formatAsOf } from '../../core/time.js';
import { addOrdered, layerStatus, removeAll, setLayersVisible } from '../style.js';

/** @typedef {import('../style.js').MapContext} MapContext */
/** @typedef {import('../style.js').MapLayerX} MapLayerX */
/** @typedef {import('../../types.js').GaugeStatus} GaugeStatus */
/** @typedef {import('../../types.js').FeatureItem} FeatureItem */

export const GAUGES_FILE = 'data/ref/gauges.json';
export const WSC_FILE = 'data/ref/wsc-stations.json';
export const SQUARE_IMAGE = 'cthd-square';
/** Reference files are cached in memory for an hour, so a prefetch and the layer's own read are one request. */
const DATA_TTL_MS = 3_600_000;
/** Same six-hour observation policy as the gauge panel; map cannot import hydro modules. */
const OBSERVATION_MAX_AGE_MS = 6 * 60 * 60 * 1000;

/** @param {GaugeStatus | undefined} status @param {Date} now */
function observationCurrent(status, now) {
  const observed = status?.observed;
  if (!observed || observed.category === 'out_of_service' || !observed.validTime) return false;
  const timestamp = Date.parse(observed.validTime);
  return Number.isFinite(timestamp) && timestamp >= Date.UTC(1990, 0, 1)
    && now.getTime() - timestamp <= OBSERVATION_MAX_AGE_MS;
}

/** Display words for each drawn category. */
export const CATEGORY_TEXT = Object.freeze({
  major: 'major flooding',
  moderate: 'moderate flooding',
  minor: 'minor flooding',
  action: 'action stage',
  none: 'no flooding',
  'not-defined': 'flood categories not defined',
  'no-reading': 'no current reading',
});

/**
 * @param {GaugeStatus | undefined} status
 * @param {Date} [now]
 * @returns {keyof typeof CATEGORY_TEXT}
 */
export function drawnCategory(status, now = new Date()) {
  if (!observationCurrent(status, now)) return 'no-reading';
  const c = status?.observed?.category;
  switch (c) {
    case 'major': case 'moderate': case 'minor': case 'action': return c;
    case 'no_flooding': return 'none';
    case 'not_defined': return 'not-defined';
    default: return 'no-reading';
  }
}

/**
 * Joins the reference gauges and stations with the current statuses.
 * @param {any} gaugesRef data/ref/gauges.json
 * @param {any} wscRef data/ref/wsc-stations.json
 * @param {GaugeStatus[]} statuses
 * @param {Date} [now]
 * @returns {{ collection: import('../../types.js').FeatureCollection, items: FeatureItem[] }}
 */
export function buildGaugeFeatures(gaugesRef, wscRef, statuses, now = new Date()) {
  /** @type {Map<string, GaugeStatus>} */
  const byId = new Map(statuses.map((s) => [s.id, s]));
  /** @type {any[]} */
  const features = [];
  /** @type {FeatureItem[]} */
  const items = [];
  /** @param {any} g @param {'NWS' | 'WSC'} agency */
  const add = (g, agency) => {
    if (typeof g?.lat !== 'number' || typeof g?.lon !== 'number') return;
    const st = byId.get(g.id);
    const cat = drawnCategory(st, now);
    const tz = typeof g.timeZone === 'string' ? g.timeZone : undefined;
    const observed = st?.observed?.validTime;
    const stamp = observed ? `, observed ${formatAsOf(observed, tz)}` : '';
    const condition = st?.observed && cat === 'no-reading'
      ? st.observed.category === 'out_of_service' ? 'out of service' : 'observation not current'
      : CATEGORY_TEXT[cat];
    const name = `${g.name}, ${condition}${stamp}`;
    features.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [g.lon, g.lat] }, properties: { gaugeId: g.id, agency, flood: cat, name } });
    items.push({ kind: 'gauge', id: g.id, name, lngLat: [g.lon, g.lat] });
  };
  for (const g of gaugesRef?.gauges ?? []) add(g, 'NWS');
  for (const s of wscRef?.stations ?? []) add(s, 'WSC');
  return { collection: { type: 'FeatureCollection', features: /** @type {any} */ (features) }, items };
}

/**
 * @param {(name: string) => string} token
 * @returns {any[]} a match expression from the drawn category to its flood token
 */
function floodColor(token) {
  return ['match', ['get', 'flood'],
    'major', token('--flood-major'),
    'moderate', token('--flood-moderate'),
    'minor', token('--flood-minor'),
    'action', token('--flood-action'),
    'none', token('--flood-none'),
    'transparent'];
}

/**
 * @returns {{ width: number, height: number, data: Uint8ClampedArray } | null}
 */
function squareImage() {
  const size = 20;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const g = canvas.getContext('2d');
  if (!g) return null;
  g.fillStyle = 'black';
  g.fillRect(2, 2, size - 4, size - 4);
  const img = g.getImageData(0, 0, size, size);
  return { width: size, height: size, data: img.data };
}

/**
 * @param {Record<string, unknown>} [opts]
 * @returns {MapLayerX}
 */
export function createGaugesLayer(opts) {
  const sourceKey = 'gauges';
  const ids = ['gauges:nwps', 'gauges:wsc'];
  /** @type {MapContext | null} */
  let ctx = null;
  /** @type {any} */
  let gaugesRef = null;
  /** @type {any} */
  let wscRef = null;
  /** @type {GaugeStatus[]} */
  let statuses = [];
  /** @type {FeatureItem[]} */
  let items = [];
  /** @type {string | null} */
  let selected = null;
  /** @type {Set<string> | null} */
  let scope = null;
  const sourceIds = ['nwps-gauges', 'eccc-hydrometric-realtime'];

  /** @param {string | null} id @param {boolean} on */
  function mark(id, on) {
    if (!id || !ctx?.map?.getSource(sourceKey)) return;
    try { ctx.map.setFeatureState({ source: sourceKey, id }, { selected: on }); } catch { /* not ready */ }
  }

  function apply() {
    const map = ctx?.map;
    if (!map || (!gaugesRef && !wscRef)) return;
    const built = buildGaugeFeatures(scope ? { gauges: gaugesRef?.gauges?.filter((/** @type {{id:string}} */ g) => scope?.has(g.id)) } : gaugesRef, scope ? { stations: wscRef?.stations?.filter((/** @type {{id:string}} */ g) => scope?.has(g.id)) } : wscRef, statuses);
    items = built.items;
    /** @type {import('maplibre-gl').GeoJSONSource | undefined} */ (map.getSource(sourceKey))?.setData(/** @type {any} */ (built.collection));
    if (selected) mark(selected, true);
  }

  return {
    id: 'gauges',
    sourceIds,
    prefetch(io) {
      void io.fetchLocal(GAUGES_FILE, { signal: io.signal, priority: 2, ttlMs: DATA_TTL_MS });
      void io.fetchLocal(WSC_FILE, { signal: io.signal, priority: 2, ttlMs: DATA_TTL_MS });
    },
    async add(c) {
      ctx = /** @type {MapContext} */ (c);
      const activeContext = ctx;
      const map = ctx.map;
      if (!map) return;
      const [g, w] = await Promise.all([
        ctx.fetchLocal(GAUGES_FILE, { signal: ctx.signal, priority: 2, ttlMs: DATA_TTL_MS }),
        ctx.fetchLocal(WSC_FILE, { signal: ctx.signal, priority: 2, ttlMs: DATA_TTL_MS }),
      ]);
      if (ctx !== activeContext || ctx.map !== map) return;
      gaugesRef = g.ok ? g.data : null;
      wscRef = w.ok ? w.data : null;
      if (!gaugesRef && !wscRef) {
        ctx.status(layerStatus('unavailable', 'Gauge locations are unavailable; the gauge list is the fallback.', sourceIds));
        return;
      }
      map.addSource(sourceKey, { type: 'geojson', data: { type: 'FeatureCollection', features: [] }, promoteId: 'gaugeId', tolerance: 0.5, buffer: 64, maxzoom: 12 });
      const color = floodColor(ctx.token);
      const ground = ctx.token('--ground');
      const keyline = ctx.token('--flood-not-defined');
      const ink = ctx.token('--ink-heading');
      const isSel = ['boolean', ['feature-state', 'selected'], false];
      addOrdered(map, 'gauges', {
        id: 'nwps', type: 'circle', source: sourceKey, filter: ['==', ['get', 'agency'], 'NWS'],
        paint: {
          'circle-radius': ['interpolate', ['linear'], ['zoom'], 3, 2.5, 9, 6],
          'circle-color': color,
          'circle-stroke-color': ['case', isSel, ink, ['==', ['get', 'flood'], 'no-reading'], keyline, ['==', ['get', 'flood'], 'not-defined'], keyline, ground],
          'circle-stroke-width': ['case', isSel, 3, ['in', ['get', 'flood'], ['literal', ['no-reading', 'not-defined']]], 1.5, 1],
        },
      });
      const image = squareImage();
      if (image && !map.hasImage(SQUARE_IMAGE)) map.addImage(SQUARE_IMAGE, image, { sdf: true, pixelRatio: 2 });
      // Icon-only symbol layer: no text-field, so no glyphs are ever requested (blueprint 4.7).
      addOrdered(map, 'gauges', {
        id: 'wsc', type: 'symbol', source: sourceKey, filter: ['==', ['get', 'agency'], 'WSC'],
        layout: { 'icon-image': SQUARE_IMAGE, 'icon-allow-overlap': true, 'icon-size': ['interpolate', ['linear'], ['zoom'], 3, 0.45, 9, 0.8] },
        paint: { 'icon-color': color, 'icon-halo-color': ['case', isSel, ink, keyline], 'icon-halo-width': ['case', isSel, 3, 1.5] },
      });
      apply();
      const dates = [gaugesRef?.generatedAt, wscRef?.generatedAt].filter((d) => typeof d === 'string' && Number.isFinite(Date.parse(d))).sort();
      ctx.status(layerStatus('cached', 'Gauge locations from compiled reference files. Colored markers require a current observation; hollow markers are unknown or not current. Each gauge carries its observation time.', sourceIds, dates[0] ?? null, 'retrieved'));
    },
    setData(data) {
      const d = /** @type {{ gauges?: GaugeStatus[] }} */ (data ?? {});
      if (!Array.isArray(d.gauges)) return;
      statuses = d.gauges;
      apply();
    },
    setVisible(on) { setLayersVisible(ctx?.map ?? null, ids, on); },
    setScope(ids) { scope = ids ? new Set(ids) : null; apply(); },
    highlight(id) {
      mark(selected, false);
      selected = id;
      mark(selected, true);
    },
    legendItems() {
      return [
        { id: 'gauge-nwps', label: 'River Gauge (Circle)', swatchClass: 'map-swatch--gauge-circle', note: 'National Weather Service.' },
        { id: 'gauge-wsc', label: 'Hydrometric Station (Square)', swatchClass: 'map-swatch--gauge-square', note: 'Water Survey of Canada.' },
        { id: 'gauge-none', label: 'No Current Reading (Hollow)', swatchClass: 'map-swatch--gauge-none' },
      ];
    },
    featureItems() { return items; },
    remove() {
      removeAll(ctx?.map ?? null, ids, [sourceKey]);
      try { if (ctx?.map?.hasImage(SQUARE_IMAGE)) ctx.map.removeImage(SQUARE_IMAGE); } catch { /* removed */ }
      items = [];
      statuses = [];
      gaugesRef = null;
      wscRef = null;
      ctx = null;
    },
  };
}
