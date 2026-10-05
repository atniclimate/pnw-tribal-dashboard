// @ts-check
/**
 * Sovereignty disclaimer component (blueprint 4.5). Every map and boundary display carries it. DOM module.
 *
 * The note is a sibling of the map frame, never a child of the MapLibre container, so no canvas, control,
 * marker, or popup can cover it, and a switch between interactive and outline mode never removes it.
 *
 * Owner: lane L8.
 */
import { h } from '../core/dom.js';

/** Canonical text from the design system callout (wording ratification Q7). @type {string} */
export const SOVEREIGNTY_HEADLINE = 'Representation, not jurisdiction.';

/** Canonical second sentence (Q7). @type {string} */
export const SOVEREIGNTY_BODY = 'Boundary lines shown here come from public federal sources; they are not a Tribal Nation\'s own statement of its land or authority.';

/** Shown for a Nation that has no published land-area polygon (blueprint 4.5). @type {string} */
export const NO_BOUNDARY_TEXT = 'No land-area boundary is published in the federal sources used here; headquarters location shown.';

let noteCount = 0;

/**
 * @param {{ name: string, vintage: string }[]} datasets
 * @returns {string}
 */
function datasetLine(datasets) {
  if (!datasets.length) return 'Boundary datasets: none are drawn on this map.';
  return `Boundary datasets: ${datasets.map((d) => `${d.name}, ${d.vintage}`).join('; ')}.`;
}

/**
 * Mounts .sovereignty-note directly below the map frame, outside the MapLibre container.
 * @param {HTMLElement} frame
 * @param {{ sourceIds: string[], datasets: { name: string, vintage: string }[] }} opts
 * @returns {HTMLElement}
 */
export function mountSovereigntyNote(frame, opts) {
  if (!opts || !Array.isArray(opts.sourceIds) || opts.sourceIds.length === 0) {
    throw new Error('mountSovereigntyNote needs at least one source id');
  }
  noteCount += 1;
  const note = h('div', {
    class: 'sovereignty-note',
    id: `sovereignty-note-${noteCount}`,
    role: 'note',
    'aria-label': 'Sovereignty statement',
    dataset: { boundaryDisplay: 'map', sourceIds: opts.sourceIds.join(' ') },
  },
  h('p', { class: 'sovereignty-note__text' }, h('strong', {}, SOVEREIGNTY_HEADLINE), ' ', SOVEREIGNTY_BODY),
  h('details', { class: 'sovereignty-note__more' },
    h('summary', {}, 'Boundary Datasets and Vintages'),
    h('p', { class: 'sovereignty-note__datasets' }, datasetLine(opts.datasets ?? []))));
  frame.after(note);
  return note;
}

/**
 * Replaces the dataset line of a mounted note (for example when a Nation's detail file names its vintages).
 * @param {HTMLElement} note
 * @param {{ name: string, vintage: string }[]} datasets
 * @param {string} [extra] one more sentence, such as the no-polygon text
 * @returns {void}
 */
export function setSovereigntyDatasets(note, datasets, extra) {
  const el = note.querySelector('.sovereignty-note__datasets');
  if (el) el.textContent = extra ? `${datasetLine(datasets)} ${extra}` : datasetLine(datasets);
}

/**
 * Compact in-map control at bottom left linking to the full note. A plain IControl object so this module
 * never imports the library.
 * @param {string} [noteId] the id of the mounted note the link targets
 * @returns {import('maplibre-gl').IControl}
 */
export function sovereigntyControl(noteId) {
  /** @type {HTMLElement | null} */
  let el = null;
  return {
    onAdd() {
      el = h('div', { class: 'maplibregl-ctrl cthd-sovereignty-ctrl' },
        h('a', { href: noteId ? `#${noteId}` : '#', class: 'cthd-sovereignty-ctrl__link' }, SOVEREIGNTY_HEADLINE));
      return el;
    },
    onRemove() {
      el?.remove();
      el = null;
    },
    getDefaultPosition() { return 'bottom-left'; },
  };
}

/**
 * Inline callout beside non-map boundary displays.
 * @param {HTMLElement} el
 * @param {{ sourceIds: string[] }} opts
 * @returns {HTMLElement}
 */
export function sovereigntyInline(el, opts) {
  if (!opts || !Array.isArray(opts.sourceIds) || opts.sourceIds.length === 0) {
    throw new Error('sovereigntyInline needs at least one source id');
  }
  const note = h('p', { class: 'sovereignty-note', role: 'note', dataset: { boundaryDisplay: 'inline', sourceIds: opts.sourceIds.join(' ') } },
    h('strong', {}, SOVEREIGNTY_HEADLINE), ' ', SOVEREIGNTY_BODY);
  el.append(note);
  return note;
}
