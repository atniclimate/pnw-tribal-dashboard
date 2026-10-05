// @ts-check
/**
 * IEM nexrad-n0q and ECCC GeoMet WMS radar rasters with valid times; setTiles refresh while visible. Implements MapLayer (blueprint 4.4).
 *
 * Radar sits below every vector layer. It never animates and shows one time step. It refreshes every five
 * minutes (U.S.) or six minutes (British Columbia) while the layer is visible and the page is shown, by
 * swapping the tile URL with `setTiles`, so viewers share CDN tiles. The legend prints the valid time, or
 * the honest text when the source does not publish one.
 *
 * Owner: lane L8.
 */
import { fetchJson, fetchText } from '../../core/net.js';
import { findSource } from '../../core/sources.js';
import { formatAsOf, formatTime } from '../../core/time.js';
import { APP } from '../../config/app.js';
import { addOrdered, layerStatus, removeAll, setLayersVisible } from '../style.js';

/** @typedef {import('../style.js').MapContext} MapContext */
/** @typedef {import('../style.js').MapLayerX} MapLayerX */

export const IEM_TILES_ID = 'iem-nexrad-n0q';
export const IEM_TIME_ID = 'iem-nexrad-n0q-valid-time';
export const ECCC_TILES_ID = 'eccc-geomet-radar';
export const ECCC_TIMES_ID = 'eccc-geomet-radar-times';
export const ECCC_LAYERS = Object.freeze({ rain: 'RADAR_1KM_RRAI', snow: 'RADAR_1KM_RSNO' });
export const ECCC_REFRESH_MS = 6 * 60_000;
export const RADAR_OPACITY = 0.6;
const US_BOUNDS = [-130, 24, -65, 52];
const BC_BOUNDS = [-142, 48, -113, 61];

/**
 * @param {unknown} json n0q_0.json
 * @returns {string | null} meta.valid as ISO, or null
 */
