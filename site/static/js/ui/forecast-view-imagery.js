// @ts-check
/**
 * Image views of the forecasts page (blueprint 7.3): precipitation images, atmospheric rivers, satellite, and
 * radar. Loaded on first use by pages/forecasts.js (a dynamic import). DOM module.
 */
import { APP } from '../config/app.js';
import { fetchLocal } from '../core/net.js';
import { renderProvenance } from '../core/provenance.js';
import { findSource } from '../core/sources.js';
import { deriveStatus } from '../core/status.js';
import { h } from '../core/dom.js';
import { panelStatuses } from './panel.js';
import { cycleDate, resolveCycleFromManifest } from '../forecast/cw3e.js';
import { goesProduct } from '../forecast/goes.js';
import { imageryStatus, loadCatalog, loadStamps } from '../forecast/imagery.js';
import { nearestRadarSite, ridgeProductIds, ridgeSites } from '../forecast/radar.js';
import { wpcProducts } from '../forecast/wpc.js';
import { loadReference } from '../data/reference.js';
import { NO_NATION, unavailableStatus } from './forecast-panels.js';
import { mountMapFrame, renderCw3e, renderGoes, renderMtpw, renderRidge, renderWpc } from './imagery-panels.js';

/** @typedef {import('../types.js').StatusSnapshot} StatusSnapshot */

export const GOES_KEYS = Object.freeze(['geocolor', 'airmass', 'band-08', 'band-13', 'band-09', 'band-10']);
const IMAGERY_TTL_MS = 10 * 60_000;
const RADAR_MAP_SOURCES = ['iem-nexrad-n0q', 'eccc-geomet-radar', 'carto-dark-matter'];

/** @type {{ at: number, value: { catalog: Map<string, any> | null, env: any, stamps: Map<string, any> } } | null} */
let imagery = null;

/** The imagery catalog and the scheduled stamps, read together and held for ten minutes. */
async function getImagery() {
  if (imagery && Date.now() - imagery.at < IMAGERY_TTL_MS) return imagery.value;
  const [catalog, stamps] = await Promise.all([loadCatalog(), loadStamps()]);
  imagery = { at: Date.now(), value: { catalog, env: stamps.env, stamps: stamps.stamps } };
  return imagery.value;
}

/**
 * @param {import('./forecast-views.js').ViewContext} ctx
 * @param {{ catalog: Map<string, any>, stamps: Map<string, any> }} r
 */
const imageryCtx = (ctx, r) => ({ catalog: r.catalog, stamps: r.stamps, timeZone: ctx.timeZone(), lowData: ctx.lowData() });

