// @ts-check
/** Contact filters preserve mounted controls. Copy and print name active filters. Opt-in location is rounded to three decimals, sent only to NWS, and never stored. */
import { setNationChip } from './chrome.js';
import { mountPanel } from './panel.js';
import { h, telHref } from '../core/dom.js';
import { fetchJson, fetchLocal } from '../core/net.js';
import { onStateChange, readState, writeState } from '../core/url-state.js';
import { formatAsOf } from '../core/time.js';
import { announce } from './live-region.js';
import { showToast } from './toast.js';
import { contactCard, outwardLink } from './contact-card.js';
import { copyList, printWithNote } from './copy-print.js';
import {
  CONTACT_TYPES, JURISDICTIONS, NATIONAL_LINKS, NO_VERIFIED_NOTICE, contactLine, curatedStatus, filterContacts, filterNote,
  loadContactsDoc, loadNationIndex, nationLines, resolveNearMe, roundCoord, unavailableStatus,
} from '../data/contacts.js';

/** @typedef {import('../types.js').Contact} Contact */
/** @typedef {import('../types.js').NationIndexEntry} NationIndexEntry */
/** @typedef {import('../types.js').StatusSnapshot} StatusSnapshot */
/** @typedef {import('../data/contacts.js').NearMe} NearMe */

/** @type {import('../types.js').UrlStateSchema} */
const SCHEMA = Object.freeze({
  view: { type: 'enum', values: ['directory', 'near-me'] },
  q: { type: 'string' },
  jur: { type: 'enum-list', values: JURISDICTIONS.map((j) => j.value) },
  type: { type: 'enum-list', values: CONTACT_TYPES.map((t) => t.value) },
  n: { type: 'nation-id' },
});

/** @param {unknown} v @returns {string[]} */
const strings = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []);

const DIRECTORY_SOURCES = ['cthd-contacts'];
const NEAR_ME_SOURCES = ['nws-points', 'nws-alerts-active', 'cthd-contacts'];
const OFFICIAL = Object.freeze([
  { label: 'National Weather Service', url: 'https://www.weather.gov/' },
  { label: 'Environment and Climate Change Canada Weather Alerts for British Columbia', url: 'https://weather.gc.ca/warnings/index_e.html?prov=bc' },
]);

/** Contacts and the Nation index load once and serve both views. @type {Promise<{ contacts: Awaited<ReturnType<typeof loadContactsDoc>>, index: Awaited<ReturnType<typeof loadNationIndex>> }> | null} */
let shared = null;

/** @returns {NonNullable<typeof shared>} */
function loadShared() {
  shared ??= Promise.all([loadContactsDoc(), loadNationIndex()]).then(([contacts, index]) => ({ contacts, index }));
  return shared;
}

/** @param {HTMLElement} el @param {Contact[]} lines @param {Date} now */
function appendLines(el, lines, now) {
  el.append(h('ul', { class: 'view', role: 'list' }, lines.map((c) => h('li', {}, contactCard(c, { now })))));
}

/**
 * Static 911 card (blueprint 7.4: always first, never from data).
 * @returns {HTMLElement}
 */
function emergencyCard() {
  return h('article', { class: 'contact-card contact-card--emergency', 'data-static-emergency': '' },
    h('h3', { class: 'contact-card__name' }, 'Emergency'),
    h('p', { class: 'contact-card__role' }, 'Police, fire, and emergency medical services in the United States and Canada.'),
    h('a', { class: 'contact-card__phone', href: telHref('911') }, '911'));
}

/**
 * @param {string} label
 * @param {ReadonlyArray<{ value: string, label: string }>} options
 * @param {string[]} selected
 * @param {(values: string[]) => void} onChange
 * @returns {{ el: HTMLElement, set: (values: string[]) => void }}
 */
