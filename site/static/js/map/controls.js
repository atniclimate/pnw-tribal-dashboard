// @ts-check
import { h } from '../core/dom.js';
import { formatAsOf } from '../core/time.js';

/** @typedef {{ id: string, on: boolean, status: import('../types.js').StatusSnapshot | null }} LayerState */
const LABELS = Object.freeze({ alerts: 'Alert Areas', zones: 'Alert Zones', radar: 'Current Radar', boundaries: 'Nation Land Areas', hq: 'Nation Locations', gauges: 'River Gauges', bc: 'BC Evacuation Areas' });

/** Native controls remain usable with keyboard, touch, and assistive technology.
 * @param {HTMLElement} frame
 * @param {{ layers: string[], setLayer: (id: string, on: boolean) => void, reset: () => void, fit: () => void }} actions
 */
export function mountMapControls(frame, actions) {
  const reset = /** @type {HTMLButtonElement} */ (h('button', { type: 'button', class: 'btn btn--secondary' }, 'Regional View'));
  const fit = /** @type {HTMLButtonElement} */ (h('button', { type: 'button', class: 'btn btn--secondary', disabled: true, title: 'Select a Nation to fit its location.' }, 'Fit Selected Nation'));
  reset.addEventListener('click', actions.reset);
  fit.addEventListener('click', actions.fit);
  const count = h('span', { class: 'map-controls__count' });
  const grid = h('div', { class: 'map-controls__layers' });
  /** @type {Map<string, {input: HTMLInputElement, status: HTMLElement}>} */
  const rows = new Map();
  for (const id of actions.layers) {
    const title = /** @type {Record<string, string>} */ (LABELS)[id];
    if (!title) continue;
    const input = /** @type {HTMLInputElement} */ (h('input', { type: 'checkbox', checked: id !== 'radar', 'data-map-layer': id }));
    const status = h('small', { class: 'map-controls__status' }, 'Loading map layer');
    const label = h('label', { class: 'map-controls__layer' }, input, h('span', {}, h('strong', {}, title), status));
    input.addEventListener('change', () => actions.setLayer(id, input.checked));
    grid.append(label);
    rows.set(id, { input, status });
  }
  const help = h('p', { class: 'map-controls__help' }, 'Select a Nation location, alert area, or gauge to explore it. On touchscreens, use two fingers to move the map.');
  const selection = h('p', { class: 'map-controls__selection', 'aria-live': 'polite' }, 'Regional View');
  const disclosure = h('details', { class: 'map-controls__disclosure' }, h('summary', {}, 'Map Layers ', count), selection, grid, help);
  const host = h('div', { class: 'map-controls', 'aria-label': 'Map Controls' }, h('div', { class: 'map-controls__actions' }, reset, fit, disclosure));
  frame.before(host);
  return {
    /** @param {LayerState[]} states @param {'interactive' | 'outline'} mode @param {string | null} nationName */
    update(states, mode, nationName) {
      const interactive = mode === 'interactive';
      reset.disabled = !interactive;
      fit.disabled = !interactive || !nationName;
      fit.title = nationName ? `Fit ${nationName}` : 'Select a Nation to fit its location.';
      selection.textContent = nationName ?? 'Regional View';
      count.textContent = `(${states.filter((s) => s.on && rows.has(s.id)).length} On)`;
      for (const state of states) {
        const row = rows.get(state.id);
        if (!row) continue;
        row.input.checked = state.on;
        row.input.disabled = !interactive;
        const stamp = state.status?.asOf ? ` As of ${formatAsOf(state.status.asOf)}.` : '';
        const stateLabel = state.status?.state === 'cached' ? 'Cached' : state.status ? state.status.state[0]?.toUpperCase() + state.status.state.slice(1) : '';
        row.status.textContent = !interactive ? 'Requires the interactive map.' : !state.on ? 'Off' : state.status ? `${stateLabel}. ${state.status.detail ?? ''}${stamp}` : 'Loading layer';
      }
    },
    destroy() { host.remove(); },
  };
}
