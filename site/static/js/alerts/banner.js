// @ts-check
/**
 * Banner computation: none only when every required source is live and complete (blueprint 3.8).
 * ui/alert-banner.js renders it. DOM-free.
 *
 * Rule 1: 'none' requires EVERY required source for the scope to be live AND complete.
 * Rule 2: zero alerts with any required source not live and complete gives 'unknown'.
 * Rule 3: alerts present with any source not live gives counts plus a qualifier; alerts are never hidden.
 * Rule 4: copy names the strongest designation present and every count.
 */
import { formatAsOf, formatTime } from '../core/time.js';
import { sortAlerts } from './model.js';
import { isExpired } from './lifecycle.js';

/** @typedef {import('../types.js').StatusSnapshot} StatusSnapshot */
/** @typedef {import('../types.js').DashboardAlert} DashboardAlert */
/** @typedef {import('../types.js').AlertScope} AlertScope */
/** @typedef {import('../types.js').Banner} Banner */
/** @typedef {import('../types.js').Designation} Designation */
/** @typedef {import('../types.js').ActionPosture} ActionPosture */

export const NWS_ID = 'nws-alerts-active';
export const ECCC_ID = 'eccc-geomet-weather-alerts';
export const BC_RFC_ID = 'bc-rfc-flood-advisories';

/** @type {readonly Designation[]} */
export const DESIGNATION_ORDER = Object.freeze(/** @type {Designation[]} */ (['emergency', 'warning', 'watch', 'advisory', 'statement', 'other']));

/** @type {Readonly<Record<Designation, [string, string]>>} */
const DESIGNATION_WORDS = Object.freeze({
  emergency: ['emergency', 'emergencies'],
  warning: ['warning', 'warnings'],
  watch: ['watch', 'watches'],
  advisory: ['advisory', 'advisories'],
  statement: ['statement', 'statements'],
  other: ['other alert', 'other alerts'],
});

/** @type {Readonly<Record<string, { full: string, short: string }>>} */
const AGENCY_NAMES = Object.freeze({
  [NWS_ID]: { full: 'National Weather Service', short: 'NWS' },
  [ECCC_ID]: { full: 'Environment and Climate Change Canada', short: 'ECCC' },
  [BC_RFC_ID]: { full: 'BC River Forecast Centre', short: 'BC River Forecast Centre' },
});

/**
 * US Nation: NWS. BC Nation: ECCC (plus BC River Forecast Centre once active). Footprint: NWS and ECCC;
 * a footprint view filtered to jurisdictions requires NWS when any U.S. jurisdiction or marine waters are
 * in the filter and ECCC when British Columbia is.
 * @param {AlertScope} scope
 * @param {{ bcRfcActive?: boolean }} [opts] `bcRfcActive` once the maintainer enables that source (Q8)
 * @returns {string[]}
 */
export function requiredSourcesFor(scope, opts) {
  const bc = opts?.bcRfcActive ? [ECCC_ID, BC_RFC_ID] : [ECCC_ID];
  if (scope.kind === 'nation') {
    const n = scope.nation;
    const isBc = n.country === 'CA' || n.jurisdictions.includes('BC');
    const isUs = n.country === 'US' || n.jurisdictions.some((j) => j !== 'BC' && j !== 'MARINE');
    return [...(isUs ? [NWS_ID] : []), ...(isBc ? bc : [])];
  }
  const js = scope.jurisdictions ?? [];
  if (js.length === 0) return [NWS_ID, ...bc];
  const needsNws = js.some((j) => j !== 'BC');
  const needsBc = js.includes('BC');
  return [...(needsNws ? [NWS_ID] : []), ...(needsBc ? bc : [])];
}

/** @param {StatusSnapshot | undefined} s @returns {boolean} */
function liveAndComplete(s) {
  return s !== undefined && s.state === 'live' && s.completeness === 'complete' && typeof s.asOf === 'string' && !Number.isNaN(Date.parse(s.asOf));
}

/** @param {string[]} times @returns {string | null} */
function oldest(times) {
  const ok = times.filter((t) => !Number.isNaN(Date.parse(t)));
  if (ok.length === 0) return null;
  return ok.reduce((a, b) => (Date.parse(a) <= Date.parse(b) ? a : b));
}

/** @param {DashboardAlert} a @param {Date} now @returns {boolean} */
function isShowable(a, now) {
  return a.lifecycleState === 'active' && a.messageType !== 'cancel' && a.posture !== 'ended' && !isExpired(a, now);
}

/**
 * Rules 1 to 4 of blueprint 3.8. `alerts` are the scoped alerts; anything ended, cancelled, superseded,
 * or past its `ends ?? expires` is ignored here as well, so a stale list can never inflate the counts.
 * @param {DashboardAlert[]} alerts
 * @param {Map<string, StatusSnapshot>} statuses
 * @param {string[]} requiredSourceIds
 * @param {Date} now
 * @returns {Banner}
 */
