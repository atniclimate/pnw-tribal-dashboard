// @ts-check
/**
 * WAI-ARIA 1.2 editable combobox with listbox popup; full-height sheet below 640 px (blueprint 3.6). DOM module.
 *
 * Owner: lane L10. Search aliases never replace a Nation's full formal display name.
 */
import { h } from '../core/dom.js';
import { loadNationsIndex, searchNations, displayName } from '../data/nations.js';

let sequence = 0;

/**
 * @param {HTMLElement} trigger
 * @param {{ onSelect: (id: string | null) => void }} opts
 * @returns {{ open(): void, close(): void, destroy(): void }}
 */
export function createNationPicker(trigger, opts) {
  const uid = `nation-picker-${++sequence}`;
  const dialog = /** @type {HTMLDialogElement} */ (h('dialog', { class: 'nation-picker', 'aria-labelledby': `${uid}-title` }));
  const input = /** @type {HTMLInputElement} */ (h('input', { id: `${uid}-input`, type: 'search', role: 'combobox',
    autocomplete: 'off', 'aria-autocomplete': 'list', 'aria-expanded': 'false', 'aria-controls': `${uid}-list`,
    placeholder: 'Search by Nation name' }));
  const list = h('ul', { id: `${uid}-list`, class: 'nation-picker__list', role: 'listbox', 'aria-label': 'Matching Nations' });
  const status = h('p', { class: 'caption', role: 'status', 'aria-live': 'polite' });
  const done = h('button', { type: 'button', class: 'btn btn--secondary' }, 'Close');
  const all = h('button', { type: 'button', class: 'btn btn--secondary' }, 'All of Cascadia');
  const retry = h('button', { type: 'button', class: 'btn btn--secondary', hidden: true }, 'Try Loading Nations Again');
  dialog.append(h('div', { class: 'nation-picker__heading' }, h('h2', { id: `${uid}-title` }, 'Choose a Nation'), done),
    h('label', { for: input.id }, 'Tribal Nation or First Nation'), input, status, retry, list, all,
    h('p', { class: 'caption' }, 'Full formal Nation names are shown. Alternate names can be used to search.'));
  document.body.append(dialog);
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
  function select(id) { close(); opts.onSelect(id); }
  function draw() {
    matches = searchNations(nations ?? [], input.value).slice(0, 100);
    active = -1;
    input.removeAttribute('aria-activedescendant');
    list.replaceChildren(...matches.map((nation, i) => {
      const name = displayName(nation);
      const option = h('li', { id: `${uid}-${i}`, role: 'option', 'aria-selected': 'false', class: 'nation-picker__option' },
        h('span', {}, name.primary), name.secondary ? h('span', { class: 'caption' }, name.secondary) : null,
        h('span', { class: 'caption' }, nation.jurisdictions.join(', ')));
      option.addEventListener('mousedown', (event) => event.preventDefault());
      option.addEventListener('click', () => select(nation.id));
      return option;
    }));
    input.setAttribute('aria-expanded', String(matches.length > 0));
    if (nations) status.textContent = matches.length === 100 ? 'Showing the first 100 matches. Type to narrow the list.'
      : matches.length ? `${matches.length} matching Nations.` : 'No matching Nations. Try another name or choose All of Cascadia.';
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
  input.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault(); activate(event.key === 'ArrowDown' ? active + 1 : active < 0 ? matches.length - 1 : active - 1);
    } else if (event.key === 'Enter' && active >= 0) {
      event.preventDefault(); const nation = matches[active]; if (nation) select(nation.id);
    } else if (event.key === 'Escape' && input.value) {
      event.preventDefault(); event.stopPropagation(); input.value = ''; draw();
    }
  });
  function close() { if (dialog.open) dialog.close(); trigger.focus(); }
  function open() { if (destroyed || dialog.open) return; dialog.showModal(); input.focus(); void load(); }
  /** @param {Event} event */
  function click(event) { event.preventDefault(); open(); }
  trigger.addEventListener('click', click);
  done.addEventListener('click', close);
  all.addEventListener('click', () => select(null));
  retry.addEventListener('click', () => { void load(); });
  dialog.addEventListener('close', () => trigger.focus());
  return { open, close, destroy() { destroyed = true; abort.abort(); trigger.removeEventListener('click', click); dialog.remove(); } };
}
