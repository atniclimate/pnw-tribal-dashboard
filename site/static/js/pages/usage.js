// @ts-check
/**
 * Entry module for the usage page (blueprint 7.8). Loaded by <script type="module">; its static imports are
 * listed in the page's modulepreload block (check:preload).
 *
 * The Sources view is a table generated from sources.json (never hand-written), the Status view comes from
 * health.json, and the lists of boundary sources and contacted hosts are read from the same registry, so a
 * source added in data/sources/ appears here without editing this page.
 */
import { initChrome } from '../ui/chrome.js';
import { initEmbed } from '../core/embed.js';
import { mountPanel } from '../ui/panel.js';
import { initTabs } from '../ui/tabs.js';
import { h } from '../core/dom.js';
import { fetchLocal } from '../core/net.js';
import { findSource, loadSources } from '../core/sources.js';
import { writeState } from '../core/url-state.js';
import { formatAsOf } from '../core/time.js';
import { statusPill, STATUS_LABELS } from '../ui/status-pill.js';

// The contacts helpers and the link helpers load lazily (started at the top of main), so the static graph of this
// entry fits budgets.json jsStaticGraph. Every use below runs after main has them.
/** @type {typeof import('../data/contacts.js')} */
let C;
/** @type {typeof import('../ui/contact-card.js')} */
let Card;
/** Settles when C and Card are loaded (set at the top of main). */
let modulesReady = Promise.resolve();

/** @typedef {import('../types.js').SourceRecord} SourceRecord */
/** @typedef {import('../types.js').StatusSnapshot} StatusSnapshot */

const SOURCES_PANEL = ['cthd-sources'];
const HEALTH_PANEL = ['cthd-health'];
const BOUNDARY_IDS = ['bia-lar', 'census-aiannh-2025', 'nrcan-aboriginal-lands-bc', 'isc-first-nations', 'bia-tld', 'bia-anv', 'emcr-bc-boundaries', 'census-cartographic-boundaries'];
const MODE_LABELS = Object.freeze(/** @type {Record<string, string>} */ ({
  direct: 'Direct from the browser', snapshot: 'Scheduled copy', 'direct+snapshot': 'Direct, with a scheduled copy', image: 'Image', video: 'Video',
  tiles: 'Map tiles', link: 'Link only', build: 'Built with the site',
}));
const CORS_LABELS = Object.freeze(/** @type {Record<string, string>} */ ({
  'verified-wildcard': 'Verified, any origin', 'verified-reflect': 'Verified, origin reflected', absent: 'Not offered', unverified: 'Not verified',
}));
const LEGEND = Object.freeze([
  ['live', 'The data is current for its source. Example: alerts retrieved a few minutes ago.'],
  ['cached', 'The page is showing a copy saved on this device, with its own time stamp.'],
  ['stale', 'The data is older than usual. It may no longer be true; check the issuing agency.'],
  ['degraded', 'Part of the data is missing or old. The panel says which part.'],
  ['unavailable', 'No data is available from this source right now. Nothing is shown in its place, and this is not an all-clear.'],
]);

/** @returns {Promise<SourceRecord[] | null>} */
async function loadSourceList() {
  const res = await fetchLocal('data/curated/sources.json');
  const items = res.ok ? /** @type {any} */ (res.data)?.items : null;
  return Array.isArray(items) ? items : null;
}

/** @param {SourceRecord} s @returns {string} */
const hostOf = (s) => { try { return new URL((s.urlTemplate ?? s.url).replace(/\{[^}]*\}/g, 'x')).hostname; } catch { return ''; } };

/**
 * @param {HTMLElement} body
 * @param {SourceRecord[]} list
 */
