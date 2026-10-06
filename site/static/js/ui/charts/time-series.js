// @ts-check
/** Small dependency-free charts. Pointer, touch, native keyboard slider, and full values table. */
import { h, clear } from '../../core/dom.js';
import { formatAsOf } from '../../core/time.js';

/** @typedef {{ time: string, value: number | null, label?: string, detail?: string }} ChartPoint */
/** @typedef {{ name: string, kind: 'observed' | 'forecast', points: ChartPoint[], marker?: 'circle' | 'square' }} ChartLine */
/** @typedef {{ label: string, value: number, flood?: 'action' | 'minor' | 'moderate' | 'major' }} ChartThreshold */
/** @param {string} value @param {Record<string, string | number>} attrs */
function text(value, attrs) {
  const node = document.createElementNS('http://www.w3.org/2000/svg', 'text');
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  node.textContent = value;
  return node;
}
/** @param {number} value */
const number = (value) => new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(value);

/**
 * @param {HTMLElement} host
 * @param {{ title: string, unit: string, timeZone: string, lines: ChartLine[], thresholds?: ChartThreshold[], zeroFloor?: boolean, bars?: boolean, discrete?: boolean, selectedTime?: string, maxGapMs?: number, onSelect?: (point: ChartPoint) => void }} opts
 */
