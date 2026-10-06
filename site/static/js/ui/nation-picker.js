// @ts-check
/**
 * WAI-ARIA 1.2 editable combobox with listbox popup; full-height sheet below 640 px (blueprint 3.6). DOM module.
 *
 * Owner: lane L10. Search aliases never replace a Nation's full formal display name.
 */
import { h } from '../core/dom.js';
import { loadNationsIndex, searchNations, displayName } from '../data/nations.js';
import { getItem, setItem, removeItem } from '../core/storage.js';

let sequence = 0;
const RECENTS_KEY = 'nation-recents';
const RECENT_LIMIT = 5;
/** @type {Readonly<Record<string, string>>} */
const REGIONS = Object.freeze({ BC: 'British Columbia', WA: 'Washington', OR: 'Oregon', ID: 'Idaho',
  CA: 'Northern California', MT: 'Western Montana', NV: 'Northern Nevada', AK: 'Southeast Alaska' });

/** Only ids in the approved registry can become recent choices. @param {import('../types.js').NationIndexEntry[]} nations */
function recentNations(nations) {
  try {
    const ids = /** @type {unknown} */ (JSON.parse(getItem(RECENTS_KEY) ?? '[]'));
    if (!Array.isArray(ids)) return [];
    return [...new Set(ids.filter((id) => typeof id === 'string'))].slice(0, RECENT_LIMIT)
      .flatMap((id) => { const nation = nations.find((entry) => entry.id === id); return nation ? [nation] : []; });
  } catch { return []; }
}

/**
 * @param {HTMLElement} trigger
 * @param {{ onSelect: (id: string | null) => void }} opts
 * @returns {{ open(): void, close(): void, destroy(): void }}
 */