function chipGroup(label, options, selected, onChange) {
  let current = [...selected];
  /** @type {HTMLButtonElement[]} */
  const buttons = options.map((o) => /** @type {HTMLButtonElement} */ (h('button', { type: 'button', class: 'filter-chip', 'data-value': o.value, 'aria-pressed': String(current.includes(o.value)) }, o.label)));
  /** @param {string[]} values */
  const paint = (values) => { current = values; for (const b of buttons) b.setAttribute('aria-pressed', String(current.includes(b.dataset.value ?? ''))); };
  for (const b of buttons) {
    b.addEventListener('click', () => {
      const v = b.dataset.value ?? '';
      const next = current.includes(v) ? current.filter((x) => x !== v) : [...current, v];
      paint(next);
      onChange(next);
    });
  }
  return {
    el: h('div', {}, h('p', { class: 'caption' }, label), h('div', { class: 'filter-chips', role: 'group', 'aria-label': label }, buttons)),
    set: paint,
  };
}

/**
 * The Directory view body.
 * @param {HTMLElement} body
 * @param {{ contacts: Contact[], index: NationIndexEntry[], offline: boolean }} data
 * @returns {void}
 */
function renderDirectory(body, data) {
  const now = new Date();
  const all = data.contacts;
  /** @type {Map<string, NationIndexEntry>} */
  const nations = new Map(data.index.map((n) => [n.id, n]));
  const initial = readState(SCHEMA);
  let q = typeof initial.q === 'string' ? initial.q : '';
  let jur = strings(initial.jur);
  let type = strings(initial.type);
  let nationId = typeof initial.n === 'string' && nations.has(initial.n) ? initial.n : '';
  let orderKey = '\u0000';

  const search = /** @type {HTMLInputElement} */ (h('input', { class: 'nation-picker__input', type: 'search', id: 'contact-search', name: 'q', autocomplete: 'off', value: q, 'aria-describedby': 'contact-count' }));
  const nationSelect = /** @type {HTMLSelectElement} */ (h('select', { class: 'nation-picker__input', id: 'contact-nation', name: 'n' },
    h('option', { value: '' }, 'All of Cascadia'),
    [...data.index].sort((a, b) => a.name.localeCompare(b.name, 'en')).map((n) => h('option', { value: n.id }, n.name))));
  nationSelect.value = nationId;
  const jurChips = chipGroup('Jurisdiction', JURISDICTIONS, jur, (v) => { jur = v; commit(); });
  const typeChips = chipGroup('Type', CONTACT_TYPES, type, (v) => { type = v; commit(); });
  const count = h('p', { id: 'contact-count', class: 'caption', role: 'status' });
  const note = h('p', { class: 'callout callout--quiet', 'data-filter-note': '' });
  const noLine = h('p', { class: 'callout callout--note', 'data-no-contact-notice': '', hidden: true });
  const list = h('ul', { class: 'view', role: 'list', 'data-contact-list': '' });
  /** @type {Map<string, HTMLElement>} */
  const items = new Map();
  for (const c of all) items.set(c.id, h('li', { 'data-contact-id': c.id }, contactCard(c, { now })));

  const printBtn = h('button', { type: 'button', class: 'btn btn--secondary' }, 'Print or Save as PDF');
  const copyBtn = h('button', { type: 'button', class: 'btn btn--secondary' }, 'Copy List');

  /** @returns {Contact[]} */
  const matched = () => {
    const nation = nationId ? nations.get(nationId) ?? null : null;
    return filterContacts(all, { q, jur, type, nationId: nationId || null }, { nations, nation, now });
  };
  const noteText = () => {
    const shown = matched().length;
    return filterNote({ q, jur, type, nationName: nationId ? nations.get(nationId)?.name ?? null : null, shown, total: all.length });
  };

  function apply() {
    const found = matched();
    const ids = new Set(found.map((c) => c.id));
    const key = nationId;
    if (key !== orderKey) {
      // The order changes only when the Nation changes: nation lines first, then county, state, and federal.
      const order = found.map((c) => items.get(c.id)).filter((el) => el !== undefined);
      const rest = all.filter((c) => !ids.has(c.id)).map((c) => items.get(c.id)).filter((el) => el !== undefined);
      list.replaceChildren(...order, ...rest);
      orderKey = key;
    }
    for (const [id, el] of items) el.hidden = !ids.has(id);
    const text = `${found.length} of ${all.length} lines shown.`;
    count.textContent = text;
    note.textContent = filterNote({ q, jur, type, nationName: nationId ? nations.get(nationId)?.name ?? null : null, shown: found.length, total: all.length });
    if (nationId) {
      const own = nationLines(nationId, all, now);
      noLine.hidden = own.length > 0;
      noLine.textContent = own.length > 0 ? '' : `${NO_VERIFIED_NOTICE} The state or provincial 24/7 line and 911 are below.`;
    } else {
      noLine.hidden = true;
      noLine.textContent = '';
    }
    announce(found.length === 0 ? 'No lines match this filter.' : text);
    setNationChip(nationId ? nations.get(nationId)?.name ?? null : null);
  }

  let writing = false;
  function commit() {
    writing = true;
    try { writeState({ q: q || undefined, jur: jur.length ? jur : undefined, type: type.length ? type : undefined, n: nationId || undefined }); } finally { writing = false; }
    apply();
  }

  search.addEventListener('input', () => { q = search.value; commit(); });
  nationSelect.addEventListener('change', () => { nationId = nationSelect.value; commit(); });
  printBtn.addEventListener('click', () => printWithNote(noteText()));
  copyBtn.addEventListener('click', () => {
    const lines = matched().map(contactLine);
    void copyList(lines, noteText()).then((copied) => { if (copied) showToast('List copied'); });
  });
  onStateChange(() => {
    // Back and forward restore the filters. A write made here is ignored: the URL trims what was typed, and
    // restoring it would delete a space the person has just typed.
    if (writing) return;
    const next = readState(SCHEMA);
    const nq = typeof next.q === 'string' ? next.q : '';
    const nn = typeof next.n === 'string' && nations.has(next.n) ? next.n : '';
    const nj = strings(next.jur);
    const nt = strings(next.type);
    if (nq === q && nn === nationId && nj.join() === jur.join() && nt.join() === type.join()) return;
    q = nq; nationId = nn; jur = nj; type = nt;
    search.value = q; nationSelect.value = nationId; jurChips.set(jur); typeChips.set(type);
    apply();
  });

  body.append(
    h('div', { class: 'view' },
      emergencyCard(),
      h('div', { class: 'view' },
        h('div', {}, h('label', { for: 'contact-search', class: 'nation-picker__label' }, 'Search Contacts'), search),
        data.index.length > 0
          ? h('div', {}, h('label', { for: 'contact-nation', class: 'nation-picker__label' }, 'Nation'), nationSelect)
          : h('p', { class: 'panel-note' }, 'The Nation list could not be loaded, so the Nation filter is unavailable.'),
        jurChips.el, typeChips.el),
      count, note,
      h('div', { class: 'filter-chips' }, printBtn, copyBtn),
      h('div', { 'data-copy-fallback': '' }),
      noLine, list),
  );
  apply();
}

