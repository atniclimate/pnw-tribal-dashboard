// @ts-check
/**
 * Entry module for the safety page (blueprint 7.6). Loaded by <script type="module">; its static imports are
 * listed in the page's modulepreload block (check:preload).
 *
 * The guidance is static HTML so it loads fast and works offline. This module adds: "Active Now" highlights
 * for the selected Nation's alerts (matched through each section's data-hazards), `?hz=` scroll and
 * highlight, "Call" lines rendered from the compiled contacts and resources (never hard-coded, except the
 * static 911), and a kit checklist whose checks are saved on this device only.
 */
import { initChrome, pageSourceIds, setNationChip } from '../ui/chrome.js';
import { initEmbed } from '../core/embed.js';
import { mountPanel } from '../ui/panel.js';
import { h, telHref } from '../core/dom.js';
import { fetchLocal } from '../core/net.js';
import { findSource, loadSources } from '../core/sources.js';
import { readState, setIdRedirects } from '../core/url-state.js';
import { getItem, setItem } from '../core/storage.js';
import { formatAsOf } from '../core/time.js';

// The contacts and resources modules load lazily (started at the top of main, before anything waits), so the
// static graph of this entry fits budgets.json jsStaticGraph. Every use below runs after main has them.
/** @type {typeof import('../data/contacts.js')} */
let C;
/** @type {typeof import('../data/resources.js')} */
let R;
/** @type {typeof import('../ui/contact-card.js')} */
let Card;

/** @typedef {import('../types.js').StatusSnapshot} StatusSnapshot */
/** @typedef {import('../types.js').NationRecord} NationRecord */
/** @typedef {import('../types.js').DashboardAlert} DashboardAlert */

const ACTIVE_SOURCES = ['nws-alerts-active', 'eccc-geomet-weather-alerts'];
const CALL_SOURCES = ['cthd-contacts', 'cthd-resources'];
const KIT_KEY = 'safety-kit';
const NWS = 'nws-alerts-active';
const ECCC = 'eccc-geomet-weather-alerts';
const BAD = ['live', 'cached', 'stale', 'degraded', 'unavailable'];

/** @type {import('../types.js').UrlStateSchema} */
const SCHEMA = Object.freeze({ n: { type: 'nation-id' }, hz: { type: 'string' } });

/**
 * The section id for a hazard category or anchor name: a section whose data-hazards lists it, or whose id equals it,
 * or that carries an alias anchor with that id.
 * @param {ParentNode} root
 * @param {string} key
 * @returns {HTMLElement | null}
 */
export function sectionFor(root, key) {
  if (!/^[a-z-]{1,24}$/.test(key)) return null;
  for (const s of root.querySelectorAll('.safety-section')) {
    const tokens = (s.getAttribute('data-hazards') ?? '').split(/\s+/);
    if (s.id === key || tokens.includes(key) || s.querySelector(`:scope > span[id="${key}"]`)) return /** @type {HTMLElement} */ (s);
  }
  return null;
}

/**
 * One status for the panel from the per-source statuses of the sources that matter: the worst state, the
 * oldest "as of".
 * @param {StatusSnapshot[]} list
 * @param {string[]} sourceIds
 * @param {Date} now
 * @returns {StatusSnapshot}
 */
export function combineStatuses(list, sourceIds, now) {
  const worst = [...list].sort((a, b) => BAD.indexOf(b.state) - BAD.indexOf(a.state))[0];
  if (!worst) return C.unavailableStatus(sourceIds, 'No alert status is available.', now);
  const stamps = list.map((s) => s.asOf).filter((s) => s !== null).sort();
  return { ...worst, sourceIds: [...sourceIds], asOf: stamps[0] ?? null, asOfBasis: stamps[0] ? worst.asOfBasis : null, checkedAt: now.toISOString() };
}

/**
 * @param {Document} doc
 * @param {DashboardAlert[]} alerts
 * @returns {Array<{ alert: DashboardAlert, section: HTMLElement | null }>}
 */
function matchAlerts(doc, alerts) {
  return alerts.map((alert) => {
    for (const c of alert.categories) {
      const section = sectionFor(doc, c);
      if (section) return { alert, section };
    }
    return { alert, section: null };
  });
}

/** @param {string | null} id @returns {Promise<NationRecord | null>} */
async function loadNationRecord(id) {
  if (!id) return null;
  const res = await fetchLocal(`data/registry/nations/${id}.json`);
  return res.ok ? /** @type {NationRecord} */ (res.data) : null;
}

/**
 * @param {HTMLElement} slot
 * @param {string | null} nationId
 * @returns {void}
 */