export function parseIemValidTime(json) {
  const v = /** @type {any} */ (json)?.meta?.valid;
  if (typeof v !== 'string') return null;
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

/**
 * The latest value of a layer's WMS time dimension from GetCapabilities text. The dimension is either
 * `start/end/period` or a comma list; the latest value is the end or the last entry.
 * @param {string} xml
 * @param {string} layer
 * @returns {string | null} ISO time, or null
 */
export function parseGeometLatestTime(xml, layer) {
  if (typeof xml !== 'string') return null;
  const at = xml.indexOf(`<Name>${layer}</Name>`);
  if (at < 0) return null;
  const rest = xml.slice(at, at + 6000);
  const m = /<Dimension[^>]*name="time"[^>]*>([^<]+)<\/Dimension>/.exec(rest);
  if (!m || !m[1]) return null;
  const text = m[1].trim();
  /** @type {string | undefined} */
  let latest;
  if (text.includes(',')) latest = text.split(',').map((s) => s.trim()).filter(Boolean).pop();
  else if (text.includes('/')) { const parts = text.split('/'); latest = parts.length >= 2 ? parts[1] : parts[0]; }
  else latest = text;
  if (!latest) return null;
  const t = Date.parse(latest);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

/**
 * Five-minute bucket for the ?t= tile parameter (UTC, minutes floored to a multiple of five).
 * @param {Date} now
 * @returns {string} for example 202610050850
 */
export function fiveMinuteBucket(now) {
  const d = new Date(Math.floor(now.getTime() / 300_000) * 300_000);
  const p = (/** @type {number} */ n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}`;
}

/**
 * @param {string} template registry urlTemplate of iem-nexrad-n0q
 * @param {Date} now
 * @returns {string}
 */
export function iemTileUrl(template, now) {
  return `${template}${template.includes('?') ? '&' : '?'}t=${fiveMinuteBucket(now)}`;
}

/**
 * WMS 1.3.0 GetMap tile URL from the registry template; `{bbox-epsg-3857}` stays a MapLibre placeholder.
 * Without a published time the TIME parameter is left out and the server returns its default (latest).
 * @param {string} template registry urlTemplate of eccc-geomet-radar
 * @param {string} layer
 * @param {string | null} time ISO
 * @returns {string}
 */
export function wmsTileUrl(template, layer, time) {
  let out = template.replace('{layer}', layer);
  out = time ? out.replace('{time}', time) : out.replace(/&time=\{time\}/, '');
  return out;
}

/**
 * @param {Record<string, unknown>} [opts]
 * @returns {MapLayerX}
 */
export function createRadarLayer(opts) {
  const ids = ['radar:us', 'radar:ca-rain', 'radar:ca-snow'];
  const sources = ['radar-us', 'radar-ca-rain', 'radar-ca-snow'];
  /** @type {MapContext | null} */
  let ctx = null;
  let visible = true;
  /** @type {string | null} */
  let usTime = null;
  /** @type {string | null} */
  let caTime = null;
  let usChecked = '';
  let caChecked = '';
  /** @type {ReturnType<typeof setInterval>[]} */
  let timers = [];
  let lastUs = 0;
  let lastCa = 0;
  const sourceIds = [IEM_TILES_ID, ECCC_TILES_ID];

  /** @returns {{ signal?: AbortSignal }} */
  const signalOf = () => (ctx?.signal ? { signal: ctx.signal } : {});

  /** @param {Date} when */
  const clock = (when) => formatTime(when.toISOString());

  function report() {
    if (!ctx) return;
    if (usTime || caTime) ctx.status(layerStatus('live', 'Radar shown at its published valid time.', sourceIds, usTime ?? caTime));
    else ctx.status(layerStatus('degraded', `Mosaic time not published; checked ${usChecked || caChecked}`.trim(), sourceIds));
  }

  async function refreshUs() {
    const map = ctx?.map;
    const rec = findSource(IEM_TILES_ID);
    if (!map || !rec?.urlTemplate) return;
    lastUs = Date.now();
    const now = new Date();
    /** @type {import('maplibre-gl').RasterTileSource | undefined} */ (map.getSource('radar-us'))?.setTiles([iemTileUrl(rec.urlTemplate, now)]);
    const res = await fetchJson(IEM_TIME_ID, signalOf());
    usTime = res.ok ? parseIemValidTime(res.data) : null;
    usChecked = `${clock(new Date())}.`;
    report();
  }

  async function refreshCa() {
    const map = ctx?.map;
    const rec = findSource(ECCC_TILES_ID);
    if (!map || !rec?.urlTemplate) return;
    lastCa = Date.now();
    const res = await fetchText(ECCC_TIMES_ID, { params: { service: 'WMS', version: '1.3.0', request: 'GetCapabilities', layer: ECCC_LAYERS.rain }, ...signalOf() });
    caTime = res.ok ? parseGeometLatestTime(res.data, ECCC_LAYERS.rain) : null;
    caChecked = `${clock(new Date())}.`;
    /** @type {import('maplibre-gl').RasterTileSource | undefined} */ (map.getSource('radar-ca-rain'))?.setTiles([wmsTileUrl(rec.urlTemplate, ECCC_LAYERS.rain, caTime)]);
    /** @type {import('maplibre-gl').RasterTileSource | undefined} */ (map.getSource('radar-ca-snow'))?.setTiles([wmsTileUrl(rec.urlTemplate, ECCC_LAYERS.snow, caTime)]);
    report();
  }

  function stopTimers() {
    for (const t of timers.splice(0)) clearInterval(t);
  }

  function startTimers() {
    stopTimers();
    if (!visible || document.hidden) return;
    timers.push(setInterval(() => { void refreshUs(); }, APP.poll.radarTiles));
    timers.push(setInterval(() => { void refreshCa(); }, ECCC_REFRESH_MS));
  }

  function onVisibility() {
    if (document.hidden) { stopTimers(); return; }
    startTimers();
    if (visible && ctx) {
      if (Date.now() - lastUs >= APP.poll.radarTiles) void refreshUs();
      if (Date.now() - lastCa >= ECCC_REFRESH_MS) void refreshCa();
    }
  }

  return {
    id: 'radar',
    sourceIds,
    async add(c) {
      ctx = /** @type {MapContext} */ (c);
      const map = ctx.map;
      if (!map) return;
      const us = findSource(IEM_TILES_ID);
      const ca = findSource(ECCC_TILES_ID);
      if (!us?.urlTemplate && !ca?.urlTemplate) {
        ctx.status(layerStatus('unavailable', 'Radar sources are not in the source registry.', sourceIds));
        return;
      }
      const paint = { 'raster-opacity': RADAR_OPACITY, 'raster-fade-duration': 0 };
      if (us?.urlTemplate) {
        map.addSource('radar-us', { type: 'raster', tiles: [iemTileUrl(us.urlTemplate, new Date())], tileSize: 256, maxzoom: 12, bounds: /** @type {any} */ (US_BOUNDS), attribution: us.attribution });
        addOrdered(map, 'radar', { id: 'us', type: 'raster', source: 'radar-us', paint });
      }
      if (ca?.urlTemplate) {
        for (const [key, layer] of Object.entries(ECCC_LAYERS)) {
          map.addSource(`radar-ca-${key === 'rain' ? 'rain' : 'snow'}`, { type: 'raster', tiles: [wmsTileUrl(ca.urlTemplate, layer, null)], tileSize: 256, maxzoom: 12, bounds: /** @type {any} */ (BC_BOUNDS), attribution: ca.attribution });
          addOrdered(map, 'radar', { id: key === 'rain' ? 'ca-rain' : 'ca-snow', type: 'raster', source: `radar-ca-${key}`, paint });
        }
      }
      document.addEventListener('visibilitychange', onVisibility);
      startTimers();
      // The first valid-time reads run after the layer is on the map, so a slow time endpoint never delays it.
      void refreshUs();
      void refreshCa();
    },
    setVisible(on) {
      visible = on;
      setLayersVisible(ctx?.map ?? null, ids, on);
      if (on) { startTimers(); onVisibility(); } else stopTimers();
    },
    legendItems() {
      /** @type {import('../../types.js').LegendItem[]} */
      const items = [];
      items.push({
        id: 'radar-us', label: 'U.S. Radar (Reflectivity)', swatchClass: 'map-swatch--radar',
        note: usTime ? `Valid ${formatAsOf(usTime)}.` : `Mosaic time not published; checked ${usChecked || 'not yet'}`,
      });
      items.push({
        id: 'radar-ca', label: 'British Columbia Radar (Rain and Snow)', swatchClass: 'map-swatch--radar',
        note: caTime ? `Valid ${formatAsOf(caTime)}.` : `Mosaic time not published; checked ${caChecked || 'not yet'}`,
      });
      items.push({ id: 'radar-ak', label: 'Southeast Alaska', swatchClass: 'map-swatch--none', note: 'Outside the continental U.S. radar mosaic.' });
      return items;
    },
    remove() {
      stopTimers();
      document.removeEventListener('visibilitychange', onVisibility);
      removeAll(ctx?.map ?? null, ids, sources);
      ctx = null;
    },
  };
}