/**
 * @param {HTMLElement} body
 * @param {StatusSnapshot} status
 * @param {string} what
 */
function renderUnavailable(body, status, what) {
  void status;
  body.append(
    h('p', { class: 'panel__unavailable' }, `${what} could not be loaded right now. Nothing is shown in its place.`),
    h('p', {}, h('a', { class: 'btn btn--secondary', href: telHref('911') }, 'Call Emergency Services')),
    h('p', {}, 'Official alerts: ', OFFICIAL.flatMap((o, i) => [i ? ' and ' : '', outwardLink(o.url, o.label)]), '.'));
}

/**
 * @param {HTMLElement} slot
 * @returns {import('../types.js').PanelHandle}
 */
export function mountDirectory(slot) {
  return mountPanel(slot, {
    title: 'Emergency Contacts',
    sourceIds: DIRECTORY_SOURCES,
    statusId: 'contacts-directory',
    load: async () => {
      const now = new Date();
      const { contacts, index } = await loadShared();
      if (!contacts.ok) return { data: null, status: unavailableStatus(DIRECTORY_SOURCES, 'The contacts file could not be loaded.', now) };
      const status = curatedStatus(contacts, now, DIRECTORY_SOURCES);
      return { data: { contacts: contacts.doc.items, index: index.ok ? index.data.nations : [], offline: contacts.origin === 'cache' }, status };
    },
    render: (body, data) => {
      const d = /** @type {{ contacts: Contact[], index: NationIndexEntry[], offline: boolean }} */ (data);
      if (d.offline) body.append(h('p', { class: 'callout callout--quiet', 'data-offline-notice': '' }, 'Saved for offline use; contacts verified as listed.'));
      renderDirectory(body, d);
    },
    renderUnavailable: (body, status) => renderUnavailable(body, status, 'The contact directory'),
  });
}

