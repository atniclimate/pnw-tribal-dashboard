// @ts-check
/**
 * Gauge list grouped by region with category chips (blueprint 7.3). DOM module.
 *
 * Owner: lane L7. The category word is the NWS's own (hydro/flood-category.js words it; nothing here classifies).
 * A reading older than six hours says "Observation not current". British Columbia stations show level and
 * discharge with the threshold note and never a category. Every element is built with core/dom.js h().
 */

import { clear, h, on } from '../core/dom.js';
import { formatAsOf } from '../core/time.js';
import { linkWithState } from '../core/url-state.js';
import { NOT_CURRENT_TEXT, categoryLabel, observedDisplay } from '../hydro/flood-category.js';

/** @typedef {import('../types.js').Gauge} Gauge */
/** @typedef {import('../types.js').GaugeStatus} GaugeStatus */

/** Rows drawn before "Show All"; keeps phones responsive when a whole region is listed. */
export const ROW_LIMIT = 60;

/** @type {Record<string, string>} */
export const REGION_LABELS = Object.freeze({
  wa: 'Washington', or: 'Oregon', id: 'Idaho', bc: 'British Columbia',
  'ca-n': 'Northern California', 'mt-w': 'Western Montana', 'nv-n': 'Northern Nevada', 'ak-se': 'Southeast Alaska',
});
const REGION_ORDER = Object.keys(REGION_LABELS);

/** Chip order, most severe first. `key` is the filter value. */
export const CATEGORY_CHIPS = Object.freeze([
  { key: 'major', label: 'Major Flood' },
  { key: 'moderate', label: 'Moderate Flood' },
  { key: 'minor', label: 'Minor Flood' },
  { key: 'action', label: 'Action Stage' },
  { key: 'no_flooding', label: 'No Flooding' },
  { key: 'not_defined', label: 'No Categories Defined' },
  { key: 'not_current', label: NOT_CURRENT_TEXT },
]);

const SEVERITY = /** @type {Record<string, number>} */ ({ major: 5, moderate: 4, minor: 3, action: 2, no_flooding: 1 });
const AT_OR_ABOVE = new Set(['action', 'minor', 'moderate', 'major']);

/**
 * @param {number | null | undefined} n
 * @returns {string}
 */
function num(n) {
  return String(Math.round(/** @type {number} */ (n) * 100) / 100);
}

/**
 * Latest reading as the agency published it: stage first, then discharge; units untouched.
 * @param {GaugeStatus | null | undefined} status
 * @returns {string}
 */
export function readingText(status) {
  const o = status?.observed;
  if (!o) return 'No reading';
  const parts = [];
  if (o.stage !== null && o.stage !== undefined) parts.push(`${num(o.stage)} ${o.unit ?? ''}`.trim());
  if (o.flow !== null && o.flow !== undefined) parts.push(`${num(o.flow)} ${o.flowUnit ?? ''}`.trim());
  return parts.length ? parts.join(', ') : 'No reading';
}

/**
 * @param {string | null} category
 * @returns {string} the data-flood token components.css styles
 */
export function floodToken(category) {
  if (category === 'no_flooding') return 'none';
  if (category === 'major' || category === 'moderate' || category === 'minor' || category === 'action') return category;
  return 'not-defined';
}

/**
 * Which chip a gauge answers to: the NWS category when the observation is current, else "not_current" (an
 * out-of-service or stale observation) or "not_defined".
 * @param {Gauge} gauge
 * @param {GaugeStatus | null | undefined} status
 * @param {Date} now
 * @returns {string}
 */
export function chipKeyOf(gauge, status, now) {
  const d = observedDisplay(status, now);
  if (d.category === 'out_of_service' || (d.category !== null && !d.current)) return 'not_current';
  if (d.category === null) return gauge.agency === 'WSC' ? 'not_defined' : 'not_current';
  return d.category;
}

/**
 * Pure view model: filter, group by region, rank by severity. No DOM.
 * @param {Gauge[]} gauges
 * @param {Map<string, GaugeStatus>} statuses
 * @param {{ timeZone: string, now?: Date, categories?: string[], atOrAboveAction?: boolean }} opts
 * @returns {{ total: number, shown: number, counts: Record<string, number>, groups: { region: string, label: string, rows: Record<string, any>[] }[] }}
 */
