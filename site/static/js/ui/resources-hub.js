// @ts-check
/**
 * Resources hub (blueprint 7.5), imported by pages/resources.js. Moved out of the entry module by the Wave 2
 * finisher so the entry's static import graph fits budgets.json jsStaticGraph; the code is lane L13's, unchanged.
 *
 * A filterable hub of official links: jurisdiction (including British Columbia), category, hazard, Nation,
 * and search. Evergreen items come first and seasonal items show only in season. Filters toggle `hidden` on
 * cards that already exist, so no control is rebuilt under the person typing. Print and Copy List both
 * state the active filter. Event-specific items never appear here; they live in the Event Archive.
 */
import { setNationChip } from './chrome.js';
import { mountPanel } from './panel.js';
import { h, telHref } from '../core/dom.js';
import { onStateChange, readState, writeState } from '../core/url-state.js';
import { announce } from './live-region.js';
import { showToast } from './toast.js';
import { copyList, printWithNote } from './copy-print.js';
import { outwardLink } from './contact-card.js';
import { curatedStatus, formatDay, loadNationIndex, nationJurisdictionCodes, unavailableStatus } from '../data/contacts.js';
import {
  CATEGORY_LABELS, HAZARD_LABELS, RESOURCE_REGIONS, filterResources, loadResourcesDoc, resourceFilterNote, resourceLine,
} from '../data/resources.js';

/** @typedef {import('../types.js').Resource} Resource */
/** @typedef {import('../types.js').NationIndexEntry} NationIndexEntry */

const SOURCES = ['cthd-resources'];

/** @type {import('../types.js').UrlStateSchema} */
const SCHEMA = Object.freeze({
  q: { type: 'string' },
  jur: { type: 'enum-list', values: RESOURCE_REGIONS.map((r) => r.value) },
  cat: { type: 'enum-list', values: Object.keys(CATEGORY_LABELS) },
  hz: { type: 'enum-list', values: Object.keys(HAZARD_LABELS) },
  n: { type: 'nation-id' },
});

/** @param {unknown} v @returns {string[]} */
const strings = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []);

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
 * @param {Resource} r
 * @returns {HTMLElement}
 */
function resourceCard(r) {
  const phone = r.phone ? telHref(r.phone) : '';
  const season = r.status === 'seasonal' && r.validFrom && r.validUntil
    ? h('p', { class: 'caption' }, `Seasonal: ${formatDay(r.validFrom)} to ${formatDay(r.validUntil)}.`) : '';
  return h('article', { class: 'contact-card', 'data-resource-id': r.id },
    h('h4', { class: 'contact-card__name' }, outwardLink(r.url, r.title)),
    h('p', { class: 'contact-card__role' }, r.publisher),
    h('p', {}, r.description),
    phone ? h('a', { class: 'contact-card__phone', href: phone }, r.phone) : '',
    season,
    h('p', { class: 'contact-card__verified' }, `Verified ${formatDay(r.verifiedAt)}. Source: `, outwardLink(r.sourceUrl, r.publisher), '.'));
}

/**
 * @param {HTMLElement} body
 * @param {{ items: Resource[], index: NationIndexEntry[] }} data
 */
