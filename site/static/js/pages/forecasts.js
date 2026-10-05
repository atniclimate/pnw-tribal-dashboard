// @ts-check
/**
 * Entry module for the forecasts page (blueprint 7.3). Loaded by <script type="module">; its static imports are
 * listed in the page's modulepreload block (check:preload).
 *
 * Six views behind ARIA tabs. Every panel is mounted at start so each carries its provenance footer, but a
 * panel loads only when its view is opened (until then it says so), and each view's code is a dynamic import
 * (ui/forecast-view-*.js), so the static graph stays small. Images load on a labeled tap, except the small
 * stills the media viewer may load itself; maps, CW3E, and the video player are dynamic imports too. Nothing
 * here invents a value: a source that cannot answer leaves its panel unavailable, with the reason.
 */
import { initChrome, pageSourceIds, setNationChip } from '../ui/chrome.js';
import { initEmbed } from '../core/embed.js';
import { mountPanel } from '../ui/panel.js';
import { initTabs } from '../ui/tabs.js';
import { clear, h } from '../core/dom.js';
import { fetchLocal } from '../core/net.js';
import { findSource, loadSources } from '../core/sources.js';
import { deriveStatus } from '../core/status.js';
import { getItem } from '../core/storage.js';
import { onStateChange, readState, setIdRedirects, writeState } from '../core/url-state.js';
import { APP } from '../config/app.js';
import { loadNationContext, loadNationOptions, systemFor } from '../forecast/nation-context.js';

/** @typedef {import('../types.js').StatusSnapshot} StatusSnapshot */
/** @typedef {import('../forecast/nation-context.js').NationContext} NationContext */
/** @typedef {import('../ui/forecast-views.js').ViewContext} ViewContext */
/** @typedef {import('../ui/forecast-views.js').ViewPanels} ViewPanels */

export const VIEWS = Object.freeze(['local', 'precip', 'ar', 'satellite', 'radar', 'rivers']);
const GOES_KEYS = ['geocolor', 'airmass', 'band-08', 'band-13', 'band-09', 'band-10'];

/** @type {import('../types.js').UrlStateSchema} */
const SCHEMA = Object.freeze({
  view: { type: 'enum', values: VIEWS },
  n: { type: 'nation-id' },
  units: { type: 'enum', values: ['us', 'metric'] },
  lowdata: { type: 'flag' },
  g: { type: 'string' },
  p: { type: 'enum', values: GOES_KEYS },
});

/** View code, loaded the first time a view's panels need it. */
const MODULES = Object.freeze(/** @type {Record<string, () => Promise<{ panels: ViewPanels }>>} */ ({
  local: () => import('../ui/forecast-view-local.js'),
  imagery: () => import('../ui/forecast-view-imagery.js'),
  rivers: () => import('../ui/forecast-view-rivers.js'),
}));

/**
 * Panels in page order: the view each belongs to, its registry sources (they must equal the markup's
 * data-sources), whether it refreshes while visible, and the module that implements it.
 * @type {readonly { name: string, view: string, sourceIds: string[], poll?: boolean, module: keyof typeof MODULES }[]}
 */
const PANELS = Object.freeze([
  { name: 'forecast-local', view: 'local', sourceIds: ['nws-points', 'nws-stations', 'nws-observations', 'nws-forecast', 'eccc-citypage-realtime'], poll: true, module: 'local' },
  { name: 'forecast-qpf', view: 'local', sourceIds: ['nws-gridpoints'], poll: true, module: 'local' },
  { name: 'forecast-afd', view: 'local', sourceIds: ['nws-afd'], poll: true, module: 'local' },
  { name: 'precip-wpc', view: 'precip', sourceIds: ['wpc-images'], module: 'imagery' },
  { name: 'ar-cw3e', view: 'ar', sourceIds: ['cw3e-images'], module: 'imagery' },
  { name: 'ar-mtpw', view: 'ar', sourceIds: ['ssec-mtpw2'], module: 'imagery' },
  { name: 'satellite-goes', view: 'satellite', sourceIds: ['goes18-star-cdn'], module: 'imagery' },
  { name: 'radar-map', view: 'radar', sourceIds: ['iem-nexrad-n0q', 'eccc-geomet-radar', 'carto-dark-matter'], module: 'imagery' },
  { name: 'radar-ridge', view: 'radar', sourceIds: ['nws-ridge'], module: 'imagery' },
  { name: 'rivers-gauges', view: 'rivers', sourceIds: ['nwps-gauges', 'eccc-hydrometric-realtime'], poll: true, module: 'rivers' },
  { name: 'rivers-bc-rfc', view: 'rivers', sourceIds: ['bc-rfc-flood-advisories'], poll: true, module: 'rivers' },
]);