export function buildGaugeListModel(gauges, statuses, opts) {
  const now = opts.now ?? new Date();
  /** @type {Record<string, number>} */
  const counts = {};
  /** @type {Map<string, Record<string, any>[]>} */
  const byRegion = new Map();
  let shown = 0;
  for (const g of gauges) {
    const status = statuses.get(g.id) ?? null;
    const display = observedDisplay(status, now);
    const key = chipKeyOf(g, status, now);
    counts[key] = (counts[key] ?? 0) + 1;
    if (opts.atOrAboveAction && !(display.current && display.category && AT_OR_ABOVE.has(display.category))) continue;
    if (opts.categories && opts.categories.length > 0 && !opts.categories.includes(key)) continue;
    const fc = status?.forecast ?? null;
    const row = {
      gauge: g,
      id: g.id,
      key,
      rank: display.current && display.category ? (SEVERITY[display.category] ?? 0) : 0,
      label: g.agency === 'WSC' ? 'No official flood category for this station' : display.label,
      category: g.agency === 'WSC' ? null : display.category,
      current: display.current,
      reading: readingText(status),
      time: status?.observed?.validTime ? formatAsOf(status.observed.validTime, opts.timeZone) : null,
      forecastLine: g.isForecastPoint && fc
        ? (fc.crestStage !== null && fc.crestStage !== undefined
          ? `Forecast crest ${num(fc.crestStage)} ${fc.unit ?? ''}${fc.crestTime ? ` at ${formatAsOf(fc.crestTime, opts.timeZone)}` : ''}`.trim()
          : `No forecast crest published${fc.category ? `; forecast category ${categoryLabel(fc.category)}` : ''}`)
        : null,
    };
    const list = byRegion.get(g.region) ?? [];
    list.push(row);
    byRegion.set(g.region, list);
    shown += 1;
  }
  const regions = [...byRegion.keys()].sort((a, b) => REGION_ORDER.indexOf(a) - REGION_ORDER.indexOf(b));
  const groups = regions.map((region) => {
    const rows = /** @type {Record<string, any>[]} */ (byRegion.get(region));
    rows.sort((a, b) => (b.rank - a.rank) || (Number(b.gauge.isForecastPoint) - Number(a.gauge.isForecastPoint)) || (a.gauge.name < b.gauge.name ? -1 : a.gauge.name > b.gauge.name ? 1 : 0));
    return { region, label: REGION_LABELS[region] ?? region, rows };
  });
  return { total: gauges.length, shown, counts, groups };
}

/**
 * @param {Record<string, any>} row
 * @param {{ onSelect?: (gaugeId: string) => void }} opts
 * @returns {HTMLElement}
 */
function rowEl(row, opts) {
  const g = /** @type {Gauge} */ (row.gauge);
  const href = linkWithState(`?view=rivers&g=${encodeURIComponent(g.id)}`);
  return h('li', { class: `gauge-card${row.current ? '' : ' gauge-card--not-current'}`, 'data-flood': floodToken(row.category), 'data-gauge': g.id },
    h('h4', { class: 'gauge-card__name' },
      h('a', { href, 'data-action': 'select-gauge', 'data-gauge': g.id }, g.name)),
    g.river ? h('span', { class: 'gauge-card__stamp' }, g.river) : null,
    h('span', { class: 'gauge-card__reading' }, row.reading),
    h('span', { class: 'gauge-card__category' }, row.label),
    row.time ? h('span', { class: 'gauge-card__stamp' }, `Observed ${row.time}`) : h('span', { class: 'gauge-card__stamp' }, 'No observation time'),
    row.forecastLine ? h('span', { class: 'gauge-card__stamp' }, row.forecastLine) : null,
    g.agency === 'WSC' ? h('span', { class: 'gauge-card__stamp' }, 'Water Survey of Canada station; trend not available') : null);
}

/**
 * @param {HTMLElement} el
 * @param {Gauge[]} gauges
 * @param {Map<string, GaugeStatus>} statuses
 * @param {{ timeZone: string, atOrAboveAction?: boolean, onSelect?: (gaugeId: string) => void }} opts
 * @returns {void}
 */
