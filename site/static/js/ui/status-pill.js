// @ts-check
/** Five status shapes with word labels; color belongs to the shape. Markup and STATUS_SHAPES must match core/provenance.js, which cannot import ui/. See DESIGN.md for the class contract. */

/** @typedef {import('../types.js').StatusState} StatusState */

const SVG = 'http://www.w3.org/2000/svg';

/** Default words, matching core/provenance.js. */
export const STATUS_LABELS = Object.freeze(/** @type {Record<StatusState, string>} */ ({
  live: 'Live',
  cached: 'Saved on Device',
  stale: 'Stale',
  degraded: 'Degraded',
  unavailable: 'Unavailable',
}));

/** Shapes in a 12-unit box: [tag, class, attributes]. `fill` parts take the color; `line` parts stroke it. */
/** @type {Readonly<Record<StatusState, readonly (readonly [string, 'fill' | 'line', Record<string, string>])[]>>} */
export const STATUS_SHAPES = Object.freeze({
  live: [['circle', 'fill', { cx: '6', cy: '6', r: '5.5' }]],
  cached: [['circle', 'line', { cx: '6', cy: '6', r: '4.75' }], ['circle', 'fill', { cx: '6', cy: '6', r: '2' }]],
  stale: [['circle', 'line', { cx: '6', cy: '6', r: '4.75' }], ['path', 'fill', { d: 'M6 1.25 A4.75 4.75 0 0 0 6 10.75 Z' }]],
  degraded: [['polygon', 'line', { points: '6,1.5 11,10.75 1,10.75' }]],
  unavailable: [['circle', 'line', { cx: '6', cy: '6', r: '4.75' }], ['line', 'line', { x1: '2.6', y1: '9.4', x2: '9.4', y2: '2.6' }]],
});

const STATES = /** @type {StatusState[]} */ (Object.keys(STATUS_SHAPES));

/**
 * @param {unknown} state
 * @returns {StatusState}
 */
function known(state) {
  return STATES.includes(/** @type {StatusState} */ (state)) ? /** @type {StatusState} */ (state) : 'unavailable';
}

/**
 * @param {StatusState} state
 * @returns {SVGSVGElement}
 */
function shape(state) {
  const svg = /** @type {SVGSVGElement} */ (document.createElementNS(SVG, 'svg'));
  svg.setAttribute('class', 'status-pill__shape');
  svg.setAttribute('viewBox', '0 0 12 12');
  svg.setAttribute('width', '12');
  svg.setAttribute('height', '12');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  for (const [tag, cls, attrs] of STATUS_SHAPES[state]) {
    const el = document.createElementNS(SVG, tag);
    el.setAttribute('class', cls);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    svg.append(el);
  }
  return svg;
}

/**
 * @param {StatusState} state
 * @param {string} [label] defaults to the state's word
 * @returns {HTMLElement}
 */
export function statusPill(state, label) {
  const el = document.createElement('span');
  updateStatusPill(el, state, label);
  return el;
}

/**
 * Re-renders a pill in place for a new state (the element keeps its identity for live regions).
 * @param {HTMLElement} el
 * @param {StatusState} state
 * @param {string} [label]
 * @returns {void}
 */
export function updateStatusPill(el, state, label) {
  const s = known(state);
  el.className = `status-pill status-pill--${s}`;
  el.dataset.status = s;
  const text = document.createElement('span');
  text.className = 'status-pill__label';
  text.textContent = label && label.trim() ? label : STATUS_LABELS[s];
  el.replaceChildren(shape(s), text);
}
