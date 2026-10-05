// @ts-check
/**
 * Renders the provenance footer (status pill, source links, "as of" stamp, checked time) in house style
 * (blueprint 3.3). DOM module. The stamp prints in the viewer's zone unless a zone is passed, with the zone
 * abbreviation, and the relative "checked" age never appears without the absolute stamp beside it.
 */
import { clear, h } from './dom.js';
import { formatAsOf, relativeAge } from './time.js';

/** @typedef {import('../types.js').AsOfBasis} AsOfBasis */
/** @typedef {import('../types.js').StatusSnapshot} StatusSnapshot */
/** @typedef {import('../types.js').SourceRecord} SourceRecord */

const STATE_LABEL = Object.freeze({
  live: 'Live', cached: 'Saved on Device', stale: 'Stale', degraded: 'Degraded', unavailable: 'Unavailable',
});

/**
 * Pill shapes of blueprint 9.5 rule 4 in a 12-unit box: [tag, class, attributes]. A copy of STATUS_SHAPES in
 * ui/status-pill.js (core/ may not import ui/); the two must stay identical so a state looks the same
 * everywhere. Live filled circle, Cached circle with inner dot, Stale half-filled circle, Degraded outlined
 * triangle, Unavailable hollow circle with slash. `fill` parts take the color; `line` parts stroke it.
 */
/** @type {Readonly<Record<StatusSnapshot['state'], readonly (readonly [string, 'fill' | 'line', Record<string, string>])[]>>} */
const STATE_SHAPE = Object.freeze({
  live: [['circle', 'fill', { cx: '6', cy: '6', r: '5.5' }]],
  cached: [['circle', 'line', { cx: '6', cy: '6', r: '4.75' }], ['circle', 'fill', { cx: '6', cy: '6', r: '2' }]],
  stale: [['circle', 'line', { cx: '6', cy: '6', r: '4.75' }], ['path', 'fill', { d: 'M6 1.25 A4.75 4.75 0 0 0 6 10.75 Z' }]],
  degraded: [['polygon', 'line', { points: '6,1.5 11,10.75 1,10.75' }]],
  unavailable: [['circle', 'line', { cx: '6', cy: '6', r: '4.75' }], ['line', 'line', { x1: '2.6', y1: '9.4', x2: '9.4', y2: '2.6' }]],
});

/**
 * The stamp verb: "Issued as of", "Observed as of", "Valid as of", "Model run", or "Retrieved".
 * @param {AsOfBasis | null} basis
 * @returns {string}
 */
export function asOfLabel(basis) {
  switch (basis) {
    case 'issued': return 'Issued as of';
    case 'observed': return 'Observed as of';
    case 'valid': return 'Valid as of';
    case 'model-run': return 'Model run';
    case 'retrieved': return 'Retrieved';
    default: return 'As of';
  }
}

/**
 * The status pill, built here because core/ may not import ui/. Same markup as ui/status-pill.js:
 * span.status-pill.status-pill--<state>[data-status] > svg.status-pill__shape + span.status-pill__label.
 * @param {StatusSnapshot['state']} state
 * @returns {HTMLElement}
 */
function pill(state) {
  return h('span', { class: `status-pill status-pill--${state}`, dataset: { status: state } },
    h('svg', { class: 'status-pill__shape', viewBox: '0 0 12 12', width: '12', height: '12', 'aria-hidden': 'true', focusable: 'false' },
      STATE_SHAPE[state].map(([tag, cls, attrs]) => h(tag, { class: cls, ...attrs }))),
    h('span', { class: 'status-pill__label' }, STATE_LABEL[state]));
}

/**
 * Source links in order, then any registry id the page could not resolve, as plain text.
 * @param {StatusSnapshot} status
 * @param {SourceRecord[]} sources
 * @returns {HTMLElement}
 */
function sourceList(status, sources) {
  const known = new Map(sources.map((s) => [s.id, s]));
  /** @type {(Node | string)[]} */
  const items = [];
  for (const id of status.sourceIds) {
    const rec = known.get(id);
    if (items.length) items.push(', ');
    // Source pages are always other sites: open them in a new tab (blueprint 7.12, as core/embed.js does for
    // links present at load), so a footer added after load needs no page-side observer.
    items.push(rec ? h('a', { href: rec.humanUrl, target: '_blank', rel: 'noopener noreferrer' }, rec.attribution || rec.owner) : id);
  }
  return h('span', { class: 'provenance__src' }, status.sourceIds.length === 1 ? 'Source: ' : 'Sources: ', ...items);
}

/**
 * Writes the footer; ui/panel.js calls it after every load so a renderer cannot skip it.
 * @param {HTMLElement} footer the [data-provenance] element
 * @param {StatusSnapshot} status
 * @param {SourceRecord[]} sources
 * @param {{ timeZone?: string, now?: Date }} [opts] zone for the stamp (the viewer's zone by default)
 * @returns {void}
 */
export function renderProvenance(footer, status, sources, opts = {}) {
  const now = opts.now ?? new Date();
  clear(footer);
  footer.setAttribute('data-provenance', '');
  footer.setAttribute('data-status', status.state);
  footer.setAttribute('data-source-ids', status.sourceIds.join(' '));
  const asOf = status.asOf
    ? h('span', { class: 'provenance__asof' }, `${asOfLabel(status.asOfBasis)} `,
      h('time', { datetime: status.asOf }, formatAsOf(status.asOf, opts.timeZone)))
    : h('span', { class: 'provenance__asof' }, 'No data time is available');
  footer.append(
    pill(status.state),
    sourceList(status, sources),
    asOf,
    ...(status.detail ? [h('span', { class: 'provenance__detail' }, status.detail)] : []),
    h('span', { class: 'provenance__checked' }, 'Checked ',
      h('time', { datetime: status.checkedAt, title: formatAsOf(status.checkedAt, opts.timeZone) }, relativeAge(status.checkedAt, now))),
  );
}