// ---------------------------------------------------------------------------------------------
// Near Me
// ---------------------------------------------------------------------------------------------

/** @param {number} km @returns {string} */
function distance(km) {
  const mi = km * 0.621371;
  return `${Math.round(mi)} mi (${Math.round(km)} km)`;
}

/**
 * @param {import('../types.js').DashboardAlert} a
 * @returns {HTMLElement}
 */
function alertRow(a) {
  const text = a.sourceLanguage['en-US'] ?? a.sourceLanguage.en ?? Object.values(a.sourceLanguage)[0];
  return h('li', { class: 'alert-card', 'data-band': a.band },
    h('div', { class: 'alert-card__labels' },
      h('span', { class: `band-chip band-chip--${a.band}` }, a.band === 'unstated' ? 'Severity Not Stated' : a.band[0]?.toUpperCase() + a.band.slice(1)),
      h('span', { class: `designation-badge designation-badge--${a.designation}` }, a.designation[0]?.toUpperCase() + a.designation.slice(1))),
    h('h4', { class: 'alert-card__title' }, a.event),
    h('p', { class: 'alert-card__meta' }, `Issued by ${a.senderName}. `, a.expires ? ['Expires ', h('time', { datetime: a.expires }, formatAsOf(a.expires))] : 'No expiry time was published.'),
    text?.headline ? h('p', { class: 'alert-card__body' }, text.headline) : null,
    text?.instruction ? h('p', { class: 'alert-card__body' }, text.instruction) : null,
    a.webUrl ? h('p', { class: 'alert-card__body' }, outwardLink(a.webUrl, 'Full alert from the issuing office')) : null);
}

/**
 * @param {HTMLElement} body
 * @param {NearMe} r
 * @param {Date} now
 */