/** @type {import('./forecast-views.js').ViewPanels} */
export const panels = {
  'precip-wpc': {
    async load() {
      const r = await getImagery();
      if (!r.catalog) return { data: null, status: unavailableStatus(['wpc-images'], 'The image list could not be read.') };
      const products = wpcProducts([...r.catalog.values()]);
      const status = imageryStatus('wpc-images', r.env, r.stamps, products.map((p) => p.id), new Date());
      return { data: status.state === 'unavailable' ? null : { products, r }, status };
    },
    render(body, data, _s, ctx) { return renderWpc(body, data.products, imageryCtx(ctx, data.r)).destroy; },
  },

  'ar-cw3e': {
    async load(_ctx, signal) {
      const res = await fetchLocal('data/live/ar-products.json', { priority: 2, cache: 'no-cache', signal });
      const env = res.ok ? /** @type {any} */ (res.data) : null;
      const now = new Date();
      const resolved = resolveCycleFromManifest(env, now);
      if (!resolved) return { data: null, status: unavailableStatus(['cw3e-images'], 'The scheduled model-run list is not available, so no forecast image can be stamped with its model run.') };
      const policy = findSource('cw3e-images')?.freshness ?? APP.freshness.forecasts;
      const status = deriveStatus({ sourceIds: ['cw3e-images'], policy, now, snapshot: { asOf: cycleDate(resolved.cycle).toISOString(), asOfBasis: 'model-run', carriedForward: Boolean(env?.carriedForward) } });
      const r = await getImagery();
      return { data: { manifest: env, stale: resolved.stale, r }, status };
    },
    render(body, data, _s, ctx) {
      const r = data.r.catalog ? data.r : { catalog: new Map(), stamps: new Map() };
      return renderCw3e(body, { manifest: data.manifest, stale: data.stale }, imageryCtx(ctx, r)).destroy;
    },
  },

  'ar-mtpw': {
    async load() {
      const r = await getImagery();
      const product = r.catalog?.get('ssec-mtpw2-epac');
      if (!r.catalog || !product) return { data: null, status: unavailableStatus(['ssec-mtpw2'], 'The animation is not listed.') };
      const status = imageryStatus('ssec-mtpw2', r.env, r.stamps, [product.id], new Date());
      return { data: status.state === 'unavailable' ? null : { product, stamp: r.stamps.get(product.id)?.lastModified ?? null, r }, status };
    },
    render(body, data, _s, ctx) { return renderMtpw(body, { product: data.product, stamp: data.stamp }, imageryCtx(ctx, data.r)).destroy; },
  },

  'satellite-goes': {
    async load() {
      const r = await getImagery();
      if (!r.catalog) return { data: null, status: unavailableStatus(['goes18-star-cdn'], 'The image list could not be read.') };
      const ids = GOES_KEYS.map((k) => `goes18-pnw-${goesProduct(k).slug}-300`);
      const status = imageryStatus('goes18-star-cdn', r.env, r.stamps, ids, new Date());
      return { data: status.state === 'unavailable' ? null : { r }, status };
    },
    render(body, data, _s, ctx) {
      const selected = /** @type {string} */ (ctx.state().p ?? 'geocolor');
      return renderGoes(body, imageryCtx(ctx, data.r), { selected, onSelect: (key) => ctx.writeState({ p: key === 'geocolor' ? undefined : /** @type {any} */ (key) }) }).destroy;
    },
  },

  'radar-map': {
    async load() {
      return { data: null, status: unavailableStatus(RADAR_MAP_SOURCES, 'The radar map is not loaded yet. Tap Show Map to load it.') };
    },
    render() {},
    unavailable(body, status, ctx) {
      body.append(h('p', { class: 'panel-unavailable' }, status.detail ?? ''));
      // The map request (a labeled button) is offered only once this view is open.
      if (!ctx.isOpened('radar')) return;
      const slot = /** @type {HTMLElement} */ (document.querySelector('[data-panel="radar-map"]'));
      const nation = ctx.nation();
      const holder = h('div', { 'data-map-holder': '' });
      body.append(holder);
      return mountMapFrame(holder, {
        label: 'Radar map', layers: ['basemap', 'outlines', 'hq', 'radar'], sourceIds: RADAR_MAP_SOURCES, hq: nation?.hq ?? null, nationId: nation?.id ?? null, bytes: APP.map.firstLoadLabelBytes,
        importMap: async () => {
          const mod = await import('../map/create-map.js');
          return {
            createMap: async (/** @type {HTMLElement} */ f, /** @type {any} */ o) => {
              const m = await mod.createMap(f, o);
              const now = new Date();
              /** @type {StatusSnapshot} */
              const live = { state: 'live', asOf: now.toISOString(), asOfBasis: 'retrieved', sourceIds: RADAR_MAP_SOURCES, origin: 'direct', completeness: 'complete', checkedAt: now.toISOString(), detail: 'Radar tiles refresh while the map is visible; valid times are in the map legend.' };
              const footer = slot.querySelector('[data-provenance]');
              const tz = ctx.timeZone();
              if (footer instanceof HTMLElement) renderProvenance(footer, live, RADAR_MAP_SOURCES.map((id) => findSource(id)).filter((r) => r !== null), tz ? { timeZone: tz } : {});
              try { panelStatuses.report('radar-map', live); } catch { /* an invalid snapshot is never shown */ }
              return m;
            },
          };
        },
      }).destroy;
    },
  },

  'radar-ridge': {
    async load(ctx, signal) {
      const n = await ctx.nationReady();
      if (!n) return { data: null, status: unavailableStatus(['nws-ridge'], NO_NATION) };
      const ref = await loadReference('ref/radar-sites.json', { signal });
      const site = ref.ok ? nearestRadarSite(n.hq, ridgeSites(/** @type {any} */ (ref.data))) : null;
      if (!site) return { data: null, status: unavailableStatus(['nws-ridge'], 'The radar site list could not be read.') };
      const r = await getImagery();
      if (!r.catalog) return { data: null, status: unavailableStatus(['nws-ridge'], 'The image list could not be read.') };
      const status = imageryStatus('nws-ridge', r.env, r.stamps, [ridgeProductIds(site.id).still], new Date());
      return { data: status.state === 'unavailable' ? null : { site, nationName: n.name, r }, status };
    },
    render(body, data, _s, ctx) { return renderRidge(body, { site: data.site, nationName: data.nationName }, imageryCtx(ctx, data.r)).destroy; },
  },
};