export function renderGaugeList(el, gauges, statuses, opts) {
  const state = { categories: /** @type {string[]} */ ([]), atOrAbove: opts.atOrAboveAction === true, all: false, query: '', region: '' };
  const now = new Date();
  clear(el);
  el.classList.add('gauge-list');

  const toggle = h('input', { type: 'checkbox', id: `gl-action-${el.id || 'x'}`, 'data-action': 'toggle-action', checked: state.atOrAbove });
  const toggleLabel = h('label', { for: toggle.id }, toggle, ' At or Above Action Stage');
  const chipBar = h('div', { class: 'filter-chips', role: 'group', 'aria-label': 'Flood Category' });
  const summary = h('p', { class: 'gauge-list__summary', role: 'status', 'aria-live': 'polite' });
  const body = h('div', { class: 'gauge-list__body' });
  const search = /** @type {HTMLInputElement} */ (h('input', { type: 'search', 'aria-label': 'Find a River or Gauge', placeholder: 'River, gauge name, or station ID' }));
  const region = /** @type {HTMLSelectElement} */ (h('select', { 'aria-label': 'Gauge Region' }, h('option', { value: '' }, 'All Regions'), REGION_ORDER.filter((key) => gauges.some((g) => g.region === key)).map((key) => h('option', { value: key }, REGION_LABELS[key]))));
  el.append(h('div', { class: 'chart-controls' }, h('label', {}, 'Find a River or Gauge', search), h('label', {}, 'Region', region)), toggleLabel, chipBar, summary, body);

  const draw = () => {
    const matching = gauges.filter((g) => (!state.region || g.region === state.region) && (!state.query || `${g.name} ${g.river ?? ''} ${g.id}`.toLocaleLowerCase().includes(state.query)));
    const model = buildGaugeListModel(matching, statuses, { timeZone: opts.timeZone, now, categories: state.categories, atOrAboveAction: state.atOrAbove });
    clear(chipBar);
    for (const c of CATEGORY_CHIPS) {
      const n = model.counts[c.key] ?? 0;
      const on_ = state.categories.includes(c.key);
      chipBar.append(h('button', { type: 'button', class: 'filter-chip', 'aria-pressed': on_ ? 'true' : 'false', 'data-action': 'chip', 'data-key': c.key, disabled: n === 0 && !on_ },
        c.label, ' ', h('span', { class: 'filter-chip__count' }, `(${n})`)));
    }
    clear(body);
    summary.textContent = model.total === 0
      ? 'No gauges to list.'
      : `Showing ${model.shown} of ${model.total} gauges.`;
    let drawn = 0;
    for (const grp of model.groups) {
      if (!state.all && drawn >= ROW_LIMIT) break;
      const rows = state.all ? grp.rows : grp.rows.slice(0, ROW_LIMIT - drawn);
      drawn += rows.length;
      body.append(h('section', { class: 'gauge-list__group', 'aria-label': grp.label },
        h('h3', {}, `${grp.label} (${grp.rows.length})`),
        h('ul', { class: 'gauge-list__rows', role: 'list' }, rows.map((r) => rowEl(r, opts)))));
    }
    if (model.shown > drawn) {
      body.append(h('button', { type: 'button', class: 'btn btn--secondary', 'data-action': 'show-all' }, `Show All ${model.shown} Gauges`));
    }
    summary.textContent = model.shown === 0 ? 'No gauges match these filters. Clear the search or change a filter.' : `Showing ${drawn} of ${model.shown} matching gauges.`;
  };

  search.addEventListener('input', () => { state.query = search.value.trim().toLocaleLowerCase(); state.all = false; draw(); });
  region.addEventListener('change', () => { state.region = region.value; state.all = false; draw(); });

  on(el, 'chip', (_e, t) => {
    const key = t.dataset.key ?? '';
    state.categories = state.categories.includes(key) ? state.categories.filter((k) => k !== key) : [...state.categories, key];
    draw();
    /** @type {HTMLElement | null} */ (el.querySelector(`[data-action="chip"][data-key="${key}"]`))?.focus();
  });
  on(el, 'toggle-action', (_e, t) => { state.atOrAbove = /** @type {HTMLInputElement} */ (t).checked; draw(); }, 'change');
  on(el, 'show-all', () => { state.all = true; draw(); });
  on(el, 'select-gauge', (e, t) => {
    if (opts.onSelect) { e.preventDefault(); t.focus({ preventScroll: true }); opts.onSelect(t.dataset.gauge ?? ''); }
  });
  draw();
}