function renderNearMe(body, r, now) {
  body.append(h('p', { class: 'callout callout--sovereignty' }, h('strong', {}, 'Representation, not jurisdiction.'),
    ' Distances use each Nation’s headquarters point, not its boundary or lands.'));
  if (r.outside) {
    body.append(
      h('p', { class: 'callout callout--note', 'data-outside-footprint': '' }, 'This location is outside the area this dashboard covers.'),
      h('p', {}, 'Use the official national sources instead:'),
      h('ul', {}, NATIONAL_LINKS.map((l) => h('li', {}, outwardLink(l.url, l.label)))));
    return;
  }
  for (const p of r.problems) body.append(h('p', { class: 'panel-note' }, p));

  body.append(h('h3', {}, 'Nearest Nations'));
  if (r.nearest.length === 0) body.append(h('p', {}, 'No Nations could be listed for this location.'));
  for (const n of r.nearest) {
    body.append(h('section', { class: 'view', 'data-nearest-nation': n.nation.id },
      h('h4', {}, n.nation.name),
      h('p', { class: 'caption' }, `${distance(n.distanceKm)} from the headquarters point`),
      n.lines.length > 0 ? null : h('p', { class: 'callout callout--note' }, NO_VERIFIED_NOTICE),
      n.lines.length > 0 ? h('ul', { class: 'view', role: 'list' }, n.lines.map((c) => h('li', {}, contactCard(c, { now })))) : null));
  }

  if (r.emcr) {
    body.append(h('h3', {}, 'Provincial Emergency Region'),
      h('p', { 'data-emcr-region': r.emcr.name }, `This location is in the ${r.emcr.name} emergency management region. Region offices are listed with the provincial lines below.`));
  } else if (r.region === 'bc') {
    body.append(h('h3', {}, 'Provincial Emergency Region'), h('p', {}, 'The emergency management region for this location could not be determined.'));
  }
  if (r.region !== 'bc') {
    body.append(h('h3', {}, 'County Emergency Management'));
    if (r.town) body.append(h('p', { class: 'caption' }, `Nearest place named by the National Weather Service: ${r.town}.`));
    if (r.county && r.county.lines.length > 0) appendLines(body, r.county.lines, now);
    else body.append(h('p', { class: 'callout callout--note', 'data-county-note': '' }, r.countyNote ?? 'No county line is available.'));
  }
  body.append(h('h3', {}, r.region === 'bc' ? 'Provincial and First Nations Emergency Lines' : 'State Emergency Lines'));
  if (r.stateLines.length > 0) appendLines(body, r.stateLines, now);
  else body.append(h('p', {}, 'No verified state or provincial emergency line is on file for this location.'));

  body.append(h('h3', {}, 'Alerts at This Location'));
  const a = r.alerts;
  if (!a || !a.ok) {
    body.append(h('p', { class: 'callout callout--note', 'data-alerts-unavailable': '' }, a?.note ?? 'Alerts could not be checked for this location.'),
      h('p', {}, 'Official alerts: ', OFFICIAL.flatMap((o, i) => [i ? ' and ' : '', outwardLink(o.url, o.label)]), '.'));
  } else {
    if (a.note) body.append(h('p', { class: 'callout callout--note' }, a.note));
    if (a.items.length === 0) {
      body.append(h('p', { 'data-no-alerts': '' }, 'No active alerts were returned for this location',
        a.asOf ? [' as of ', h('time', { datetime: a.asOf }, formatAsOf(a.asOf))] : '', '. This is not an all-clear. Check the official sources for the latest.'));
    } else {
      body.append(h('ul', { class: 'view', role: 'list', 'data-point-alerts': '' }, a.items.map(alertRow)));
    }
  }

  if (r.forecastUrl) {
    body.append(h('h3', {}, 'Forecast'),
      h('p', {}, outwardLink(r.forecastUrl, r.region === 'bc' ? 'Environment and Climate Change Canada forecast for this location' : 'National Weather Service forecast for this location')));
  }
  body.append(h('p', { class: 'caption' }, 'Your location was used once, rounded to about one hundred ten meters. It was sent only to api.weather.gov, and it is not stored.'));
}

/**
 * @param {HTMLElement} slot
 * @returns {import('../types.js').PanelHandle}
 */
