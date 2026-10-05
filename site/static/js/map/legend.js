// @ts-check
/**
 * Legend rendering (blueprint 4.4). DOM module.
 *
 * Owner: lane L8.
 */
import { clear, h } from '../core/dom.js';

/** @typedef {import('../types.js').LegendItem} LegendItem */

/**
 * Swatches by class from map.css (and the L1 `legend__swatch` set); text through h().
 * @param {HTMLElement} el
 * @param {LegendItem[]} items
 * @returns {void}
 */
export function renderLegend(el, items) {
  clear(el);
  el.classList.add('legend', 'map-legend');
  if (!el.hasAttribute('aria-label')) el.setAttribute('aria-label', 'Map Legend');
  for (const item of items) {
    el.append(h('li', { class: 'legend__item', dataset: { legendId: item.id } },
      h('span', { class: `legend__swatch ${item.swatchClass}`, 'aria-hidden': 'true' }),
      h('span', { class: 'legend__label' }, item.label, item.note ? h('span', { class: 'legend__note' }, ` ${item.note}`) : null)));
  }
}