function mountActive(slot, nationId) {
  /** @type {Array<{ alert: DashboardAlert, section: HTMLElement | null }>} */
  let found = [];
  mountPanel(slot, {
    title: 'Active Now',
    sourceIds: ACTIVE_SOURCES,
    statusId: 'safety-active',
    load: async (signal) => {
      const now = new Date();
      if (!nationId) return { data: null, status: C.unavailableStatus(ACTIVE_SOURCES, 'No Nation is selected.', now) };
      const nation = await loadNationRecord(nationId);
      if (!nation) return { data: null, status: C.unavailableStatus(ACTIVE_SOURCES, 'The selected Nation could not be loaded.', now) };
      const svc = await import('../alerts/service.js');
      const res = await svc.loadAllAlerts({ scope: { kind: 'nation', nation }, registry: { index: null }, page: 'safety', signal });
      const ids = nation.country === 'CA' ? [ECCC] : [NWS];
      const status = combineStatuses(ids.map((i) => res.statuses.get(i)).filter((s) => s !== undefined), ACTIVE_SOURCES, now);
      return { data: { nation, alerts: res.alerts }, status };
    },
    render: (body, data, status) => {
      const d = /** @type {{ nation: NationRecord, alerts: DashboardAlert[] }} */ (data);
      found = matchAlerts(document, d.alerts);
      for (const s of document.querySelectorAll('.safety-section')) {
        const label = s.querySelector('[data-active-now]');
        if (label instanceof HTMLElement) { label.hidden = true; label.textContent = ''; }
      }
      for (const { alert, section } of found) {
        const label = section?.querySelector('[data-active-now]');
        if (label instanceof HTMLElement) {
          label.hidden = false;
          label.textContent = `${label.textContent ? `${label.textContent}; ` : 'Active Now: '}${alert.event}`;
        }
      }
      body.append(h('p', {}, `Alerts for ${d.nation.name}.`));
      if (d.alerts.length === 0) {
        body.append(h('p', { 'data-no-alerts': '' }, 'No active alerts were returned for this Nation',
          status.asOf ? [' as of ', h('time', { datetime: status.asOf }, formatAsOf(status.asOf))] : '', '. This is not an all-clear. Check the official sources for the latest.'));
      } else {
        body.append(h('ul', { 'data-active-list': '' }, found.map(({ alert, section }) => h('li', {},
          section ? h('a', { href: `#${section.id}` }, `Active Now: ${alert.event}`) : `Active Now: ${alert.event}`,
          alert.expires ? [' (expires ', h('time', { datetime: alert.expires }, formatAsOf(alert.expires)), ')'] : ''))));
      }
    },
    renderUnavailable: (body, status) => {
      body.append(
        h('p', { class: 'panel__unavailable' }, nationId
          ? 'Active alerts could not be loaded for the selected Nation right now. Nothing is shown in its place.'
          : 'Choose a Nation to highlight the sections that match its active alerts.'),
        nationId ? '' : h('p', {}, h('a', { href: '../#choose-nation' }, 'Choose a Nation')),
        h('p', {}, 'Official alerts: ', h('a', { href: 'https://www.weather.gov/' }, 'National Weather Service'), ' and ',
          h('a', { href: 'https://weather.gc.ca/warnings/index_e.html?prov=bc' }, 'Environment and Climate Change Canada'), '.'));
      void status;
    },
  });
}

/**
 * @param {HTMLElement} slot
 * @param {string[]} codes directory codes of the selected Nation, or empty
 * @param {{ contacts: Awaited<ReturnType<typeof import('../data/contacts.js').loadContactsDoc>>, resources: Awaited<ReturnType<typeof import('../data/resources.js').loadResourcesDoc>> }} loaded
 */
function mountCall(slot, codes, loaded) {
  mountPanel(slot, {
    title: 'Who to Call',
    sourceIds: CALL_SOURCES,
    statusId: 'safety-call',
    load: async () => {
      const now = new Date();
      if (!loaded.contacts.ok) return { data: null, status: C.unavailableStatus(CALL_SOURCES, 'The contacts file could not be loaded.', now) };
      const base = C.curatedStatus(loaded.contacts, now, CALL_SOURCES);
      const status = loaded.resources.ok ? base : { ...base, state: /** @type {'degraded'} */ ('degraded'), completeness: /** @type {'partial'} */ ('partial'), detail: 'The resources file could not be loaded, so Red Cross and helpline numbers are missing.' };
      return { data: loaded.contacts.doc.items, status };
    },
    render: (body, data) => {
      const contacts = /** @type {import('../types.js').Contact[]} */ (data);
      const now = new Date();
      body.append(h('article', { class: 'contact-card contact-card--emergency' }, h('h3', { class: 'contact-card__name' }, 'Emergency'),
        h('a', { class: 'contact-card__phone', href: telHref('911') }, '911')));
      const list = codes.length ? codes : ['WA', 'OR', 'ID', 'CA', 'MT', 'NV', 'AK', 'BC'];
      const lines = list.flatMap((c) => C.stateLines(c, contacts, now).filter((x) => x.lineType === '24-7'));
      body.append(h('ul', { class: 'view', role: 'list' }, lines.map((c) => h('li', {}, Card.contactCard(c, { now })))));
      if (lines.length === 0) body.append(h('p', {}, 'No verified state or provincial 24/7 line is on file for this selection.'));
      body.append(h('p', {}, h('a', { href: '../contacts/' }, 'All contacts and the Nation directory')));
    },
    renderUnavailable: (body) => {
      body.append(h('p', { class: 'panel__unavailable' }, 'Phone numbers could not be loaded right now. Nothing is shown in their place.'),
        h('p', {}, h('a', { class: 'btn btn--secondary', href: telHref('911') }, 'Call Emergency Services')));
    },
  });
}

