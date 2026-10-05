// @ts-check
/**
 * Hand-written SVG QPF bars with amounts and probability printed (blueprint 2.3, 7.3). DOM module.
 * Colors come from the page's ink (currentColor), so the chart follows the theme with no values of its own.
 * Every number is printed on the chart, never only implied by a bar's height.
 */
import { h } from '../../core/dom.js';
import { formatPrecipitation } from '../../core/units.js';

/** @typedef {import('../../types.js').QpfDay} QpfDay */

const SVG_NS = 'http://www.w3.org/2000/svg';
const COLUMN = 76;
const PLOT_TOP = 34;
const PLOT_HEIGHT = 150;
const HEIGHT = 250;

/**
 * @param {QpfDay} day
 * @param {'us' | 'metric' | 'native'} system
 * @returns {string}
 */
export function amountText(day, system) {
  return system === 'us'
    ? formatPrecipitation(day.amountIn, 'in', 'us')
    : formatPrecipitation(day.amountMm, 'mm', system === 'metric' ? 'metric' : 'native');
}

/**
 * @param {QpfDay} day
 * @returns {string}
 */
export function probabilityText(day) {
  return day.maxPop === null ? 'No probability' : `${day.maxPop}% chance`;
}

/**
 * One sentence per day, for the chart's accessible name and the text table.
 * @param {QpfDay[]} days
 * @param {{ system: 'us' | 'metric' | 'native' }} opts
 * @returns {string[]}
 */
export function qpfSummary(days, opts) {
  return days.map((d) => `${d.label} ${d.dayKey}${d.partial ? ' (partial day)' : ''}: ${amountText(d, opts.system)}, ${probabilityText(d)}`);
}

/**
 * @param {string} text
 * @param {Record<string, string | number>} attrs
 * @returns {SVGTextElement}
 */
function svgText(text, attrs) {
  const t = /** @type {SVGTextElement} */ (document.createElementNS(SVG_NS, 'text'));
  for (const [k, v] of Object.entries(attrs)) t.setAttribute(k, String(v));
  t.textContent = text;
  return t;
}

/**
 * @param {QpfDay[]} days
 * @param {{ system: 'us' | 'metric' | 'native' }} opts
 * @returns {SVGSVGElement}
 */
export function qpfBars(days, opts) {
  const width = Math.max(1, days.length) * COLUMN;
  const values = days.map((d) => (opts.system === 'us' ? d.amountIn : d.amountMm));
  const max = Math.max(...values, opts.system === 'us' ? 0.1 : 2.5);
  const svg = /** @type {SVGSVGElement} */ (/** @type {unknown} */ (h('svg', {
    class: 'qpf-bars', viewBox: `0 0 ${width} ${HEIGHT}`, width: '100%', role: 'img', preserveAspectRatio: 'xMidYMid meet',
    'aria-label': `Daily precipitation forecast. ${qpfSummary(days, opts).join('. ')}.`, 'data-chart': 'qpf-bars',
  })));
  svg.append(h('title', {}, 'Daily precipitation forecast'));
  svg.append(h('line', { x1: 0, y1: PLOT_TOP + PLOT_HEIGHT, x2: width, y2: PLOT_TOP + PLOT_HEIGHT, stroke: 'currentColor', 'stroke-opacity': 0.6, 'stroke-width': 1 }));
  days.forEach((d, i) => {
    const x = i * COLUMN;
    const v = values[i] ?? 0;
    const barH = v > 0 ? Math.max(2, (v / max) * PLOT_HEIGHT) : 0;
    const cx = x + COLUMN / 2;
    const g = h('g', { 'data-day': d.dayKey });
    if (barH > 0) {
      g.append(h('rect', {
        x: x + 14, y: PLOT_TOP + PLOT_HEIGHT - barH, width: COLUMN - 28, height: barH, fill: 'currentColor', 'fill-opacity': d.partial ? 0.2 : 0.35,
        stroke: 'currentColor', 'stroke-width': 2, ...(d.partial ? { 'stroke-dasharray': '4 3' } : {}),
      }));
    } else {
      g.append(h('line', { x1: x + 14, y1: PLOT_TOP + PLOT_HEIGHT - 1, x2: x + COLUMN - 14, y2: PLOT_TOP + PLOT_HEIGHT - 1, stroke: 'currentColor', 'stroke-width': 3 }));
    }
    g.append(svgText(amountText(d, opts.system), { x: cx, y: PLOT_TOP + PLOT_HEIGHT - barH - 8, 'text-anchor': 'middle', 'font-size': 14, 'font-weight': 600, fill: 'currentColor', 'font-family': 'inherit' }));
    g.append(svgText(d.label, { x: cx, y: PLOT_TOP + PLOT_HEIGHT + 20, 'text-anchor': 'middle', 'font-size': 14, 'font-weight': 600, fill: 'currentColor', 'font-family': 'inherit' }));
    g.append(svgText(d.maxPop === null ? 'No probability' : `${d.maxPop}%`, { x: cx, y: PLOT_TOP + PLOT_HEIGHT + 40, 'text-anchor': 'middle', 'font-size': 13, fill: 'currentColor', 'font-family': 'inherit' }));
    if (d.partial) g.append(svgText('partial day', { x: cx, y: PLOT_TOP + PLOT_HEIGHT + 57, 'text-anchor': 'middle', 'font-size': 11, fill: 'currentColor', 'font-family': 'inherit' }));
    svg.append(g);
  });
  return svg;
}