function renderSources(body, list) {
  const rows = [...list].sort((a, b) => a.title.localeCompare(b.title, 'en'));
  body.append(h('div', { class: 'table-wrap' }, h('table', {},
    h('caption', {}, `${rows.length} sources. Every endpoint the dashboard reads is listed here.`),
    h('thead', {}, h('tr', {}, ['Product', 'Owner', 'Access', 'Cadence', 'Licence', 'Browser Access Check', 'Verified'].map((t) => h('th', { scope: 'col' }, t)))),
    h('tbody', {}, rows.map((s) => h('tr', { id: `src-${s.id}` },
      h('td', {}, Card.outwardLink(s.humanUrl, s.title), s.status === 'active' ? '' : h('span', { class: 'caption' }, ` (${s.status})`)),
      h('td', {}, s.owner),
      h('td', {}, MODE_LABELS[s.access.mode] ?? s.access.mode),
      h('td', {}, s.cadence),
      h('td', {}, s.license),
      h('td', {}, `${CORS_LABELS[s.access.cors.status] ?? s.access.cors.status}, checked ${C.formatDay(s.access.cors.checkedAt)}`),
      h('td', {}, C.formatDay(s.verifiedAt))))))));
}

/** @param {SourceRecord[]} list */
function fillBoundaryAndHosts(list) {
  const boundary = document.querySelector('[data-boundary-sources]');
  if (boundary) {
    const found = BOUNDARY_IDS.map((id) => list.find((s) => s.id === id)).filter((s) => s !== undefined);
    if (found.length) boundary.replaceChildren(...found.map((s) => h('li', {}, `${s.title}, ${s.owner}. Last checked ${C.formatDay(s.verifiedAt)}.`)));
  }
  const hosts = document.querySelector('[data-host-list]');
  if (hosts) {
    const live = list.filter((s) => s.status !== 'retired' && ['direct', 'direct+snapshot', 'image', 'tiles', 'video'].includes(s.access.mode));
    const names = [...new Set(live.map(hostOf).filter(Boolean))].sort();
    if (names.length) hosts.replaceChildren(...names.map((n) => h('li', {}, n)));
  }
}

/** @param {HTMLElement} el */
function renderLegend(el) {
  el.append(h('ul', { class: 'plain' }, LEGEND.map(([state, text]) => h('li', {},
    statusPill(/** @type {any} */ (state), STATUS_LABELS[/** @type {keyof typeof STATUS_LABELS} */ (state)]), ' ', text))));
}

/**
 * @param {HTMLElement} slot
 * @param {() => boolean} wanted whether the Status view has been opened
 * @returns {import('../types.js').PanelHandle}
 */
function mountStatus(slot, wanted) {
  return mountPanel(slot, {
    title: 'System Status',
    sourceIds: HEALTH_PANEL,
    statusId: 'usage-status',
    load: async (signal) => {
      await modulesReady;
      const now = new Date();
      if (!wanted()) return { data: null, status: C.unavailableStatus(HEALTH_PANEL, 'The status table loads when this view is opened.', now) };
      const res = await fetchLocal('data/live/health.json', { signal });
      const env = res.ok ? /** @type {any} */ (res.data) : null;
      if (!env || !Array.isArray(env.items) || typeof env.asOf !== 'string') {
        return { data: null, status: C.unavailableStatus(HEALTH_PANEL, 'The status table has not been published yet, or could not be loaded.', now) };
      }
      /** @type {StatusSnapshot} */
      const status = { state: env.completeness === 'complete' ? 'live' : 'degraded', asOf: env.asOf, asOfBasis: env.asOfBasis ?? 'observed', sourceIds: [...HEALTH_PANEL],
        origin: 'snapshot', completeness: env.completeness === 'complete' ? 'complete' : 'partial', checkedAt: now.toISOString(),
        detail: env.carriedForward ? 'This table could not be refreshed on the last run; it is an earlier copy.' : 'Written by the scheduled run.' };
      return { data: env.items, status };
    },
    render: (body, data) => {
      const items = /** @type {Array<{ id: string, kind: string, state: string, observedAt: string | null, detail: string, carriedForward: boolean }>} */ (data);
      body.append(h('div', { class: 'table-wrap' }, h('table', {},
        h('caption', {}, 'Each scheduled task, source, and compile step, and what the last run found.'),
        h('thead', {}, h('tr', {}, ['Name', 'Kind', 'Status', 'Last Observed', 'Detail'].map((t) => h('th', { scope: 'col' }, t)))),
        h('tbody', {}, items.map((i) => {
          const rec = findSource(i.id);
          return h('tr', {},
            h('td', {}, rec ? rec.title : i.id), h('td', {}, i.kind),
            h('td', {}, statusPill(/** @type {any} */ (i.state))),
            h('td', {}, i.observedAt ? h('time', { datetime: i.observedAt }, formatAsOf(i.observedAt)) : 'Not observed'),
            h('td', {}, `${i.detail}${i.carriedForward ? ' (earlier copy carried forward)' : ''}`));
        })))));
    },
    renderUnavailable: (body, status) => {
      body.append(h('p', { class: 'panel__unavailable' }, status.detail ?? 'The status table is not available.'),
        h('p', {}, 'The dashboard still works. Each panel shows its own status and time stamp.'));
    },
  });
}