export function mountNearMe(slot) {
  /** @type {{ lat: number, lon: number } | null} */
  let place = null;
  /** @type {string | null} */
  let problem = null;
  let locating = false;
  /** @type {PanelHandleRef} */
  const ref = { handle: null };

  function locate() {
    if (!('geolocation' in navigator)) {
      problem = 'This browser does not offer location. Choose a Nation in the Directory instead.';
      void ref.handle?.refresh();
      return;
    }
    locating = true;
    announce('Finding your location');
    navigator.geolocation.getCurrentPosition((pos) => {
      locating = false;
      place = { lat: roundCoord(pos.coords.latitude), lon: roundCoord(pos.coords.longitude) };
      problem = null;
      void ref.handle?.refresh();
    }, (err) => {
      locating = false;
      place = null;
      problem = err.code === 1
        ? 'Location permission was not granted. Choose a Nation in the Directory instead.'
        : err.code === 3 ? 'Finding your location took too long. Try again, or choose a Nation in the Directory.'
          : 'Your location is not available right now. Choose a Nation in the Directory instead.';
      showToast('Location unavailable');
      void ref.handle?.refresh();
    }, { enableHighAccuracy: false, timeout: 20_000, maximumAge: 0 });
  }

  /** @param {HTMLElement} body */
  function showPrompt(body) {
    body.append(
      h('p', {}, 'Near Me finds the nearest Nations and the emergency lines, alerts, and forecast link for the place you are. Your browser will ask for permission first.'),
      problem ? h('p', { class: 'callout callout--note', 'data-location-problem': '' }, problem) : '',
      h('p', {}, h('button', { type: 'button', class: 'btn btn--secondary', 'data-action': 'locate', disabled: locating }, locating ? 'Finding Your Location' : 'Use My Location')),
      h('p', { class: 'caption' }, 'Your location is rounded to about one hundred ten meters before any request. It is sent only to api.weather.gov, and it is not stored.'),
      h('p', {}, 'Official alerts: ', OFFICIAL.flatMap((o, i) => [i ? ' and ' : '', outwardLink(o.url, o.label)]), '.'));
    const button = body.querySelector('[data-action="locate"]');
    button?.addEventListener('click', () => {
      if (button instanceof HTMLButtonElement) { button.disabled = true; button.textContent = 'Finding Your Location'; }
      locate();
    });
  }

  const handle = mountPanel(slot, {
    title: 'Near Me',
    sourceIds: NEAR_ME_SOURCES,
    statusId: 'contacts-near-me',
    load: async (signal) => {
      const now = new Date();
      if (!place) return { data: null, status: unavailableStatus(NEAR_ME_SOURCES, problem ?? 'No location has been shared yet.', now) };
      const { contacts, index } = await loadShared();
      if (!contacts.ok) return { data: null, status: unavailableStatus(NEAR_ME_SOURCES, 'The contacts file could not be loaded.', now) };
      const [fp, bc] = await Promise.all([fetchLocal('data/geo/footprint.json', { signal }), fetchLocal('data/geo/bc-regions.json', { signal })]);
      const result = await resolveNearMe({
        lat: place.lat, lon: place.lon, now, contacts: contacts.doc.items, nations: index.ok ? index.data.nations : [],
        footprint: fp.ok ? /** @type {any} */ (fp.data) : null, bcRegions: bc.ok ? /** @type {any} */ (bc.data) : null,
        fetchJson, signal,
        loadBcSnapshot: async () => {
          const svc = await import('../alerts/service.js');
          const res = await svc.loadAllAlerts({ scope: { kind: 'footprint', jurisdictions: ['BC'] }, registry: { index: null }, page: 'contacts', direct: false, signal });
          const geometry = await svc.loadAlertGeometry({ signal });
          const st = res.statuses.get('eccc-geomet-weather-alerts');
          return { alerts: res.alerts, geometry, asOf: st?.asOf ?? null };
        },
      });
      const degraded = result.problems.length > 0 || (result.alerts !== null && (!result.alerts.ok || result.alerts.partial));
      /** @type {StatusSnapshot} */
      const status = {
        state: degraded ? 'degraded' : 'live', asOf: result.checkedAt, asOfBasis: 'retrieved',
        detail: degraded ? 'Part of this answer could not be checked; the notes below say which.' : 'Contacts are the compiled list; alerts were requested just now.',
        sourceIds: [...NEAR_ME_SOURCES], origin: 'direct', completeness: degraded ? 'partial' : 'complete', checkedAt: now.toISOString(),
      };
      return { data: result, status };
    },
    render: (body, data) => renderNearMe(body, /** @type {NearMe} */ (data), new Date()),
    renderUnavailable: (body) => showPrompt(body),
  });
  ref.handle = handle;
  return handle;
}

/** @typedef {{ handle: import('../types.js').PanelHandle | null }} PanelHandleRef */

export { markOutwardLinks } from './contact-card.js';
