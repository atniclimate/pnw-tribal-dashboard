// @ts-check
/**
 * Alert zone coverage: whole forecast, county, fire, and marine zones (NWS) and public forecast regions
 * (ECCC), drawn dashed so zone coverage never looks like a storm-based polygon. Implements MapLayer
 * (blueprint 4.4, 3.7.5).
 *
 * The zone files load only when a zone-basis alert exists. Zones are looked up by typed key
 * (`forecast:WAZ001` and `fire:WAZ001` stay distinct); each zone is its own feature with no union.
 *
 * Owner: lane L8.
 */
import { decodeTopo } from '../topo.js';
import { addOrdered, bandColor, layerStatus, removeAll, setLayersVisible } from '../style.js';
import { alertName, bandRank, centerOf, emptyCollection, geometryBounds } from '../topo.js';

/** @typedef {import('../style.js').MapContext} MapContext */
/** @typedef {import('../style.js').MapLayerX} MapLayerX */
/** @typedef {import('../../types.js').DashboardAlert} DashboardAlert */
/** @typedef {import('../../types.js').FeatureItem} FeatureItem */

export const NWS_ZONES_FILE = 'data/geo/nws-zones.topo.json';
export const ECCC_REGIONS_FILE = 'data/geo/eccc-regions.topo.json';

/**
 * The zone keys an alert covers: typed NWS keys, or `eccc:<code>` for ECCC regions.
 * @param {DashboardAlert} a
 * @returns {string[]}
 */
export function zoneKeysOf(a) {
  if (a.provenance?.coverage?.geometryBasis !== 'zone') return [];
  if (a.agency === 'eccc') return (a.provenance.coverage.geocodes ?? []).map((g) => `eccc:${g}`);
  return (a.zones ?? []).map(String);
}

/**
 * Which zone files an alert set needs.
 * @param {DashboardAlert[]} alerts
 * @returns {{ nws: boolean, eccc: boolean }}
 */
export function zoneFilesNeeded(alerts) {
  let nws = false; let eccc = false;
  for (const a of alerts) for (const k of zoneKeysOf(a)) { if (k.startsWith('eccc:')) eccc = true; else nws = true; }
  return { nws, eccc };
}

/**
 * Builds the zone features for a set of alerts from already decoded zone collections. A zone covered by
 * several alerts takes the most severe band and that alert's id. Keys with no geometry are returned in
 * `missing` (the alert list says "Area shown as text; map outline unavailable.").
 * @param {DashboardAlert[]} alerts
 * @param {{ nws: import('../../types.js').FeatureCollection | null, eccc: import('../../types.js').FeatureCollection | null }} zones
 * @returns {{ collection: import('../../types.js').FeatureCollection, items: FeatureItem[], missing: string[] }}
 */
export function buildZoneFeatures(alerts, zones) {
  /** @type {Map<string, { band: string, alertId: string, alertIds: Set<string> }>} */
  const byKey = new Map();
  /** @type {Map<string, DashboardAlert>} */
  const alertById = new Map();
  for (const a of alerts) {
    for (const key of zoneKeysOf(a)) {
      alertById.set(a.alertId, a);
      const cur = byKey.get(key);
      if (!cur) byKey.set(key, { band: a.band, alertId: a.alertId, alertIds: new Set([a.alertId]) });
      else {
        cur.alertIds.add(a.alertId);
        if (bandRank(a.band) < bandRank(cur.band)) { cur.band = a.band; cur.alertId = a.alertId; }
      }
    }
  }
  /** @type {Map<string, any>} */
  const geom = new Map();
  for (const f of zones.nws?.features ?? []) geom.set(String(/** @type {any} */ (f.properties)?.key ?? f.id), f);
  /** @type {Map<string, any>} */
  const ecccPart = new Map();
  for (const f of zones.eccc?.features ?? []) {
    const id = String(/** @type {any} */ (f.properties)?.id ?? f.id);
    for (const part of id.split('-')) ecccPart.set(part, f);
    geom.set(`eccc:${id}`, f);
  }
  const features = [];
  /** @type {string[]} */
  const missing = [];
  /** @type {Map<string, [number, number][]>} */
  const centers = new Map();
  for (const [key, v] of byKey) {
    const f = geom.get(key) ?? (key.startsWith('eccc:') ? ecccPart.get(key.slice(5)) : undefined);
    if (!f) { missing.push(key); continue; }
    features.push({ type: 'Feature', id: key, geometry: f.geometry, properties: { key, band: v.band, alertId: v.alertId, name: String(f.properties?.name ?? key) } });
    const c = centerOf(f.geometry);
    if (c) for (const id of v.alertIds) { const list = centers.get(id) ?? []; list.push(c); centers.set(id, list); }
  }
  /** @type {FeatureItem[]} */
  const items = [];
  for (const [id, cs] of centers) {
    const a = alertById.get(id);
    if (!a) continue;
    const lng = cs.reduce((s, c) => s + c[0], 0) / cs.length;
    const lat = cs.reduce((s, c) => s + c[1], 0) / cs.length;
    items.push({ kind: 'alert', id, name: alertName(a, true), lngLat: [lng, lat] });
  }
  return { collection: { type: 'FeatureCollection', features: /** @type {any} */ (features) }, items, missing };
}

/**
 * @param {Record<string, unknown>} [opts]
 * @returns {MapLayerX}
 */