function renderHub(body, data) {
  const now = new Date();
  const all = filterResources(data.items, {}, now);
  /** @type {Map<string, NationIndexEntry>} */
  const nations = new Map(data.index.map((n) => [n.id, n]));
  const initial = readState(SCHEMA);
  let q = typeof initial.q === 'string' ? initial.q : '';
  let jur = strings(initial.jur);
  let cat = strings(initial.cat);
  let hz = strings(initial.hz);
  let nationId = typeof initial.n === 'string' && nations.has(initial.n) ? initial.n : '';

  const categories = Object.keys(CATEGORY_LABELS).filter((c) => all.some((r) => r.category === c));
  const hazards = Object.keys(HAZARD_LABELS).filter((x) => all.some((r) => r.hazards.includes(/** @type {any} */ (x))));

  const search = /** @type {HTMLInputElement} */ (h('input', { class: 'nation-picker__input', type: 'search', id: 'resource-search', name: 'q', autocomplete: 'off', value: q, 'aria-describedby': 'resource-count' }));
  const nationSelect = /** @type {HTMLSelectElement} */ (h('select', { class: 'nation-picker__input', id: 'resource-nation', name: 'n' },
    h('option', { value: '' }, 'All of Cascadia'),
    [...data.index].sort((a, b) => a.name.localeCompare(b.name, 'en')).map((n) => h('option', { value: n.id }, n.name))));
  nationSelect.value = nationId;
  const jurChips = chipGroup('Jurisdiction', RESOURCE_REGIONS, jur, (v) => { jur = v; commit(); });
  const catChips = chipGroup('Category', categories.map((value) => ({ value, label: CATEGORY_LABELS[value] ?? value })), cat, (v) => { cat = v; commit(); });
  const hzChips = chipGroup('Hazard', hazards.map((value) => ({ value, label: HAZARD_LABELS[value] ?? value })), hz, (v) => { hz = v; commit(); });
  const count = h('p', { id: 'resource-count', class: 'caption', role: 'status' });
  const note = h('p', { class: 'callout callout--quiet', 'data-filter-note': '' });
  const empty = h('p', { class: 'callout callout--note', 'data-no-matches': '', hidden: true });
  const printBtn = h('button', { type: 'button', class: 'btn btn--secondary' }, 'Print or Save as PDF');
  const copyBtn = h('button', { type: 'button', class: 'btn btn--secondary' }, 'Copy List');

  /** @type {Map<string, HTMLElement>} */
  const cards = new Map(all.map((r) => [r.id, h('li', { 'data-resource-id': r.id }, resourceCard(r))]));
  /** @type {Map<string, { section: HTMLElement, ids: string[] }>} */
  const groups = new Map();
  const groupEls = categories.map((c) => {
    const ids = all.filter((r) => r.category === c).map((r) => r.id);
    const list = h('ul', { class: 'view', role: 'list' }, ids.map((id) => cards.get(id)));
    const section = h('section', { 'aria-labelledby': `resource-group-${c}`, 'data-category': c }, h('h3', { id: `resource-group-${c}` }, CATEGORY_LABELS[c] ?? c), list);
    groups.set(c, { section, ids });
    return section;
  });

  const nationRegions = () => (nationId ? nationJurisdictionCodes({ id: nationId, jurisdictions: nations.get(nationId)?.jurisdictions ?? [] }) : []);
  /** @returns {Resource[]} */
  const matched = () => filterResources(all, { q, region: jur, category: cat, hazard: hz, nationId: nationId || null, nationRegions: nationRegions() }, now);
  const noteFor = (/** @type {number} */ shown) => resourceFilterNote({ q, region: jur, category: cat, hazard: hz, nationName: nationId ? nations.get(nationId)?.name ?? null : null, shown, total: all.length });

  function apply() {
    const found = matched();
    const ids = new Set(found.map((r) => r.id));
    for (const [id, el] of cards) el.hidden = !ids.has(id);
    for (const g of groups.values()) g.section.hidden = !g.ids.some((id) => ids.has(id));
    const text = `${found.length} of ${all.length} resources shown.`;
    count.textContent = text;
    note.textContent = noteFor(found.length);
    const bc = jur.includes('BC') && jur.length === 1;
    empty.hidden = found.length > 0;
    empty.textContent = found.length > 0 ? '' : bc
      ? 'No British Columbia resources are on file yet. Official sources are listed on the Contacts page.'
      : 'No resources match this filter.';
    announce(found.length === 0 ? 'No resources match this filter.' : text);
    setNationChip(nationId ? nations.get(nationId)?.name ?? null : null);
  }
  let writing = false;
  function commit() {
    writing = true;
    try { writeState({ q: q || undefined, jur: jur.length ? jur : undefined, cat: cat.length ? cat : undefined, hz: hz.length ? hz : undefined, n: nationId || undefined }); } finally { writing = false; }
    apply();
  }
  search.addEventListener('input', () => { q = search.value; commit(); });
  nationSelect.addEventListener('change', () => { nationId = nationSelect.value; commit(); });
  printBtn.addEventListener('click', () => printWithNote(noteFor(matched().length)));
  copyBtn.addEventListener('click', () => {
    const found = matched();
    void copyList(found.map(resourceLine), noteFor(found.length)).then((copied) => { if (copied) showToast('List copied'); });
  });
  onStateChange(() => {
    if (writing) return; // a write made here; restoring the trimmed URL would delete a typed space
    const next = readState(SCHEMA);
    const nq = typeof next.q === 'string' ? next.q : '';
    const nn = typeof next.n === 'string' && nations.has(next.n) ? next.n : '';
    const nj = strings(next.jur);
    const nc = strings(next.cat);
    const nh = strings(next.hz);
    if (nq === q && nn === nationId && nj.join() === jur.join() && nc.join() === cat.join() && nh.join() === hz.join()) return;
    q = nq; nationId = nn; jur = nj; cat = nc; hz = nh;
    search.value = q; nationSelect.value = nationId; jurChips.set(jur); catChips.set(cat); hzChips.set(hz);
    apply();
  });

  body.append(h('div', { class: 'view' },
    h('div', { class: 'view' },
      h('div', {}, h('label', { for: 'resource-search', class: 'nation-picker__label' }, 'Search Resources'), search),
      data.index.length > 0
        ? h('div', {}, h('label', { for: 'resource-nation', class: 'nation-picker__label' }, 'Nation'), nationSelect)
        : h('p', { class: 'panel-note' }, 'The Nation list could not be loaded, so the Nation filter is unavailable.'),
      jurChips.el, catChips.el, hzChips.el),
    count, note,
    h('div', { class: 'filter-chips' }, printBtn, copyBtn),
    h('div', { 'data-copy-fallback': '' }),
    empty,
    ...groupEls));
  apply();
}

/**
 * Mounts the resources panel.
 * @param {HTMLElement} slot
 */
export function mountResources(slot) {
  mountPanel(slot, {
    title: 'Resources',
    sourceIds: SOURCES,
    statusId: 'resources',
    load: async () => {
      const now = new Date();
      const [res, index] = await Promise.all([loadResourcesDoc(), loadNationIndex()]);
      if (!res.ok) return { data: null, status: unavailableStatus(SOURCES, 'The resources file could not be loaded.', now) };
      return { data: { items: res.doc.items, index: index.ok ? index.data.nations : [] }, status: curatedStatus(res, now, SOURCES, 'resources') };
    },
    render: (body, data) => renderHub(body, /** @type {{ items: Resource[], index: NationIndexEntry[] }} */ (data)),
    renderUnavailable: (body) => {
      body.append(
        h('p', { class: 'panel__unavailable' }, 'The resource list could not be loaded right now. Nothing is shown in its place.'),
        h('p', {}, h('a', { class: 'btn btn--secondary', href: telHref('911') }, 'Call Emergency Services')),
        h('p', {}, 'Official sources: ', outwardLink('https://www.weather.gov/', 'National Weather Service'), ' and the ',
          h('a', { href: '../safety/' }, 'Safety page'), '.'));
    },
  });
}

export { markOutwardLinks } from './contact-card.js';
