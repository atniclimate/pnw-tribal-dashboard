// @ts-check
/**
 * Renders the Banner in an aria-live="polite" region (blueprint 3.8). DOM module.
 *
 * Owner: lane L10. Copy and quiet-state eligibility come from the shared alert model.
 */

/** @typedef {import('../types.js').Banner} Banner */

import { h } from '../core/dom.js';
import { bannerCopy } from '../alerts/banner.js';
import { linkWithState } from '../core/url-state.js';

/**
 * Copy from alerts/banner.js bannerCopy; never green; unknown is never an all-clear.
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
  const alert = banner.kind !== 'none' && banner.kind !== 'unknown' ? banner.top : null;
  if (alert) el.dataset.band = alert.band; else delete el.dataset.band;
  el.replaceChildren(h('p', { class: 'dashboard-banner__headline alert-banner__headline' }, copy.headline),
    copy.detail ? h('p', { class: 'alert-banner__detail' }, copy.detail) : h('span', {}),
    h('div', { class: 'dashboard-actions' },
      h('a', { class: 'btn btn--secondary', href: linkWithState('./alerts/') }, 'All Alerts'),
      h('a', { class: 'btn btn--secondary', href: linkWithState('./safety/') }, 'What to Do')));
}
