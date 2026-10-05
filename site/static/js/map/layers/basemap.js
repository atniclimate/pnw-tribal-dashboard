// @ts-check
/**
 * CARTO Dark Matter raster basemap with tile-failure handling. Implements MapLayer (blueprint 4.3, 4.4).
 *
 * The outline layer is always present and is added before this one resolves (create-map); this layer only
 * ever sits beneath it. When more than half of the basemap tiles fail within the window, or the device is
 * offline, the basemap is hidden, the layer reports `degraded`, and it retries once when the browser comes
 * back online (blueprint 4.3).
 *
 * Owner: lane L8.
 */
import { findSource, isEnabled } from '../../core/sources.js';
import { APP } from '../../config/app.js';
import { addOrdered, layerStatus, removeAll, setLayersVisible } from '../style.js';

/** @typedef {import('../style.js').MapContext} MapContext */
/** @typedef {import('../../types.js').MapLayer} MapLayer */

export const BASEMAP_SOURCE_ID = 'carto-dark-matter';
export const BASEMAP_DEGRADED_TEXT = 'Base map tiles unavailable; outlines shown.';
export const BASEMAP_OFF_TEXT = 'Base map not enabled; outlines shown.';

/**
 * The basemap draws only from a record whose terms are settled (`status: active`). The data-terms decision
 * of 10/05/2026 (Q10) requires an ATNI key; keyless tiles return a watermark that loads like a real tile, so
 * an `active-pending-terms` record means the basemap is off by configuration, not failed. This gate lives here
 * because core/sources.js isEnabled treats pending-terms records as enabled for every other use.
 * @param {{ status?: string, urlTemplate?: string | null } | null | undefined} rec
 * @returns {boolean}
 */
export function basemapConfigured(rec) {
  return Boolean(rec && rec.status === 'active' && rec.urlTemplate);
}

/**
 * Pure decision used by the layer and its tests: have enough tiles failed to give the basemap up?
 * @param {{ failed: number, loaded: number, offline: boolean }} counts
 * @returns {boolean}
 */
export function basemapShouldDegrade(counts) {
  if (counts.offline) return true;
  const total = counts.failed + counts.loaded;
  return counts.failed >= 2 && counts.failed > total / 2;
}

/**
 * Tile URL from the registry template; the @2x file is used on high-density screens outside low-data mode.
 * @param {string} template
 * @param {{ highDensity: boolean, lowData: boolean }} opts
 * @returns {string}
 */
export function basemapTileUrl(template, opts) {
  return opts.highDensity && !opts.lowData ? template.replace(/\.png(?=$|\?)/, '@2x.png') : template;
}

/**
 * @param {Record<string, unknown>} [opts]
 * @returns {MapLayer}
 */
export function createBasemapLayer(opts) {
  const sourceKey = 'basemap';
  const layerId = 'basemap:raster';
  /** @type {MapContext | null} */
  let ctx = null;
  let degraded = false;
  let off = false;
  let retried = false;
  let failed = 0;
  let loaded = 0;
  let visible = true;
  /** @type {(() => void)[]} */
  let cleanups = [];
  /** @type {ReturnType<typeof setTimeout> | null} */
  let timer = null;

  function degrade() {
    if (degraded || !ctx) return;
    degraded = true;
    setLayersVisible(ctx.map, [layerId], false);
    ctx.status(layerStatus('degraded', BASEMAP_DEGRADED_TEXT, [BASEMAP_SOURCE_ID]));
  }

  function restore() {
    if (!degraded || retried || !ctx) return;
    retried = true;
    degraded = false;
    failed = 0;
    loaded = 0;
    if (visible) setLayersVisible(ctx.map, [layerId], true);
    ctx.status(layerStatus('live', 'Retrying base map tiles.', [BASEMAP_SOURCE_ID]));
    startWindow();
  }

  function startWindow() {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      if (basemapShouldDegrade({ failed, loaded, offline: false })) degrade();
    }, APP.map.tileFailureWindowMs);
  }

  return {
    id: 'basemap',
    sourceIds: [BASEMAP_SOURCE_ID],
    async add(c) {
      ctx = /** @type {MapContext} */ (c);
      const map = ctx.map;
      const rec = findSource(BASEMAP_SOURCE_ID);
      if (!map || !rec || !isEnabled(BASEMAP_SOURCE_ID) || !basemapConfigured(rec) || !rec.urlTemplate) {
        // Off by configuration: no tile request is made. create-map keeps the pill live for this state and the
        // legend carries the absence (absence shown as status, not reported as a fault).
        off = true;
        ctx.status(layerStatus('unavailable', BASEMAP_OFF_TEXT, [BASEMAP_SOURCE_ID]));
        return;
      }
      const highDensity = (typeof devicePixelRatio === 'number' ? devicePixelRatio : 1) > 1.5;
      map.addSource(sourceKey, {
        type: 'raster',
        tiles: [basemapTileUrl(rec.urlTemplate, { highDensity, lowData: ctx.lowData })],
        tileSize: 256,
        maxzoom: Number(opts?.maxZoom ?? 12),
        attribution: rec.attribution,
      });
      addOrdered(map, 'basemap', { id: 'raster', type: 'raster', source: sourceKey, paint: { 'raster-fade-duration': 0 } });
      /** @param {any} e */
      const onError = (e) => {
        if (e?.sourceId !== sourceKey) return;
        failed += 1;
        if (basemapShouldDegrade({ failed, loaded, offline: false })) degrade();
      };
      /** @param {any} e */
      const onData = (e) => {
        if (e?.sourceId === sourceKey && e.tile) loaded += 1;
      };
      const onOffline = () => degrade();
      const onOnline = () => restore();
      map.on('error', onError);
      map.on('data', onData);
      addEventListener('offline', onOffline);
      addEventListener('online', onOnline);
      cleanups = [
        () => map.off('error', onError),
        () => map.off('data', onData),
        () => removeEventListener('offline', onOffline),
        () => removeEventListener('online', onOnline),
      ];
      if (typeof navigator !== 'undefined' && navigator.onLine === false) degrade();
      else startWindow();
    },
    setVisible(on) {
      visible = on;
      if (!degraded) setLayersVisible(ctx?.map ?? null, [layerId], on);
    },
    legendItems() {
      if (off) return [{ id: 'basemap', label: 'Base Map', swatchClass: 'map-swatch--basemap-off', note: BASEMAP_OFF_TEXT }];
      return degraded ? [{ id: 'basemap', label: 'Base Map', swatchClass: 'map-swatch--basemap-off', note: BASEMAP_DEGRADED_TEXT }] : [];
    },
    remove() {
      if (timer) clearTimeout(timer);
      timer = null;
      for (const c of cleanups.splice(0)) c();
      removeAll(ctx?.map ?? null, [layerId], [sourceKey]);
      ctx = null;
    },
  };
}