export function createNationPicker(trigger, opts) {
  const uid = `nation-picker-${++sequence}`;
  const dialog = /** @type {HTMLDialogElement} */ (h('dialog', { id: uid, class: 'nation-picker', 'aria-labelledby': `${uid}-title` }));
  const input = /** @type {HTMLInputElement} */ (h('input', { id: `${uid}-input`, type: 'search', role: 'combobox',
    autocomplete: 'off', 'aria-autocomplete': 'list', 'aria-expanded': 'false', 'aria-controls': `${uid}-list`,
    placeholder: 'Search by Nation name' }));
  const list = h('ul', { id: `${uid}-list`, class: 'nation-picker__list', role: 'listbox', 'aria-label': 'Matching Nations' });
  const status = h('p', { class: 'caption nation-picker__status', role: 'status', 'aria-live': 'polite' });
  const region = /** @type {HTMLSelectElement} */ (h('select', { id: `${uid}-region` },
    h('option', { value: '' }, 'All Regions'),
    Object.entries(REGIONS).map(([value, label]) => h('option', { value }, label))));
  const clearFilters = h('button', { type: 'button', class: 'btn btn--secondary' }, 'Clear Filters');
  const recentList = h('div', { class: 'nation-picker__recents-list' });
  const clearRecents = h('button', { type: 'button', class: 'btn btn--link' }, 'Clear Recent Choices');
  const recents = h('section', { class: 'nation-picker__recents', 'aria-labelledby': `${uid}-recents`, hidden: true },
    h('div', { class: 'nation-picker__recents-heading' }, h('h3', { id: `${uid}-recents` }, 'Recent Choices'), clearRecents), recentList);
  const done = h('button', { type: 'button', class: 'btn btn--secondary' }, 'Close');
  const all = h('button', { type: 'button', class: 'btn btn--secondary' }, 'All of Cascadia');
  const retry = h('button', { type: 'button', class: 'btn btn--secondary', hidden: true }, 'Try Loading Nations Again');
  dialog.append(h('div', { class: 'nation-picker__heading' }, h('div', {}, h('h2', { id: `${uid}-title` }, 'Choose a Nation'),
    h('p', { class: 'caption' }, 'Connect the map, alerts, local forecast, and rivers.')), done),
    h('div', { class: 'nation-picker__search' }, h('label', { for: input.id }, 'Tribal Nation or First Nation'), input),
    h('div', { class: 'nation-picker__filters' }, h('div', {}, h('label', { for: region.id }, 'State or Province'), region), clearFilters),
    recents, status, retry, list,
    h('div', { class: 'nation-picker__footer' }, all,
      h('p', { class: 'caption' }, 'Full formal Nation names are shown. Alternate names can be used to search. Recent choices stay on this device.')));
  document.body.append(dialog);
  trigger.setAttribute('aria-haspopup', 'dialog');
  trigger.setAttribute('aria-controls', uid);
  trigger.setAttribute('aria-expanded', 'false');
  /** @type {import('../types.js').NationIndexEntry[] | null} */
  let nations = null;
  /** @type {import('../types.js').NationIndexEntry[]} */
  let matches = [];
  let active = -1;
  let loading = false;
  let destroyed = false;
  const abort = new AbortController();

  /** @param {number} next */
  function activate(next) {
    active = matches.length ? Math.max(0, Math.min(next, matches.length - 1)) : -1;
    for (const [i, option] of [...list.children].entries()) option.setAttribute('aria-selected', String(i === active));
    if (active < 0) input.removeAttribute('aria-activedescendant');
    else { input.setAttribute('aria-activedescendant', `${uid}-${active}`); list.children[active]?.scrollIntoView({ block: 'nearest' }); }
  }
  /** @param {string | null} id */
  function select(id) {
    if (id && nations?.some((nation) => nation.id === id)) {
      const ids = [id, ...recentNations(nations).map((nation) => nation.id).filter((recent) => recent !== id)].slice(0, RECENT_LIMIT);
      setItem(RECENTS_KEY, JSON.stringify(ids));
    }
    close(); opts.onSelect(id);
  }
  function drawRecents() {
    const recent = recentNations(nations ?? []);
    recents.hidden = !recent.length || Boolean(input.value.trim()) || Boolean(region.value);
    recentList.replaceChildren(...recent.map((nation) => {
      const button = h('button', { type: 'button', class: 'btn btn--secondary nation-picker__recent' }, nation.name);
      button.addEventListener('click', () => select(nation.id));
      return button;
    }));
  }
  function draw() {
    const filtered = (nations ?? []).filter((nation) => !region.value || nation.jurisdictions.some((code) => code === region.value));
    const found = searchNations(filtered, input.value);
    matches = found.slice(0, 100);
    drawRecents();
    active = -1;
    input.removeAttribute('aria-activedescendant');
    list.replaceChildren(...matches.map((nation, i) => {
      const name = displayName(nation);
      const option = h('li', { id: `${uid}-${i}`, role: 'option', 'aria-selected': 'false', class: 'nation-picker__option' },
        h('span', { class: 'nation-picker__option-name' }, name.primary), name.secondary ? h('span', { class: 'caption' }, name.secondary) : null,
        h('span', { class: 'caption' }, nation.jurisdictions.map((code) => REGIONS[code] ?? code).join(', ')));
      option.addEventListener('mousedown', (event) => event.preventDefault());
      option.addEventListener('click', () => select(nation.id));
      return option;
    }));
    input.setAttribute('aria-expanded', String(matches.length > 0));
    if (nations) status.textContent = found.length > matches.length ? `Showing ${matches.length} of ${found.length} matching Nations. Search or choose a region to narrow the list.`
      : matches.length ? `${matches.length} matching Nation${matches.length === 1 ? '' : 's'}. Use arrow keys to explore, then Enter to select.`
        : 'No matching Nations. Clear the search, change the region, or choose All of Cascadia.';
  }
  async function load() {
    if (loading || nations) return;
    loading = true;
    retry.hidden = true;
    status.textContent = 'Loading the Nation registry.';
    try {
      const result = await loadNationsIndex({ signal: abort.signal });
      if (destroyed) return;
      if (!result.ok || !Array.isArray(result.data.nations)) throw new Error('Registry unavailable');
      nations = result.data.nations;
      draw();
    } catch {
      if (!destroyed) { status.textContent = 'The Nation registry could not be loaded. All of Cascadia is still available.'; retry.hidden = false; }
    } finally { loading = false; }
  }
  input.addEventListener('input', draw);
  region.addEventListener('change', draw);
  clearFilters.addEventListener('click', () => { input.value = ''; region.value = ''; draw(); input.focus(); });
  clearRecents.addEventListener('click', () => { removeItem(RECENTS_KEY); drawRecents(); input.focus(); });
  input.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault(); activate(event.key === 'ArrowDown' ? active + 1 : active < 0 ? matches.length - 1 : active - 1);
    } else if (event.key === 'Enter' && (active >= 0 || matches.length === 1)) {
      event.preventDefault(); const nation = matches[active >= 0 ? active : 0]; if (nation) select(nation.id);
    } else if (event.key === 'Escape' && input.value) {
      event.preventDefault(); event.stopPropagation(); input.value = ''; draw();
    }
  });
  function close() { if (dialog.open) dialog.close(); trigger.setAttribute('aria-expanded', 'false'); trigger.focus(); }
  function open() {
    if (destroyed || dialog.open) return;
    input.value = ''; region.value = ''; draw();
    dialog.showModal(); trigger.setAttribute('aria-expanded', 'true'); input.focus(); void load();
  }
  /** @param {Event} event */
  function click(event) { event.preventDefault(); open(); }
  trigger.addEventListener('click', click);
  done.addEventListener('click', close);
  all.addEventListener('click', () => select(null));
  retry.addEventListener('click', () => { void load(); });
  dialog.addEventListener('close', () => { trigger.setAttribute('aria-expanded', 'false'); trigger.focus(); });
  return { open, close, destroy() {
    destroyed = true; abort.abort(); trigger.removeEventListener('click', click);
    trigger.removeAttribute('aria-controls'); trigger.removeAttribute('aria-haspopup'); trigger.removeAttribute('aria-expanded'); dialog.remove();
  } };
}
