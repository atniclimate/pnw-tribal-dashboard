// @ts-check
/**
 * Image views of the forecasts page (blueprint 7.3): precipitation images, atmospheric rivers, satellite, and
 * radar. Loaded on first use by pages/forecasts.js (a dynamic import). DOM module.
 */
import { APP } from '../config/app.js';
import { renderProvenance } from '../core/provenance.js';
import { findSource } from '../core/sources.js';
import { h } from '../core/dom.js';
import { panelStatuses } from './panel.js';
import { goesProduct } from '../forecast/goes.js';
import { imageryStatus, loadCatalog, loadStamps } from '../forecast/imagery.js';
import { nearestRadarSite, ridgeProductIds, ridgeSites } from '../forecast/radar.js';
import { wpcProducts } from '../forecast/wpc.js';
import { loadReference } from '../data/reference.js';
import { NO_NATION, unavailableStatus } from './forecast-panels.js';
import { mountMapFrame, renderGoes, renderLinkOut, renderRidge, renderWpc } from './imagery-panels.js';

/** @typedef {import('../types.js').StatusSnapshot} StatusSnapshot */

export const GOES_KEYS = Object.freeze(['geocolor', 'airmass', 'band-08', 'band-13', 'band-09', 'band-10']);
const IMAGERY_TTL_MS = 10 * 60_000;
const RADAR_MAP_SOURCES = ['iem-nexrad-n0q', 'eccc-geomet-radar'];

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

/**
 * A panel for a source whose terms allow a link and nothing more (decision Q11, 10/05/2026). Its status is
 * honestly unavailable: the dashboard holds no data from the source. The provenance footer still names the
 * source, and the panel carries a plain text link and the reason. No request goes to the provider.
 * @param {string} sourceId
 * @param {string} label
 * @param {string} note
 * @returns {import('./forecast-views.js').ViewPanels[string]}
 */
function linkOutPanel(sourceId, label, note) {
  return {
    async load() {
      return { data: null, status: unavailableStatus([sourceId], 'Shown as a link only. The provider does not allow its images to be shown here.') };
    },
    render() {},
    unavailable(body) {
      const href = findSource(sourceId)?.humanUrl ?? '';
      if (!href) { body.append(h('p', { class: 'panel-unavailable' }, 'The link to this source is not available.')); return; }
      return renderLinkOut(body, { id: sourceId, href, label, note }).destroy;
    },
  };
}

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
    render(body, data, _s, ctx) { return renderWpc(body, data.products, imageryCtx(ctx, data.r), {
      selected: String(ctx.state().wpc ?? 'wpc-qpf-day-1'), getSelected: () => String(ctx.state().wpc ?? 'wpc-qpf-day-1'),
      onSelect: (id) => ctx.writeState({ wpc: id }, { push: true }),
    }).destroy; },
  },

  'ar-cw3e': linkOutPanel('cw3e-images', 'Atmospheric river forecasts (CW3E)',
    'CW3E provides these forecasts for research and not for operational decisions, so the dashboard links to them and does not display them.'),

  'ar-mtpw': linkOutPanel('ssec-mtpw2', 'Total precipitable water animation (CIMSS, experimental)',
    'This is an experimental product and its copyright is reserved by the Space Science and Engineering Center, University of Wisconsin-Madison, so the dashboard links to it and does not display it.'),

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
      return renderGoes(body, imageryCtx(ctx, data.r), { selected, getSelected: () => String(ctx.state().p ?? 'geocolor'),
        onSelect: (key) => ctx.writeState({ p: key === 'geocolor' ? undefined : key }, { push: true }) }).destroy;
    },
  },

  'radar-map': {
    async load(ctx) {
      await ctx.nationReady();
      return { data: null, status: unavailableStatus(RADAR_MAP_SOURCES, 'Current observed radar is loading. It is not a precipitation forecast. Coverage and source times appear with the map.') };
    },
    render() {},
    unavailable(body, status, ctx) {
      body.append(h('p', { class: 'panel-note' }, 'Current observed radar, not a precipitation forecast. Transparent areas can be coverage gaps. Source times and availability appear with the map.'));
      // The map request (a labeled button) is offered only once this view is open.
      if (!ctx.isOpened('radar')) return;
      const slot = /** @type {HTMLElement} */ (document.querySelector('[data-panel="radar-map"]'));
      const nation = ctx.nation();
      const holder = h('div', { 'data-map-holder': '' });
      body.append(holder);
      return mountMapFrame(holder, {
        label: 'Radar map', layers: ['outlines', 'hq', 'radar'], sourceIds: RADAR_MAP_SOURCES, hq: nation?.hq ?? null, nationId: nation?.id ?? null, bytes: APP.map.firstLoadLabelBytes, auto: !ctx.lowData(),
        importMap: async () => {
          const mod = await import('../map/create-map.js');
          return {
            createMap: async (/** @type {HTMLElement} */ f, /** @type {any} */ o) => {
              const m = await mod.createMap(f, o);
              m.onLayerStatus((id, snapshot) => {
                if (id !== 'radar') return;
                const footer = slot.querySelector('[data-provenance]');
                const tz = ctx.timeZone();
                if (footer instanceof HTMLElement) renderProvenance(footer, snapshot, RADAR_MAP_SOURCES.map((sourceId) => findSource(sourceId)).filter((r) => r !== null), tz ? { timeZone: tz } : {});
                try { panelStatuses.report('radar-map', snapshot); } catch { /* Invalid source status is never promoted to live. */ }
              });
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