/**
 * @param {Array<{ label: string, display: string, e164: string }>} entries
 */
function fillCallLines(entries) {
  for (const p of document.querySelectorAll('[data-call]')) {
    p.replaceChildren('Call ', h('a', { href: telHref('911') }, '911'), ' in an emergency.',
      ...entries.flatMap((e) => ['; ', `${e.label} `, h('a', { href: telHref(e.e164) }, e.display)]), '.');
  }
}

/** The kit checklist: real checkboxes, saved per viewer on this device only. */
function initKit() {
  /** @type {string[]} */
  let saved = [];
  try { const v = JSON.parse(getItem(KIT_KEY) ?? '[]'); if (Array.isArray(v)) saved = v.filter((x) => typeof x === 'string'); } catch { /* unreadable saved list */ }
  const boxes = [...document.querySelectorAll('input[data-kit]')].filter((b) => b instanceof HTMLInputElement);
  for (const b of boxes) {
    b.checked = saved.includes(b.dataset.kit ?? '');
    b.addEventListener('change', () => setItem(KIT_KEY, JSON.stringify(boxes.filter((x) => x.checked).map((x) => x.dataset.kit))));
  }
  document.querySelector('[data-action="print-kit"]')?.addEventListener('click', () => globalThis.print());
}

/**
 * `?hz=` scrolls to and marks a section (a hazard category or a section name).
 * @param {string | null} key
 */
function focusHazard(key) {
  const s = key ? sectionFor(document, key) : null;
  if (!s) return;
  const heading = s.querySelector('h2');
  if (heading instanceof HTMLElement) {
    heading.tabIndex = -1;
    const reduce = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    s.scrollIntoView({ block: 'start', behavior: reduce ? 'auto' : 'smooth' });
    heading.focus({ preventScroll: true });
  }
  s.setAttribute('data-linked', 'true');
}

/** Page start-up. */
export async function main() {
  initEmbed({ page: 'safety' });
  const modulesLoading = Promise.all([import('../data/contacts.js'), import('../data/resources.js'), import('../ui/contact-card.js')]);
  /** @type {Record<string, string>} */
  const names = {};
  try {
    await loadSources();
    for (const id of pageSourceIds(document)) { const r = findSource(id); if (r) names[id] = r.attribution || r.owner; }
  } catch { /* each panel says what failed */ }
  initChrome({ page: 'safety', sources: names });
  initKit();
  [C, R, Card] = await modulesLoading;
  Card.markOutwardLinks(document.querySelector('main') ?? document);

  try {
    const redirects = await fetchLocal('data/registry/id-redirects.json');
    if (redirects.ok) setIdRedirects(/** @type {any} */ (redirects.data));
  } catch { /* an absent redirect table means no redirects */ }
  const state = readState(SCHEMA);
  const nationId = typeof state.n === 'string' ? state.n : null;
  const hz = typeof state.hz === 'string' ? state.hz : null;

  const [contacts, resources, index] = await Promise.all([C.loadContactsDoc(), R.loadResourcesDoc(), nationId ? C.loadNationIndex() : Promise.resolve(null)]);
  const entry = nationId && index && index.ok ? index.data.nations.find((n) => n.id === nationId) ?? null : null;
  const codes = entry ? C.nationJurisdictionCodes({ id: entry.id, jurisdictions: entry.jurisdictions }) : [];
  if (entry) setNationChip(entry.name);

  if (contacts.ok) {
    fillCallLines(C.callEntries({ contacts: contacts.doc.items, resources: resources.ok ? resources.doc.items : [], codes, now: new Date() }));
  }
  const active = document.querySelector('[data-panel="safety-active"]');
  const call = document.querySelector('[data-panel="safety-call"]');
  if (call instanceof HTMLElement) mountCall(call, codes, { contacts, resources });
  if (active instanceof HTMLElement) mountActive(active, nationId);
  focusHazard(hz);
}

if (globalThis.document) void main();
