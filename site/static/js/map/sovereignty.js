// @ts-check
/**
 * Sovereignty disclaimer component (blueprint 4.5). Every map and boundary display carries it. DOM module.
 *
 * STUB (lane L0). Owner: lane L8. Signatures are the contract; bodies throw until the owner implements them.
 */
const NOT_IMPLEMENTED = 'not implemented';

/** Canonical text from the design system callout (wording ratification Q7). @type {string} */
export const SOVEREIGNTY_HEADLINE = 'Representation, not jurisdiction.';

/** Canonical second sentence (Q7). @type {string} */
export const SOVEREIGNTY_BODY = 'Boundary lines shown here come from public federal sources; they are not a Tribal Nation\'s own statement of its land or authority.';

/**
 * Mounts .sovereignty-note directly below the map frame, outside the MapLibre container.
 * @param {HTMLElement} frame
 * @param {{ sourceIds: string[], datasets: { name: string, vintage: string }[] }} opts
 * @returns {HTMLElement}
 */
export function mountSovereigntyNote(frame, opts) {
  throw new Error(NOT_IMPLEMENTED);
}

/**
 * Compact in-map control at bottom left linking to the full note.
 * @returns {import('maplibre-gl').IControl}
 */
export function sovereigntyControl() {
  throw new Error(NOT_IMPLEMENTED);
}

/**
 * Inline callout beside non-map boundary displays.
 * @param {HTMLElement} el
 * @param {{ sourceIds: string[] }} opts
 * @returns {HTMLElement}
 */
export function sovereigntyInline(el, opts) {
  throw new Error(NOT_IMPLEMENTED);
}
