// @ts-check
/** A device time-zone warning is separate from source freshness; it never changes observed timestamps. */
import { h } from '../core/dom.js';
import { checkTimeZoneData } from '../core/time.js';

/**
 * Show the startup warning only when the device fails the known-rule check. Call from initChrome.
 * No network request, persistence, or local-time correction is performed.
 * @param {HTMLElement | null} [container]
 * @param {import('../core/time.js').TimeZoneDataIssue[]} [issues]
 * @returns {() => void}
 */
export function initTimeWarning(container = document.querySelector('main'), issues = checkTimeZoneData()) {
  if (!container || issues.length === 0) return () => {};
  const regions = issues.map((issue) => issue.region).join(' and ');
  const warning = h('aside', {
    class: 'callout callout--note', role: 'status', 'data-time-zone-warning': '',
    'aria-label': 'Local time accuracy',
  },
  h('h2', {}, 'Local time accuracy is limited'),
  h('p', {}, `This browser's time zone data does not match the current rules for ${regions}. Local times on or after 11/01/2026 may be incorrect. A browser and operating system update may resolve this issue. Official source notices remain the reference for alert timing.`));
  container.prepend(warning);
  return () => warning.remove();
}