const IDLE_REASON = 'Not loaded yet. This view loads when it is opened.';

/** @returns {boolean} */
function lowDataOn() {
  const fromUrl = readState(SCHEMA).lowdata;
  if (typeof fromUrl === 'boolean') return fromUrl;
  if (getItem('lowdata') === '1') return true;
  return Boolean(/** @type {any} */ (globalThis.navigator)?.connection?.saveData);
}

/**
 * An unavailable status that names its reason.
 * @param {string[]} sourceIds
 * @param {string} reason
 * @returns {StatusSnapshot}
 */
function unavailable(sourceIds, reason) {
  return deriveStatus({ sourceIds, policy: APP.freshness.forecasts, now: new Date(), unavailableReason: reason });
}

/**
 * Links to other sites open in a new tab with rel="noopener noreferrer" (blueprint 7.12), including the ones
 * panels and provenance footers create after load.
 * @param {HTMLElement} root
 * @returns {MutationObserver}
 */
function watchOutwardLinks(root) {
  const fix = (/** @type {ParentNode} */ scope) => {
    for (const a of scope.querySelectorAll('a[href]')) {
      let outward = false;
      try { const u = new URL(/** @type {HTMLAnchorElement} */ (a).href); outward = u.origin !== location.origin && /^https?:$/.test(u.protocol); } catch { /* not a URL */ }
      if (outward && a.getAttribute('target') !== '_blank') a.setAttribute('target', '_blank');
      if (outward && !/noopener/.test(a.getAttribute('rel') ?? '')) a.setAttribute('rel', 'noopener noreferrer');
    }
  };
  fix(root);
  const observer = new MutationObserver((records) => {
    for (const r of records) for (const n of r.addedNodes) if (n instanceof Element) { if (n.matches('a[href]')) fix(n.parentNode ?? root); else fix(n); }
  });
  observer.observe(root, { childList: true, subtree: true });
  return observer;
}