export function renderTimeSeries(host, opts) {
  clear(host);
  host.classList.add('interactive-chart');
  const compact = host.clientWidth > 0 && host.clientWidth < 500;
  const RIGHT = compact ? 360 : 684; const TOP = 24; const BOTTOM = 240;
  const WIDTH = compact ? 380 : 710;
  const entries = opts.lines.flatMap((line) => line.points.filter((p) => p.value !== null).map((point) => ({ ...point, series: line.name, kind: line.kind }))).sort((a, b) => Date.parse(a.time) - Date.parse(b.time));
  if (!entries.length) { host.append(h('p', { class: 'panel-unavailable' }, 'No numeric readings are available for this time range.')); return; }
  const values = entries.map((p) => /** @type {number} */ (p.value));
  const thresholdValues = (opts.thresholds ?? []).map((t) => t.value);
  let min = opts.zeroFloor ? 0 : Math.min(...values, ...thresholdValues);
  let max = Math.max(...values, ...thresholdValues);
  const pad = Math.max((max - min) * 0.12, max === 0 ? 1 : Math.abs(max) * 0.03, 0.01);
  max += pad; if (!opts.zeroFloor) min -= pad;
  const scale = 10 ** Math.floor(Math.log10((max - min) / 4));
  const step = ([1, 2, 5, 10].find((n) => n * scale >= (max - min) / 4) ?? 10) * scale;
  min = Math.floor(min / step) * step; max = Math.ceil(max / step) * step;
  const ticks = Array.from({ length: Math.round((max - min) / step) + 1 }, (_, index) => min + index * step);
  // Reserve room for the actual tick labels, including large discharge values.
  const tickLabels = ticks.map(number);
  const LEFT = Math.max(58, Math.max(...tickLabels.map((label) => label.length)) * (compact ? 9 : 8) + 12);
  const from = Date.parse(entries[0]?.time ?? '');
  const to = Math.max(from + 1, Date.parse(entries.at(-1)?.time ?? ''));
  const barPad = opts.bars ? (RIGHT - LEFT) / (Math.max(entries.length, 1) * 2) : 0;
  const x = (/** @type {string} */ t) => LEFT + barPad + (Date.parse(t) - from) / (to - from) * (RIGHT - LEFT - 2 * barPad);
  const y = (/** @type {number} */ v) => BOTTOM - (v - min) / (max - min) * (BOTTOM - TOP);
  const svg = h('svg', { viewBox: `0 0 ${WIDTH} 292`, class: `time-series-chart${compact ? ' time-series-chart--compact' : ''}`, role: 'img', 'aria-label': `${opts.title}. ${opts.unit}. Use the reading slider or data table to inspect every value.`, 'data-chart': opts.bars ? 'qpf-interactive' : 'time-series' });
  svg.append(h('title', {}, opts.title));
  for (const value of ticks) {
    svg.append(h('line', { x1: LEFT, x2: RIGHT, y1: y(value), y2: y(value), class: 'chart-grid' }), text(number(value), { x: LEFT - 8, y: y(value) + 4, 'text-anchor': 'end', class: 'chart-axis' }));
  }
  svg.append(text(opts.unit, { x: LEFT, y: 14, class: 'chart-axis' }));
  for (let tick = 0; tick <= 3; tick++) {
    const time = new Date(from + (to - from) * tick / 3);
    const label = new Intl.DateTimeFormat('en-US', { timeZone: opts.timeZone, month: '2-digit', day: '2-digit', ...(!compact && !opts.bars ? { hour: /** @type {const} */ ('numeric') } : {}) }).format(time);
    svg.append(text(label, { x: LEFT + (RIGHT - LEFT) * tick / 3, y: 270, 'text-anchor': tick === 0 ? 'start' : tick === 3 ? 'end' : 'middle', class: 'chart-axis' }));
  }
  for (const threshold of opts.thresholds ?? []) {
    const attrs = { x1: LEFT, x2: RIGHT, y1: y(threshold.value), y2: y(threshold.value), 'data-flood': threshold.flood };
    if (threshold.flood === 'major') svg.append(h('line', { ...attrs, class: 'chart-threshold-keyline' }));
    svg.append(h('line', { ...attrs, class: 'chart-threshold' }), text(`${threshold.label} ${number(threshold.value)} ${opts.unit}`, { x: RIGHT - 3, y: y(threshold.value) - 4, 'text-anchor': 'end', class: 'chart-threshold-label' }));
  }
  for (const line of opts.lines) {
    let previous = NaN; let path = '';
    for (const point of line.points) {
      if (point.value === null) { previous = NaN; continue; }
      if (opts.bars) {
        const width = Math.min(64, (RIGHT - LEFT) / entries.length * 0.62);
        svg.append(h('rect', { x: x(point.time) - width / 2, y: y(point.value), width, height: Math.max(2, y(0) - y(point.value)), class: 'chart-bar' }));
      } else if (opts.discrete) {
        svg.append(line.marker === 'square'
          ? h('rect', { x: x(point.time) - 4, y: y(point.value) - 4, width: 8, height: 8, class: 'chart-period-point chart-period-point--night' })
          : h('circle', { cx: x(point.time), cy: y(point.value), r: 4, class: 'chart-period-point' }));
      } else {
        const gap = Date.parse(point.time) - previous;
        path += `${!Number.isFinite(previous) || gap > (opts.maxGapMs ?? Infinity) ? 'M' : 'L'}${x(point.time)},${y(point.value)} `;
        previous = Date.parse(point.time);
      }
    }
    if (path) svg.append(h('path', { d: path, class: `chart-line chart-line--${line.kind}` }));
  }
  const cursor = h('line', { x1: LEFT, x2: LEFT, y1: TOP, y2: BOTTOM, class: 'chart-cursor' });
  const dot = h('circle', { cx: LEFT, cy: BOTTOM, r: 5, class: 'chart-selected' });
  svg.append(cursor, dot);
  const readout = h('p', { class: 'chart-readout', role: 'status', 'aria-live': 'polite', 'aria-atomic': 'true', 'data-chart-readout': '' });
  const slider = /** @type {HTMLInputElement} */ (h('input', { type: 'range', min: 0, max: entries.length - 1, step: 1, value: 0, 'aria-label': `${opts.title}: inspect reading`, class: 'chart-inspector' }));
  const label = h('label', { class: 'chart-inspector-label' }, 'Inspect a Reading', slider);
  let selected = 0;
  /** @param {number} index @param {boolean} [notify] */
  const inspect = (index, notify = true) => {
    selected = Math.max(0, Math.min(entries.length - 1, index));
    const point = entries[selected]; if (!point) return;
    slider.value = String(selected);
    const description = `${point.series}: ${number(/** @type {number} */ (point.value))} ${opts.unit}. ${point.label ?? formatAsOf(point.time, opts.timeZone)}${point.detail ? `. ${point.detail}` : ''}`;
    readout.textContent = description; slider.setAttribute('aria-valuetext', description);
    cursor.setAttribute('x1', String(x(point.time))); cursor.setAttribute('x2', String(x(point.time)));
    dot.setAttribute('cx', String(x(point.time))); dot.setAttribute('cy', String(y(/** @type {number} */ (point.value))));
    if (notify) opts.onSelect?.(point);
  };
  slider.addEventListener('input', () => inspect(Number(slider.value)));
  /** @param {PointerEvent} event */
  const inspectPointer = (event) => {
    const matrix = /** @type {SVGSVGElement} */ (/** @type {unknown} */ (svg)).getScreenCTM();
    if (!matrix) return;
    const target = new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix.inverse()).x;
    let best = 0; let distance = Infinity;
    entries.forEach((p, index) => { const delta = Math.abs(x(p.time) - target); if (delta < distance) { best = index; distance = delta; } });
    if (best !== selected) inspect(best);
  };
  /** @type {number | null} */
  let pointer = null;
  svg.addEventListener('pointerdown', (event) => {
    if (!event.isPrimary || event.button !== 0) return;
    pointer = event.pointerId;
    svg.setPointerCapture(event.pointerId);
    inspectPointer(event);
  });
  svg.addEventListener('pointermove', (event) => { if (event.pointerId === pointer) inspectPointer(event); });
  for (const event of ['pointerup', 'pointercancel', 'lostpointercapture']) svg.addEventListener(event, () => { pointer = null; });
  const tableBody = h('tbody');
  const table = h('table', {}, h('caption', {}, `${opts.title}, ${opts.unit}, ${opts.timeZone}`), h('thead', {}, h('tr', {}, ['Time', 'Series', `Value (${opts.unit})`, 'Detail'].map((v) => h('th', { scope: 'col' }, v)))), tableBody);
  const previous = h('button', { type: 'button', class: 'btn btn--secondary' }, 'Previous Readings');
  const next = h('button', { type: 'button', class: 'btn btn--secondary' }, 'Next Readings');
  const pageLabel = h('span', { role: 'status' }); let page = 0;
  const drawTable = () => {
    clear(tableBody);
    tableBody.append(...entries.slice(page * 50, (page + 1) * 50).map((p) => h('tr', {}, h('th', { scope: 'row' }, p.label ?? formatAsOf(p.time, opts.timeZone)), h('td', {}, p.series), h('td', {}, number(/** @type {number} */ (p.value))), h('td', {}, p.detail ?? ''))));
    previous.toggleAttribute('disabled', page === 0); next.toggleAttribute('disabled', (page + 1) * 50 >= entries.length);
    pageLabel.textContent = `Readings ${page * 50 + 1} to ${Math.min((page + 1) * 50, entries.length)} of ${entries.length}`;
  };
  previous.addEventListener('click', () => { page--; drawTable(); }); next.addEventListener('click', () => { page++; drawTable(); }); drawTable();
  host.append(svg, readout, label, h('p', { class: 'chart-help' }, `Tap or drag across the graph, or use the slider arrow keys. Times are ${opts.timeZone}. ${opts.discrete ? 'Each symbol is one published forecast period, not an hourly temperature reading.' : opts.bars ? 'Each bar is a published period total.' : 'Lines join source readings; gaps are not filled.'}`), h('details', { class: 'chart-data' }, h('summary', {}, 'View Every Chart Value as a Table'), h('div', { class: 'table-wrap', tabindex: 0, role: 'region', 'aria-label': `${opts.title} values` }, table), h('div', { class: 'chart-controls' }, previous, pageLabel, next)));
  const start = opts.selectedTime ? entries.findIndex((p) => p.time === opts.selectedTime) : -1;
  inspect(start >= 0 ? start : 0, false);
}
