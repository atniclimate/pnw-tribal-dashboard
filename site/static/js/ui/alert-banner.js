// @ts-check
/**
 * Renders the Banner in an aria-live="polite" region (blueprint 3.8). DOM module.
 *
 * Owner: lane L10. Copy and quiet-state eligibility come from the shared alert model.
 */

/** @typedef {import('../types.js').Banner} Banner */

import { h } from '../core/dom.js';
import { DESIGNATION_ORDER, bannerCopy } from '../alerts/banner.js';
import { linkWithState } from '../core/url-state.js';
import { formatAsOf } from '../core/time.js';
import { endsAtOf } from './alert-card.js';

/** The posture word stands in when the leading designation is the catch-all "other". */
const POSTURE = /** @type {Record<string, string>} */ ({ 'act-now': 'act now', prepare: 'prepare', monitor: 'monitor' });

/**
 * Copy from alerts/banner.js bannerCopy; never green; unknown is never an all-clear. The large state word
 * (decorative, aria-hidden) names the same designation the headline leads with.
 * @param {HTMLElement} el
 * @param {Banner} banner
 * @param {{ scopeName: string, timeZone: string, requiredSourceIds?: string[] }} opts
 * @returns {void}
 */
export function renderAlertBanner(el, banner, opts) {
  const copy = bannerCopy(banner, opts);
  if (el.dataset.banner) el.classList.remove(`alert-banner--${el.dataset.banner}`);
  el.dataset.banner = banner.kind;
  el.classList.add('dashboard-banner', 'alert-banner', `alert-banner--${banner.kind}`);
  const active = banner.kind !== 'none' && banner.kind !== 'unknown' ? banner : null;
  const alert = active ? active.top : null;
  if (alert) el.dataset.band = alert.band; else delete el.dataset.band;
  const lead = active ? DESIGNATION_ORDER.find((d) => active.counts[d] > 0) : null;
  const mark = !alert ? (banner.kind === 'none' ? 'none active' : 'unknown') : lead && lead !== 'other' ? lead : POSTURE[banner.kind];
  // Extreme headlines already name the event; the line then carries only the end time.
  const ends = alert ? endsAtOf(alert) : null;
  const extreme = alert?.band === 'extreme';
  const event = alert && (!extreme || ends) ? h('p', { class: 'alert-banner__event' },
    extreme ? '' : alert.event, ends ? `${extreme ? 'Until' : ' until'} ${formatAsOf(ends, opts.timeZone)}` : '') : null;
  el.replaceChildren(h('p', { class: 'alert-banner__mark', 'aria-hidden': 'true' }, mark ?? 'alert'),
    h('p', { class: 'dashboard-banner__headline alert-banner__headline' }, copy.headline),
    ...(event ? [event] : []), ...(copy.detail ? [h('p', { class: 'alert-banner__detail' }, copy.detail)] : []),
    h('div', { class: 'dashboard-actions' },
      h('a', { class: 'btn btn--secondary', href: linkWithState('./alerts/') }, 'All Alerts'),
      h('a', { class: 'btn btn--secondary', href: linkWithState('./safety/') }, 'What to Do')));
}