export function summarizeForBanner(alerts, statuses, requiredSourceIds, now) {
  const shown = alerts.filter((a) => isShowable(a, now));
  const required = [...new Set(requiredSourceIds)];
  const reqStatuses = required.map((id) => statuses.get(id));

  if (shown.length === 0) {
    // Rule 1: an all-clear only with proof from every required source. An empty requirement list is
    // never proof.
    if (required.length > 0 && reqStatuses.every(liveAndComplete)) {
      const asOf = /** @type {string} */ (oldest(reqStatuses.map((s) => /** @type {string} */ (s?.asOf))));
      return { kind: 'none', asOf };
    }
    // Rule 2.
    /** @type {'loading' | 'unavailable' | 'not-current'} */
    let reason = 'not-current';
    if (required.length === 0 || reqStatuses.some((s) => s === undefined)) reason = 'loading';
    else if (reqStatuses.every((s) => s?.state === 'unavailable')) reason = 'unavailable';
    const times = reqStatuses.map((s) => s?.asOf).filter((t) => typeof t === 'string');
    const lastConfirmedAt = times.length === required.length && required.length > 0 ? oldest(/** @type {string[]} */ (times)) : null;
    return { kind: 'unknown', reason, lastConfirmedAt };
  }

  // Rules 3 and 4.
  /** @type {Record<Designation, number>} */
  const counts = { emergency: 0, warning: 0, watch: 0, advisory: 0, statement: 0, other: 0 };
  for (const a of shown) counts[a.designation] += 1;
  /** @type {'act-now' | 'prepare' | 'monitor'} */
  const kind = shown.some((a) => a.posture === 'act-now') ? 'act-now' : shown.some((a) => a.posture === 'prepare') ? 'prepare' : 'monitor';
  const top = /** @type {DashboardAlert} */ (sortAlerts(shown.filter((a) => a.posture === kind))[0]);

  const relevant = new Set([...required, ...shown.map((a) => a.sourceId)]);
  /** @type {null | 'stale' | 'partial' | 'cached'} */
  let qualifier = null;
  const states = [...relevant].map((id) => statuses.get(id));
  if (states.some((s) => s === undefined || s.state === 'degraded' || s.state === 'unavailable' || s.completeness === 'partial')) qualifier = 'partial';
  else if (states.some((s) => s?.state === 'stale')) qualifier = 'stale';
  else if (states.some((s) => s?.state === 'cached')) qualifier = 'cached';
  return { kind, counts, top, qualifier };
}

/** @param {number} n @param {Designation} d @returns {string} */
function countPhrase(n, d) {
  const [one, many] = DESIGNATION_WORDS[d];
  return `${n} ${n === 1 ? one : many}`;
}

/** @param {string[]} items @returns {string} Oxford-comma list */
function listOf(items) {
  if (items.length <= 1) return items.join('');
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(', ')}, and ${items[items.length - 1]}`;
}

/** @param {string[]} ids @param {'full' | 'short'} form @returns {string} */
function agencyList(ids, form) {
  const names = ids.map((id) => AGENCY_NAMES[id]?.[form]).filter((x) => typeof x === 'string');
  if (names.length <= 1) return names.join('');
  return form === 'short' ? names.join(' or ') : listOf(names).replace(/ and ([^,]+)$/, ' or $1');
}

/**
 * House-style copy from the 3.8 table. `requiredSourceIds` names the agencies in the unknown and none
 * copy (default NWS and ECCC); `now` is the time the unknown copy states (default: the last confirmation).
 * @param {Banner} banner
 * @param {{ scopeName: string, timeZone: string, requiredSourceIds?: string[], now?: Date }} opts
 * @returns {{ headline: string, detail: string | null }}
 */
export function bannerCopy(banner, opts) {
  const scope = opts.scopeName;
  const tz = opts.timeZone;
  const required = opts.requiredSourceIds && opts.requiredSourceIds.length > 0 ? opts.requiredSourceIds : [NWS_ID, ECCC_ID];
  if (banner.kind === 'unknown') {
    const agencies = agencyList(required, 'full');
    const at = opts.now ? opts.now.toISOString() : banner.lastConfirmedAt;
    const last = banner.lastConfirmedAt ? ` Last confirmed ${formatAsOf(banner.lastConfirmedAt, tz)}.` : '';
    if (banner.reason === 'loading') {
      return { headline: 'Alert status unknown.', detail: `Checking ${agencies} alerts now. This is not an all-clear.` };
    }
    const when = at ? ` as of ${formatTime(at, tz)}` : '';
    return { headline: 'Alert status unknown.', detail: `${agencies} alerts could not be confirmed${when}. This is not an all-clear.${last}` };
  }
  if (banner.kind === 'none') {
    return {
      headline: `No active ${agencyList(required, 'short')} alerts for ${scope} as of ${formatTime(banner.asOf, tz)}.`,
      detail: 'Absence of an alert is not a guarantee of safety.',
    };
  }
  const present = DESIGNATION_ORDER.filter((d) => banner.counts[d] > 0);
  const qualifier = banner.qualifier ? ' Some sources are not current; see the status below.' : '';
  /** @type {string} */
  let headline;
  /** @type {string[]} */
  const detail = [];
  if (banner.kind === 'monitor') {
    headline = `${listOf(present.map((d) => countPhrase(banner.counts[d], d)))} in effect for ${scope}.`;
  } else {
    const [strongest, ...rest] = present;
    const s = /** @type {Designation} */ (strongest);
    headline = `${countPhrase(banner.counts[s], s)} in effect for ${scope}.`;
    if (rest.length > 0) detail.push(`${listOf(rest.map((d) => countPhrase(banner.counts[d], d)))} also in effect.`);
  }
  if (banner.top.band === 'extreme') {
    const area = banner.top.areaDesc ?? scope;
    headline = `${banner.top.event} for ${area}. ${headline}`;
  }
  const text = `${detail.join(' ')}${qualifier}`.trim();
  return { headline, detail: text === '' ? null : text };
}
