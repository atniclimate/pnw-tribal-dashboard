// @ts-check
/** ECCC publishes named periods. Plot their numbers on an ordinal axis, never invented timestamps. */
import { clear, h } from '../core/dom.js';
import { formatTemperature } from '../core/units.js';

/** @typedef {import('../forecast/eccc-citypage.js').CityPeriod} CityPeriod */
/** @param {CityPeriod['temperatures'][number]} reading @param {'us'|'metric'|'native'} system */
function valueOf(reading, system) {
  if (system === 'us' && reading.unit === 'C') return reading.value * 9 / 5 + 32;
  if (system !== 'us' && reading.unit === 'F') return (reading.value - 32) * 5 / 9;
  return reading.value;
}
/** @param {CityPeriod} period @param {'us'|'metric'|'native'} system */
const readingText = (period, system) => period.temperatures.map((r) => `${r.kind}: ${formatTemperature(r.value, r.unit, system)}`).join(', ') || 'Temperature not supplied';

/** @param {string} value @param {Record<string, string | number>} attrs */
function svgText(value, attrs) {
  const node = document.createElementNS('http://www.w3.org/2000/svg', 'text');
  for (const [key, attr] of Object.entries(attrs)) node.setAttribute(key, String(attr));
  node.textContent = value;
  return node;
}