export async function main() {
  initEmbed({ page: 'forecasts' });
  const mainEl = document.getElementById('main');
  if (mainEl) watchOutwardLinks(mainEl);
  /** @type {Record<string, string>} */
  const names = {};
  try {
    await loadSources();
    for (const id of pageSourceIds(document)) { const r = findSource(id); if (r) names[id] = r.attribution || r.owner; }
  } catch { /* the footer then lists nothing by name and each panel says what failed */ }
  initChrome({ page: 'forecasts', sources: names });
  try {
    const redirects = await fetchLocal('data/registry/id-redirects.json');
    if (redirects.ok) setIdRedirects(/** @type {any} */ (redirects.data));
  } catch { /* an absent redirect table means no redirects */ }

  /** @type {Set<string>} */
  const opened = new Set();
  /** @type {Map<string, { handle: ReturnType<typeof mountPanel>, view: string, cleanup: (() => void) | null }>} */
  const panels = new Map();
  /** @type {Map<string, ViewPanels>} */
  const loaded = new Map();
  /** @type {NationContext | null} */
  let nation = null;
  /** @type {Promise<NationContext | null>} */
  let nationReady = Promise.resolve(null);

  /** @type {ViewContext} */
  const ctx = {
    nation: () => nation,
    nationReady: () => nationReady,
    system: () => systemFor(nation, /** @type {'us' | 'metric' | null} */ (readState(SCHEMA).units ?? null)),
    timeZone: () => nation?.timeZone,
    lowData: lowDataOn,
    isOpened: (view) => opened.has(view),
    state: () => readState(SCHEMA),
    writeState: (patch, o) => writeState(patch, o),
  };

  /** @param {string} key */
  async function moduleFor(key) {
    let m = loaded.get(key);
    if (!m) { m = (await /** @type {() => Promise<{ panels: ViewPanels }>} */ (MODULES[key])()).panels; loaded.set(key, m); }
    return m;
  }

  for (const def of PANELS) {
    const slot = document.querySelector(`[data-panel="${def.name}"]`);
    if (!(slot instanceof HTMLElement)) continue;
    /** @type {{ handle: ReturnType<typeof mountPanel>, view: string, cleanup: (() => void) | null }} */
    const entry = { handle: /** @type {any} */ (null), view: def.view, cleanup: null };
    /** @param {(() => void) | void} c */
    const keep = (c) => { entry.cleanup = typeof c === 'function' ? c : null; };
    entry.handle = mountPanel(slot, {
      title: slot.querySelector('.panel__title')?.textContent ?? def.name,
      sourceIds: def.sourceIds,
      statusId: def.name,
      ...(def.poll ? { poll: { visibleMs: APP.poll.forecasts, minMs: APP.poll.forecasts } } : {}),
      load: async (signal) => {
        if (!opened.has(def.view)) return { data: null, status: unavailable(def.sourceIds, IDLE_REASON) };
        entry.cleanup?.(); entry.cleanup = null;
        const m = await moduleFor(def.module);
        return /** @type {any} */ (m)[def.name].load(ctx, signal);
      },
      render: (body, data, status) => keep(loaded.get(def.module)?.[def.name]?.render(body, data, status, ctx)),
      renderUnavailable: (body, status) => {
        entry.cleanup?.(); entry.cleanup = null;
        const custom = loaded.get(def.module)?.[def.name]?.unavailable;
        if (custom) { keep(custom(body, status, ctx)); return; }
        clear(body);
        // The official links are in the provenance footer, which always names and links every source.
        body.append(h('p', { class: 'panel-unavailable' }, status.detail ?? 'No data is available right now.'));
      },
    });
    panels.set(def.name, entry);
  }

  /** @param {string} view */
  function openView(view) {
    const first = !opened.has(view);
    opened.add(view);
    if (first) for (const e of panels.values()) if (e.view === view) void e.handle.refresh();
  }

  /** @param {boolean} [refresh] */
  function reloadNation(refresh = true) {
    const id = readState(SCHEMA).n;
    nationReady = typeof id === 'string' ? loadNationContext(id).then((c) => { nation = c; return c; }) : Promise.resolve(null).then(() => { nation = null; return null; });
    void nationReady.then((c) => {
      setNationChip(c ? c.name : null);
      const select = document.getElementById('nation-select');
      if (select instanceof HTMLSelectElement) {
        if (c && ![...select.options].some((o) => o.value === c.id)) select.append(h('option', { value: c.id }, c.name));
        select.value = c ? c.id : '';
      }
      for (const link of document.querySelectorAll('[data-view-link]')) {
        const v = link.getAttribute('data-view-link') ?? '';
        link.setAttribute('href', `./?view=${v}${c ? `&n=${encodeURIComponent(c.id)}` : ''}`);
      }
      if (refresh) for (const e of panels.values()) if (opened.has(e.view)) void e.handle.refresh();
    });
  }

  function mountNationSelect() {
    const wrap = document.querySelector('[data-nation-select]');
    if (!(wrap instanceof HTMLElement)) return;
    const select = wrap.querySelector('select');
    if (!(select instanceof HTMLSelectElement)) return;
    wrap.hidden = false;
    let filled = false;
    const fill = async () => {
      if (filled) return;
      filled = true;
      const list = await loadNationOptions();
      const keep = select.value;
      clear(select);
      select.append(h('option', { value: '' }, 'Choose a Nation'));
      for (const n of list) select.append(h('option', { value: n.id }, n.name));
      select.value = keep;
    };
    select.addEventListener('focus', () => { void fill(); });
    select.addEventListener('pointerdown', () => { void fill(); });
    select.addEventListener('change', () => { writeState({ n: select.value || undefined }, { push: true }); });
  }

  const tabs = document.querySelector('[data-tabs]');
  const state0 = readState(SCHEMA);
  const startView = typeof state0.view === 'string' ? state0.view : (typeof state0.g === 'string' ? 'rivers' : 'local');
  mountNationSelect();
  reloadNation(false);
  if (tabs instanceof HTMLElement) {
    const t = initTabs(tabs, { onChange: (id) => { writeState({ view: id }, { push: true }); openView(id); } });
    if (state0.view === undefined && startView !== 'local') t.select(startView);
  }
  openView(startView);
  onStateChange(() => {
    const s = readState(SCHEMA);
    if ((s.n ?? null) !== (nation?.id ?? null)) reloadNation();
  });
}

if (globalThis.document) void main();
