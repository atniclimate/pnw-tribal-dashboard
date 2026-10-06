// @ts-check
/**
 * Summary tiles by designation with band breakdown; real buttons with aria-pressed (blueprint 7.2). DOM module.
 *
 * Unknown source coverage is never presented as a zero count.
 */

/** @typedef {import('../types.js').Designation} Designation */
/** @typedef {import('../types.js').DashboardAlert} DashboardAlert */

import { h } from '../core/dom.js';

const DESIGNATIONS = /** @type {[Designation, string][]} */ ([
  ['emergency', 'Emergencies'], ['warning', 'Warnings'], ['watch', 'Watches'],
  ['advisory', 'Advisories'], ['statement', 'Statements'], ['other', 'Other Alerts'],
]);
const BANDS = ['extreme', 'severe', 'moderate', 'minor', 'unstated'];

/**
 * @param {HTMLElement} el
 * @param {DashboardAlert[]} alerts
 * @param {{ onFilter: (designation: Designation | null) => void, selected?: Designation | null, unknown?: boolean }} opts
 * @returns {void}
 */
export function renderSummaryTiles(el, alerts, opts) {
  const list = h('ul', { class: 'summary-tiles', 'aria-label': 'Filter Alerts by Designation' });
  for (const [designation, label] of DESIGNATIONS) {
    const matching = alerts.filter((alert) => alert.designation === designation);
    if (designation === 'other' && matching.length === 0 && opts.selected !== designation) continue;
    const unknown = opts.unknown && matching.length === 0;
    const breakdown = BANDS.map((band) => {
      const count = matching.filter((alert) => alert.band === band).length;
      return count ? `${count} ${band}` : '';
    }).filter(Boolean).join(', ');
    const selected = opts.selected === designation;
    const button = h('button', {
      type: 'button', class: `summary-tile${unknown ? ' summary-tile--unknown' : matching.length === 0 ? ' summary-tile--zero' : ''}`,
      'aria-pressed': String(selected), 'data-designation': designation,
    }, h('span', { class: 'summary-tile__value' }, unknown ? 'Unknown' : String(matching.length)),
    h('span', { class: 'summary-tile__label' }, label), breakdown ? h('span', { class: 'caption' }, breakdown) : null);
    button.addEventListener('click', () => opts.onFilter(selected ? null : designation));
    list.append(h('li', {}, button));
  }
  el.replaceChildren(list);
}