export function createZonesLayer(opts) {
  const sourceKey = 'zones';
  const ids = ['zones:fill', 'zones:line', 'selection:zones'];
  /** @type {MapContext | null} */
  let ctx = null;
  /** @type {DashboardAlert[]} */
  let pending = [];
  /** @type {FeatureItem[]} */
  let items = [];
  /** @type {{ nws: any, eccc: any }} */
  const topologies = { nws: null, eccc: null };
  let generation = 0;
  let selected = '';
  const sourceIds = ['nws-zones-api', 'eccc-public-forecast-zones'];
  /** @type {import('../../types.js').StatusSnapshot | null} */
  let feedStatus = null;
  /** @param {string} detail @param {boolean} [missing] */
  function report(detail, missing = false) {
    const ids = [...new Set([...sourceIds, ...(feedStatus?.sourceIds ?? [])])];
    if (!feedStatus) { ctx?.status(layerStatus('unavailable', detail + ' Feed freshness was not supplied to this map.', ids)); return; }
    ctx?.status({ ...feedStatus, sourceIds: ids, detail: detail + ' ' + (feedStatus.detail ?? 'Date describes the alert feed, not the zone geometry.'),
      ...(missing && feedStatus.asOf ? { state: /** @type {const} */ ('degraded'), completeness: /** @type {const} */ ('partial') } : {}) });
  }

  /**
   * @param {'nws' | 'eccc'} which
   * @returns {Promise<import('../../types.js').FeatureCollection | null>}
   */
  async function decoded(which) {
    const c = ctx;
    if (!c) return null;
    if (!topologies[which]) {
      const res = await c.fetchLocal(which === 'nws' ? NWS_ZONES_FILE : ECCC_REGIONS_FILE, { signal: c.signal, priority: 2, ttlMs: 3_600_000 });
      if (!res.ok) return null;
      topologies[which] = res.data;
    }
    try { return decodeTopo(topologies[which], which === 'nws' ? 'zones' : 'regions', c.topojson); } catch { return null; }
  }

  async function apply() {
    const c = ctx;
    const map = c?.map;
    if (!c || !map) return;
    const mine = ++generation;
    const need = zoneFilesNeeded(pending);
    if (!need.nws && !need.eccc) {
      items = [];
      /** @type {import('maplibre-gl').GeoJSONSource | undefined} */ (map.getSource(sourceKey))?.setData(/** @type {any} */ (emptyCollection()));
      report('No zone-based areas in the current alert selection.');
      return;
    }
    const [nws, eccc] = await Promise.all([need.nws ? decoded('nws') : null, need.eccc ? decoded('eccc') : null]);
    if (mine !== generation || ctx !== c || !c.map) return;
    const built = buildZoneFeatures(pending, { nws, eccc });
    items = built.items;
    /** @type {import('maplibre-gl').GeoJSONSource | undefined} */ (c.map.getSource(sourceKey))?.setData(/** @type {any} */ (built.collection));
    if (built.missing.length) {
      report('Area shown as text; map outline unavailable for some zones.', true);
    } else {
      report('Forecast zone coverage drawn from local zone files.');
    }
  }

  return {
    id: 'zones',
    sourceIds,
    async add(c) {
      ctx = /** @type {MapContext} */ (c);
      const map = ctx.map;
      if (!map) return;
      map.addSource(sourceKey, { type: 'geojson', data: emptyCollection(), promoteId: 'key', tolerance: 0.5, buffer: 64, maxzoom: 12 });
      const color = bandColor(ctx.token);
      addOrdered(map, 'zones', { id: 'fill', type: 'fill', source: sourceKey, paint: { 'fill-color': color, 'fill-opacity': 0.15 } });
      addOrdered(map, 'zones', { id: 'line', type: 'line', source: sourceKey, paint: { 'line-color': color, 'line-width': 1.5, 'line-dasharray': [6, 4] } });
      addOrdered(map, 'selection', { id: 'zones', type: 'line', source: sourceKey, filter: ['==', ['get', 'alertId'], selected], paint: { 'line-color': ctx.token('--ink-heading'), 'line-width': 4, 'line-dasharray': [6, 4] } });
      await apply();
    },
    setData(data) {
      const d = /** @type {{ alerts?: DashboardAlert[], status?: import('../../types.js').StatusSnapshot | null }} */ (data ?? {});
      if (!Array.isArray(d.alerts)) return;
      pending = d.alerts;
      feedStatus = d.status ?? null;
      void apply();
    },
    setVisible(on) { setLayersVisible(ctx?.map ?? null, ids, on); },
    highlight(id) {
      selected = id ?? '';
      if (ctx?.map?.getLayer('selection:zones')) ctx.map.setFilter('selection:zones', ['==', ['get', 'alertId'], selected]);
    },
    async bounds(id) {
      const alert = pending.find((a) => a.alertId === id);
      if (!alert) return null;
      const need = zoneFilesNeeded([alert]);
      const [nws, eccc] = await Promise.all([need.nws ? decoded('nws') : null, need.eccc ? decoded('eccc') : null]);
      const collection = buildZoneFeatures([alert], { nws, eccc }).collection;
      return geometryBounds({ type: 'GeometryCollection', geometries: collection.features.map((f) => f.geometry) });
    },
    legendItems() {
      return [{ id: 'zones', label: 'Forecast Zone Coverage (Whole Zone)', swatchClass: 'legend__swatch--zone', note: 'Dashed edge; the alert covers the whole zone, not a drawn polygon.' }];
    },
    featureItems() { return items; },
    remove() {
      generation += 1;
      removeAll(ctx?.map ?? null, ids, [sourceKey]);
      items = [];
      pending = [];
      topologies.nws = null;
      topologies.eccc = null;
      ctx = null;
    },
  };
}