/** @param {HTMLElement} host @param {CityPeriod[]} periods @param {'us'|'metric'|'native'} initialSystem @param {import('./forecast-explorer.js').ForecastControls} [opts] */
export function renderBcForecastExplorer(host, periods, initialSystem, opts = {}) {
  let system = initialSystem === 'us' ? 'us' : 'metric';
  let range = opts.state?.().range === '3' ? '3' : '7';
  let selected = Math.max(0, periods.findIndex((_, index) => `bc:${index}` === opts.state?.().period));
  const draw = () => {
    clear(host);
    const shown = periods.slice(0, range === '3' ? 6 : periods.length);
    selected = Math.min(selected, Math.max(shown.length - 1, 0));
    const controls = h('div', { class: 'chart-controls' });
    /** @param {string} label @param {[string,string][]} options @param {string} value @param {(value:string)=>void} change */
    function select(label, options, value, change) {
      const input = /** @type {HTMLSelectElement} */ (h('select', { 'aria-label': label }, options.map(([key, name]) => h('option', { value: key, selected: key === value }, name))));
      input.addEventListener('change', () => { change(input.value); draw(); /** @type {HTMLElement|null} */ (host.querySelector(`select[aria-label="${label}"]`))?.focus(); });
      controls.append(h('label', {}, label, input));
    }
    select('Forecast Time Range', [['3', 'Next Six Periods'], ['7', 'Full Outlook']], range, (value) => { range = value; opts.onChange?.({ range }); });
    select('Forecast Units', [['metric', 'Celsius'], ['us', 'Fahrenheit']], system, (value) => { system = value; opts.onChange?.({ units: value }); });
    const cards = h('div', { class: 'forecast-periods', 'aria-label': 'Choose a Forecast Period' });
    const detail = h('section', { class: 'forecast-selected', 'data-forecast-selected': '', 'aria-live': 'polite' });
    const chart = h('div', { class: 'interactive-chart' });
    const compact = host.clientWidth > 0 && host.clientWidth < 500;
    const width = compact ? 380 : 600; const left = 48; const right = width - 22;
    const svg = h('svg', { viewBox: `0 0 ${width} 292`, class: 'time-series-chart', 'data-chart': 'bc-periods', role: 'img', 'aria-label': 'ECCC Forecast Temperatures by Published Period. Use the period slider or table for exact values.' });
    const cursor = h('line', { class: 'chart-cursor', y1: 20, y2: 228 });
    const slider = /** @type {HTMLInputElement} */ (h('input', { type: 'range', min: 0, max: Math.max(0, shown.length - 1), step: 1, value: selected, class: 'chart-inspector', 'aria-label': 'Inspect ECCC Forecast Period' }));
    const x = (/** @type {number} */ index) => left + index / Math.max(shown.length - 1, 1) * (right - left);
    /** @param {number} index @param {boolean} [notify] */
    function choose(index, notify = true) {
      selected = index; const period = shown[selected]; if (!period) return;
      slider.value = String(selected); slider.setAttribute('aria-valuetext', `${period.name}. ${readingText(period, /** @type {'us'|'metric'} */ (system))}`);
      cursor.setAttribute('x1', String(x(index))); cursor.setAttribute('x2', String(x(index)));
      for (const button of cards.querySelectorAll('button')) button.setAttribute('aria-pressed', String(button.dataset.period === `bc:${index}`));
      clear(detail); detail.append(h('h3', {}, period.name), h('p', { class: 'readout' }, readingText(period, /** @type {'us'|'metric'} */ (system))), h('p', {}, period.summary));
      if (notify) opts.onChange?.({ period: `bc:${index}`, day: undefined });
    }
    shown.forEach((period, index) => {
      const button = h('button', { type: 'button', class: 'forecast-period', 'data-period': `bc:${index}`, 'aria-pressed': String(index === selected) }, h('strong', {}, period.name), h('span', { class: 'forecast-period__value' }, readingText(period, /** @type {'us'|'metric'} */ (system))));
      button.addEventListener('click', () => choose(index)); cards.append(button);
    });
    const values = shown.flatMap((period) => period.temperatures.map((r) => valueOf(r, /** @type {'us'|'metric'} */ (system))));
    if (values.length) {
      const min = Math.min(...values) - 2; const max = Math.max(...values) + 2;
      const y = (/** @type {number} */ value) => 228 - (value - min) / (max - min) * 198;
      for (let i = 0; i <= 4; i++) {
        const value = min + (max - min) * i / 4;
        svg.append(h('line', { x1: left, x2: right, y1: y(value), y2: y(value), class: 'chart-grid' }), svgText(String(Math.round(value)), { x: left - 8, y: y(value) + 4, 'text-anchor': 'end', class: 'chart-axis' }));
      }
      svg.append(svgText(system === 'us' ? '°F' : '°C', { x: left, y: 16, class: 'chart-axis' }));
      shown.forEach((period, index) => {
        for (const r of period.temperatures) svg.append(h('circle', { cx: x(index), cy: y(valueOf(r, /** @type {'us'|'metric'} */ (system))), r: 5, class: 'chart-selected' }));
        if (index === 0 || index === shown.length - 1 || index === Math.floor(shown.length / 2)) {
          const label = svgText('', { x: x(index), y: 253, 'text-anchor': index === 0 ? 'start' : index === shown.length - 1 ? 'end' : 'middle', class: 'chart-axis' });
          const words = compact ? period.name.split(/\s+/) : [period.name];
          words.forEach((word, line) => {
            const span = document.createElementNS('http://www.w3.org/2000/svg', 'tspan');
            span.setAttribute('x', String(x(index))); span.setAttribute('dy', line === 0 ? '0' : '16'); span.textContent = word; label.append(span);
          });
          svg.append(label);
        }
      });
      svg.append(cursor);
      svg.addEventListener('pointerdown', (event) => {
        const matrix = /** @type {SVGSVGElement} */ (/** @type {unknown} */ (svg)).getScreenCTM();
        if (!matrix) return;
        const point = new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix.inverse());
        choose(Math.max(0, Math.min(shown.length - 1, Math.round((point.x - left) / (right - left) * (shown.length - 1)))));
      });
      chart.append(svg);
    } else chart.append(h('p', {}, 'This source copy supplies no numeric temperatures. The forecast text remains available.'));
    slider.addEventListener('input', () => choose(Number(slider.value)));
    const table = h('table', { 'data-forecast-periods': '' }, h('caption', {}, 'ECCC Published Forecast Periods'), h('thead', {}, h('tr', {}, h('th', { scope: 'col' }, 'Period'), h('th', { scope: 'col' }, 'Temperature'), h('th', { scope: 'col' }, 'Forecast'))),
      h('tbody', {}, shown.map((p) => h('tr', {}, h('th', { scope: 'row' }, p.name), h('td', {}, readingText(p, /** @type {'us'|'metric'} */ (system))), h('td', {}, p.summary)))));
    host.append(controls, chart, h('label', { class: 'chart-inspector-label' }, 'Inspect a Forecast Period', slider), h('p', { class: 'chart-help' }, 'Tap a point or use the slider arrow keys. Periods follow ECCC’s published order; their spacing does not imply exact hours. Points are supplied forecast highs or lows, not observations.'), cards, detail,
      h('details', { class: 'chart-data' }, h('summary', {}, 'Full Forecast as a Table'), h('div', { class: 'table-wrap', tabindex: 0, role: 'region', 'aria-label': 'ECCC Forecast Table' }, table)));
    choose(selected, false);
  };
  draw();
}
