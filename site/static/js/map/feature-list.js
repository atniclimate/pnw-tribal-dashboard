// @ts-check
/**
 * Focusable feature list mirroring what the map draws (blueprint 4.6). DOM module.
 *
 * GPU-drawn circles and polygons are not DOM, so this "Features on the Map" disclosure gives every
 * feature in view a native button whose accessible name is the feature's name. The list is rebuilt on each
 * update but keeps keyboard focus on the same feature when it is still present.
 *
 * Owner: lane L8.
 */
import { clear, h } from '../core/dom.js';
import { haversineKm } from '../core/geo.js';

/** @typedef {import('../types.js').FeatureItem} FeatureItem */

/**
 * Capped at the 50 nearest the center.
 * @param {HTMLElement} container
 * @param {{ onActivate: (item: FeatureItem) => void, onFocus?: (item: FeatureItem) => void, onBlur?: (item: FeatureItem) => void, cap?: number }} opts
 * @returns {{ update(items: FeatureItem[], center?: [number, number] | null): void, focusItem(kind: string, id: string): void, destroy(): void, readonly items: FeatureItem[] }}
 */
export function createFeatureList(container, opts) {
  const cap = opts.cap ?? 50;
  const list = h('ul', { class: 'map-feature-list__items' });
  const more = h('p', { class: 'map-feature-list__more', hidden: true });
  const summary = h('summary', {}, 'Features on the Map');
  const details = /** @type {HTMLDetailsElement} */ (h('details', { class: 'map-feature-list' }, summary, list, more));
  container.append(details);
  /** @type {FeatureItem[]} */
  let shown = [];
  /** @type {Map<string, HTMLButtonElement>} */
  const buttons = new Map();
  const keyOf = (/** @type {{ kind: string, id: string }} */ i) => `${i.kind}\u0000${i.id}`;
  let destroyed = false;

  /** @param {FeatureItem} item */
  function button(item) {
    const b = /** @type {HTMLButtonElement} */ (h('button', { type: 'button', class: 'map-feature-list__button', dataset: { kind: item.kind, id: item.id } }, item.name));
    b.addEventListener('click', () => opts.onActivate(item));
    b.addEventListener('focus', () => opts.onFocus?.(item));
    b.addEventListener('blur', () => opts.onBlur?.(item));
    return b;
  }

  return {
    get items() { return shown; },
    update(items, center) {
      if (destroyed) return;
      const active = document.activeElement;
      const focusedKey = active instanceof HTMLButtonElement && list.contains(active) ? `${active.dataset.kind}\u0000${active.dataset.id}` : null;
      let ordered = items.slice();
      if (center) {
        const here = /** @type {[number, number]} */ ([center[1], center[0]]);
        const d = new Map(ordered.map((i) => [i, haversineKm(here, [i.lngLat[1], i.lngLat[0]])]));
        ordered.sort((a, b) => (d.get(a) ?? 0) - (d.get(b) ?? 0) || a.name.localeCompare(b.name));
      }
      const hidden = Math.max(0, ordered.length - cap);
      ordered = ordered.slice(0, cap);
      shown = ordered;
      clear(list);
      buttons.clear();
      for (const item of ordered) {
        const b = button(item);
        buttons.set(keyOf(item), b);
        list.append(h('li', {}, b));
      }
      if (!ordered.length) list.append(h('li', { class: 'map-feature-list__empty' }, 'No features are in view.'));
      more.hidden = hidden === 0;
      more.textContent = hidden ? `and ${hidden} more; see the list above` : '';
      summary.textContent = ordered.length ? `Features on the Map (${ordered.length}${hidden ? ` of ${ordered.length + hidden}` : ''})` : 'Features on the Map';
      if (focusedKey) buttons.get(focusedKey)?.focus({ preventScroll: true });
    },
    focusItem(kind, id) {
      const b = buttons.get(keyOf({ kind, id }));
      if (!b) return;
      details.open = true;
      b.focus();
    },
    destroy() {
      destroyed = true;
      details.remove();
      buttons.clear();
      shown = [];
    },
  };
}
