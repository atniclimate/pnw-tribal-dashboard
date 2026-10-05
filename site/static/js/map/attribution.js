// @ts-check
/**
 * Always-visible attribution lines from registry records (blueprint 4.3). DOM module.
 *
 * Owner: lane L8.
 */
import { h } from '../core/dom.js';

/** @typedef {import('../types.js').SourceRecord} SourceRecord */

/**
 * One line per distinct attribution string, in the order the source ids are given. A source the lookup
 * does not know is skipped, never invented.
 * @param {string[]} sourceIds
 * @param {(id: string) => SourceRecord | null | undefined} lookup
 * @returns {string[]}
 */
export function attributionLines(sourceIds, lookup) {
  /** @type {string[]} */
  const lines = [];
  for (const id of sourceIds) {
    let rec;
    try { rec = lookup(id); } catch { rec = null; }
    const text = rec?.attribution?.trim();
    if (text && !lines.includes(text)) lines.push(text);
  }
  return lines;
}

/**
 * Used by outline mode; the interactive map uses AttributionControl with compact false.
 * Inserted after the sovereignty note when there is one (otherwise after `frame`); an earlier attribution
 * line for the same frame is replaced.
 * @param {HTMLElement} frame
 * @param {string[]} lines
 * @returns {HTMLElement}
 */
export function mountAttribution(frame, lines) {
  const el = h('p', { class: 'map-attribution' }, lines.join(' '));
  const parent = frame.parentElement;
  const old = parent?.querySelector(':scope > .map-attribution');
  if (old) { old.replaceWith(el); return el; }
  const next = frame.nextElementSibling;
  if (next?.classList.contains('sovereignty-note')) next.after(el); else frame.after(el);
  return el;
}