/** Page start-up. */
export async function main() {
  initEmbed({ page: 'usage' });
  modulesReady = Promise.all([import('../data/contacts.js'), import('../ui/contact-card.js')]).then(([c, card]) => { C = c; Card = card; });
  const sourcesReady = loadSources().catch(() => { /* the Sources view then says so */ });
  const listLoading = loadSourceList().catch(() => null);

  // Panels mount at once, so each carries its provenance footer from first paint; their loads wait for the
  // lazily loaded modules and the source list.
  const sourcesSlot = document.querySelector('[data-panel="usage-sources"]');
  if (sourcesSlot instanceof HTMLElement) {
    mountPanel(sourcesSlot, {
      title: 'Sources',
      sourceIds: SOURCES_PANEL,
      statusId: 'usage-sources',
      load: async () => {
        await modulesReady;
        const list = await listLoading;
        const now = new Date();
        if (!list) return { data: null, status: C.unavailableStatus(SOURCES_PANEL, 'The source list could not be loaded.', now) };
        const res = await fetchLocal('data/curated/sources.json');
        const at = res.ok ? /** @type {any} */ (res.data)?.generatedAt : null;
        if (typeof at !== 'string') return { data: null, status: C.unavailableStatus(SOURCES_PANEL, 'The source list could not be loaded.', now) };
        return { data: list, status: { state: 'live', asOf: at, asOfBasis: 'issued', sourceIds: [...SOURCES_PANEL], origin: 'snapshot', completeness: 'complete', checkedAt: now.toISOString(), detail: 'Generated from the source registry when the site was built.' } };
      },
      render: (body, data) => renderSources(body, /** @type {SourceRecord[]} */ (data)),
      renderUnavailable: (body, status) => body.append(h('p', { class: 'panel__unavailable' }, status.detail ?? 'The source list is not available.')),
    });
  }

  // The status table is requested when the Status view is first shown, so a page that never opens it never
  // asks for it. The panel still carries its provenance footer, stating why it has no data yet.
  let wantStatus = new URL(location.href).searchParams.get('view') === 'status';
  const statusSlot = document.querySelector('[data-panel="usage-status"]');
  const status = statusSlot instanceof HTMLElement ? mountStatus(statusSlot, () => wantStatus) : null;
  const tabs = document.querySelector('[data-tabs]');
  if (tabs instanceof HTMLElement) {
    initTabs(tabs, {
      onChange: (id) => {
        writeState({ view: id }, { push: true });
        if (id === 'status' && !wantStatus) { wantStatus = true; void status?.refresh(); }
      },
    });
  }

  await sourcesReady;
  initChrome({ page: 'usage' });
  await modulesReady;
  Card.markOutwardLinks(document.querySelector('main') ?? document);
  const legend = document.querySelector('[data-status-legend]');
  if (legend instanceof HTMLElement) renderLegend(legend);
  const list = await listLoading;
  if (list) fillBoundaryAndHosts(list);
}

if (globalThis.document) void main();
