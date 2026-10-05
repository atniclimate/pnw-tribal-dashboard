// @ts-check
/**
 * Filter chips bound to URL state (blueprint 7.2). DOM module.
 *
 * A group of real `<button aria-pressed>` toggles. The buttons are created once and only their state
 * changes afterward, so a keyboard user keeps focus on the chip they just pressed. The caller owns the URL:
 * `onChange` receives the selected values, and the caller writes them to the query string and calls `set`
 * when the URL changes from elsewhere (back button, a summary tile).
 *
 * Owner: lane L11.
 */
import { h } from '../core/dom.js';

let counter = 0;

/**
 * @param {HTMLElement} el
 * @param {{ key: string, label: string, options: { value: string, label: string }[], selected: string[], onChange: (values: string[]) => void }} opts
 * @returns {{ set(values: string[]): void, setCounts(counts: Record<string, number> | null): void, destroy(): void }}
 */
export function createFilterChips(el, opts) {
  counter += 1;
  const labelId = `filter-${opts.key}-${counter}`;
  el.classList.add('filter-chips');
  el.setAttribute('role', 'group');
  el.setAttribute('aria-labelledby', labelId);
  el.setAttribute('data-filter-key', opts.key);
  el.replaceChildren(h('span', { class: 'caption', id: labelId }, `${opts.label}:`));

  /** @type {Set<string>} */
  let selected = new Set(opts.selected);
  /** @type {Map<string, { button: HTMLButtonElement, count: HTMLElement }>} */
  const chips = new Map();
  for (const o of opts.options) {
    const count = h('span', { class: 'filter-chip__count' });
    count.hidden = true;
    const button = /** @type {HTMLButtonElement} */ (h('button', { type: 'button', class: 'filter-chip', 'data-value': o.value, 'aria-pressed': 'false' }, o.label, ' ', count));
    chips.set(o.value, { button, count });
    el.append(button);
  }

  function paint() {
    for (const [value, chip] of chips) chip.button.setAttribute('aria-pressed', String(selected.has(value)));
  }

  /** @param {Event} e */
  const onClick = (e) => {
    const target = /** @type {Element | null} */ (e.target instanceof Element ? e.target.closest('[data-value]') : null);
    const value = target?.getAttribute('data-value');
    if (!target || !value || !el.contains(target)) return;
    if (selected.has(value)) selected.delete(value);
    else selected.add(value);
    paint();
    // Option order, not click order, so equal selections give equal URLs.
    opts.onChange(opts.options.map((o) => o.value).filter((v) => selected.has(v)));
  };
  el.addEventListener('click', onClick);
  paint();

  return {
    set(values) {
      selected = new Set(values.filter((v) => chips.has(v)));
      paint();
    },
    setCounts(counts) {
      for (const [value, chip] of chips) {
        const n = counts?.[value];
        if (typeof n === 'number') { chip.count.textContent = String(n); chip.count.hidden = false; } else { chip.count.textContent = ''; chip.count.hidden = true; }
      }
    },
    destroy() {
      el.removeEventListener('click', onClick);
      el.replaceChildren();
      el.removeAttribute('role');
      el.removeAttribute('aria-labelledby');
    },
  };
}
