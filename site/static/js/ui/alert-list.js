// @ts-check
/**
 * Alert list with grouping and a polite live region for count changes (blueprint 7.2). DOM module.
 *
 * The filtering and counting helpers are pure and import in Node, so the same rules are unit tested: filters
 * read registry fields (region codes, hazard categories, designation, band, posture, agency), values within
 * one filter combine with OR, and different filters combine with AND. Tsunami notices (National Tsunami
 * Warning Center products) are pinned above every group. With a Nation selected, cards group as "For This
 * Nation," "Nearby," and "Elsewhere in Cascadia"; otherwise by jurisdiction.
 *
 * Owner: lane L11.
 */
import { h } from '../core/dom.js';
import { sortAlerts } from '../alerts/model.js';
import { groupForNation } from '../alerts/relevance.js';
import { alertCard, expandCard } from './alert-card.js';

/** @typedef {import('../types.js').DashboardAlert} DashboardAlert */
/** @typedef {import('../types.js').DashboardAlertIndexEntry} DashboardAlertIndexEntry */
/** @typedef {import('../types.js').NationRecord} NationRecord */
/** @typedef {import('../types.js').StatusSnapshot} StatusSnapshot */
/** @typedef {import('../types.js').AlertLanguageBlock} AlertLanguageBlock */
/** @typedef {import('../types.js').FemaDeclaration} FemaDeclaration */
/** @typedef {import('../types.js').CuratedDeclaration} CuratedDeclaration */
/** @typedef {import('../types.js').UrlStateSchema} UrlStateSchema */
/**
 * @typedef {{ j?: string[] | undefined, hz?: string[] | undefined, des?: string[] | undefined, band?: string[] | undefined, posture?: string[] | undefined, src?: string[] | undefined, only?: boolean }} AlertFilters
 */

/** Filter keys in the query string and the field each reads (blueprint 3.5). */
export const ALERT_FILTER_KEYS = Object.freeze(['j', 'hz', 'des', 'band', 'posture', 'src']);

/** Region codes (`j=`), in display order. */
export const REGION_OPTIONS = Object.freeze([
  { value: 'wa', label: 'Washington', jurisdiction: 'WA' },
  { value: 'or', label: 'Oregon', jurisdiction: 'OR' },
  { value: 'id', label: 'Idaho', jurisdiction: 'ID' },
  { value: 'bc', label: 'British Columbia', jurisdiction: 'BC' },
  { value: 'ca-n', label: 'Northern California', jurisdiction: 'CA-N' },
  { value: 'mt-w', label: 'Western Montana', jurisdiction: 'MT-W' },
  { value: 'nv-n', label: 'Northern Nevada', jurisdiction: 'NV-N' },
  { value: 'ak-se', label: 'Southeast Alaska', jurisdiction: 'AK-SE' },
  { value: 'marine', label: 'Marine Waters', jurisdiction: 'MARINE' },
]);

export const HAZARD_OPTIONS = Object.freeze([
  { value: 'flood', label: 'Flood' },
  { value: 'coastal', label: 'Coastal' },
  { value: 'rain-landslide', label: 'Rain and Landslide' },
  { value: 'wind', label: 'Wind' },
  { value: 'winter', label: 'Winter' },
  { value: 'cold', label: 'Cold' },
  { value: 'heat', label: 'Heat' },
  { value: 'fire', label: 'Fire' },
  { value: 'smoke-air', label: 'Smoke and Air Quality' },
  { value: 'marine', label: 'Marine' },
  { value: 'tsunami', label: 'Tsunami' },
  { value: 'avalanche', label: 'Avalanche' },
  { value: 'geologic', label: 'Geologic' },
  { value: 'evacuation', label: 'Evacuation' },
  { value: 'other', label: 'Other' },
]);

export const DESIGNATION_OPTIONS = Object.freeze([
  { value: 'emergency', label: 'Emergency' },
  { value: 'warning', label: 'Warning' },
  { value: 'watch', label: 'Watch' },
  { value: 'advisory', label: 'Advisory' },
  { value: 'statement', label: 'Statement' },
  { value: 'other', label: 'Other' },
]);

export const BAND_OPTIONS = Object.freeze([
  { value: 'extreme', label: 'Extreme' },
  { value: 'severe', label: 'Severe' },
  { value: 'moderate', label: 'Moderate' },
  { value: 'minor', label: 'Minor' },
  { value: 'unstated', label: 'Unstated' },
]);

export const POSTURE_OPTIONS = Object.freeze([
  { value: 'act-now', label: 'Act Now' },
  { value: 'prepare', label: 'Prepare' },
  { value: 'monitor', label: 'Monitor' },
]);

export const SOURCE_OPTIONS = Object.freeze([
  { value: 'nws', label: 'National Weather Service' },
  { value: 'eccc', label: 'Environment and Climate Change Canada' },
  { value: 'ntwc', label: 'National Tsunami Warning Center' },
  { value: 'bc-rfc', label: 'BC River Forecast Centre' },
]);

/**
 * Lowercase region codes an alert belongs to: its jurisdictions (from UGC prefixes and the source, never
 * from area text), plus the region a marine zone maps to through `marineToRegion`.
 * @param {DashboardAlert | DashboardAlertIndexEntry} alert
 * @param {Record<string, string> | null | undefined} marineToRegion
 * @returns {Set<string>}
 */
export function regionsOfAlert(alert, marineToRegion) {
  /** @type {Set<string>} */
  const out = new Set(alert.jurisdictions.map((j) => j.toLowerCase()));
  if (marineToRegion) {
    for (const z of alert.zones) {
      if (!z.startsWith('marine:')) continue;
      const region = marineToRegion[z.slice('marine:'.length)];
      if (region) out.add(region);
    }
  }
  return out;
}

/**
 * @param {DashboardAlert | DashboardAlertIndexEntry} alert
 * @param {string} key one of ALERT_FILTER_KEYS
 * @param {{ marineToRegion?: Record<string, string> | null }} ctx
 * @returns {string[]} the values this alert has for that filter
 */
function valuesFor(alert, key, ctx) {
  switch (key) {
    case 'j': return [...regionsOfAlert(alert, ctx.marineToRegion)];
    case 'hz': return alert.categories;
    case 'des': return [alert.designation];
    case 'band': return [alert.band];
    case 'posture': return [alert.posture];
    case 'src': return [alert.agency];
    default: return [];
  }
}

/**
 * @template {DashboardAlert | DashboardAlertIndexEntry} T
 * @param {T[]} alerts
 * @param {AlertFilters} filters
 * @param {{ marineToRegion?: Record<string, string> | null, nationId?: string | null, skip?: string }} ctx `skip` leaves one filter out (for chip counts)
 * @returns {T[]}
 */
export function filterAlerts(alerts, filters, ctx) {
  return alerts.filter((a) => {
    for (const key of ALERT_FILTER_KEYS) {
      if (key === ctx.skip) continue;
      const wanted = /** @type {string[] | undefined} */ (filters[/** @type {keyof AlertFilters} */ (key)]);
      if (!wanted || wanted.length === 0) continue;
      const have = valuesFor(a, key, ctx);
      if (!wanted.some((v) => have.includes(v))) return false;
    }
    if (filters.only && ctx.nationId && !a.nationIds.includes(ctx.nationId)) return false;
    return true;
  });
}

/**
 * Per-option counts for one filter, over the alerts that pass every other filter.
 * @param {(DashboardAlert | DashboardAlertIndexEntry)[]} alerts
 * @param {AlertFilters} filters
 * @param {string} key
 * @param {{ marineToRegion?: Record<string, string> | null, nationId?: string | null }} ctx
 * @returns {Record<string, number>}
 */
export function countsFor(alerts, filters, key, ctx) {
  /** @type {Record<string, number>} */
  const counts = {};
  for (const a of filterAlerts(alerts, filters, { ...ctx, skip: key })) {
    for (const v of new Set(valuesFor(a, key, ctx))) counts[v] = (counts[v] ?? 0) + 1;
  }
  return counts;
}

/**
 * Counts by designation with a band breakdown, for the summary tiles.
 * @param {(DashboardAlert | DashboardAlertIndexEntry)[]} alerts
 * @returns {Record<string, { count: number, bands: Record<string, number> }>}
 */
export function summarizeByDesignation(alerts) {
  /** @type {Record<string, { count: number, bands: Record<string, number> }>} */
  const out = {};
  for (const d of DESIGNATION_OPTIONS) out[d.value] = { count: 0, bands: {} };
  for (const a of alerts) {
    const row = out[a.designation] ?? (out[a.designation] = { count: 0, bands: {} });
    row.count += 1;
    row.bands[a.band] = (row.bands[a.band] ?? 0) + 1;
  }
  return out;
}

/**
 * @template {DashboardAlert | DashboardAlertIndexEntry} T
 * @param {T[]} alerts
 * @returns {{ pinned: T[], rest: T[] }} tsunami notices first
 */
export function splitPinned(alerts) {
  return { pinned: alerts.filter((a) => a.agency === 'ntwc'), rest: alerts.filter((a) => a.agency !== 'ntwc') };
}

/**
 * Groups by the first jurisdiction in display order that the alert carries.
 * @template {DashboardAlert | DashboardAlertIndexEntry} T
 * @param {T[]} alerts
 * @returns {{ label: string, alerts: T[] }[]}
 */
export function groupByJurisdiction(alerts) {
  /** @type {Map<string, T[]>} */
  const groups = new Map(REGION_OPTIONS.map((r) => [r.jurisdiction, []]));
  /** @type {T[]} */
  const other = [];
  for (const a of alerts) {
    const home = REGION_OPTIONS.find((r) => a.jurisdictions.includes(/** @type {any} */ (r.jurisdiction)));
    if (home) /** @type {T[]} */ (groups.get(home.jurisdiction)).push(a);
    else other.push(a);
  }
  /** @type {{ label: string, alerts: T[] }[]} */
  const out = REGION_OPTIONS.map((r) => ({ label: r.label, alerts: /** @type {T[]} */ (groups.get(r.jurisdiction)) })).filter((g) => g.alerts.length > 0);
  if (other.length > 0) out.push({ label: 'Other Areas', alerts: other });
  return out;
}

/**
 * @param {HTMLElement} el
 * @param {DashboardAlert[]} alerts
 * @param {{ timeZone: string, groupBy: 'nation' | 'jurisdiction', nation?: NationRecord | null, lang?: string, selectedId?: string | null,
 *   statuses?: Map<string, StatusSnapshot> | null, emptyMessage?: string,
 *   onShowOnMap?: (alertId: string) => void, loadText?: (alertId: string) => Promise<Record<string, AlertLanguageBlock> | null> }} opts
 * @returns {void}
 */
export function renderAlertList(el, alerts, opts) {
  el.replaceChildren();
  if (alerts.length === 0) {
    el.append(h('p', { class: 'panel-note' }, opts.emptyMessage ?? 'No alerts match these filters.'));
    return;
  }
  const sorted = sortAlerts(alerts);

  /** @param {DashboardAlert} a @returns {string | null} */
  const lastConfirmed = (a) => {
    const s = opts.statuses?.get(a.sourceId);
    return s && s.state !== 'live' ? a.provenance.fetchedAt : null;
  };
  /** @param {DashboardAlert[]} list */
  const listOf = (list) => h('ul', { class: 'alert-list' }, list.map((a) => h('li', {}, alertCard(a, {
    timeZone: opts.timeZone,
    ...(opts.lang ? { lang: opts.lang } : {}),
    selected: opts.selectedId === a.alertId,
    headingLevel: 4,
    lastConfirmedAt: lastConfirmed(a),
    ...(opts.onShowOnMap ? { onShowOnMap: opts.onShowOnMap } : {}),
    ...(opts.loadText ? { loadText: opts.loadText } : {}),
  }))));
  /** @param {string} label @param {DashboardAlert[]} list @param {string} id */
  const section = (label, list, id) => h('section', { class: 'alert-group', 'aria-labelledby': id, 'data-group': label },
    h('h3', { id }, `${label} (${list.length})`), listOf(list));

  const { pinned, rest } = splitPinned(sorted);
  /** @type {Node[]} */
  const out = [];
  if (pinned.length > 0) out.push(section('Tsunami Notices', pinned, 'alert-group-tsunami'));
  if (opts.groupBy === 'nation' && opts.nation) {
    const g = groupForNation(rest, opts.nation);
    if (g.forNation.length > 0) out.push(section('For This Nation', g.forNation, 'alert-group-nation'));
    if (g.nearby.length > 0) out.push(section('Nearby', g.nearby, 'alert-group-nearby'));
    if (g.elsewhere.length > 0) out.push(section('Elsewhere in Cascadia', g.elsewhere, 'alert-group-elsewhere'));
  } else {
    groupByJurisdiction(rest).forEach((g, i) => out.push(section(g.label, g.alerts, `alert-group-j${i}`)));
  }
  el.append(...out);
}

/**
 * Scrolls to a card, opens its full text, and moves focus to it.
 * @param {ParentNode} root
 * @param {string} alertId
 * @returns {HTMLElement | null} the card, or null when it is not in the list
 */
export function focusAlertCard(root, alertId) {
  const card = /** @type {HTMLElement | null} */ (root.querySelector(`[data-alert-id="${CSS.escape(alertId)}"]`));
  if (!card) return null;
  for (const other of root.querySelectorAll('.alert-card[aria-current]')) other.removeAttribute('aria-current');
  card.setAttribute('aria-current', 'true');
  expandCard(card);
  card.tabIndex = -1;
  const reduce = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  card.scrollIntoView?.({ block: 'center', behavior: reduce ? 'auto' : 'smooth' });
  card.focus({ preventScroll: true });
  return card;
}

// ---------------------------------------------------------------------------------------------------
// Page helpers (lane L11): pure, shared by pages/alerts.js and its tests. They live here, not in the page
// module, so the page's static import graph stays inside its byte budget (blueprint 8.1).
// ---------------------------------------------------------------------------------------------------
const NWS = 'nws-alerts-active';
const ECCC = 'eccc-geomet-weather-alerts';
const NTWC = 'ntwc-atom';
const REGION_VALUES = ['wa', 'or', 'id', 'bc', 'ca-n', 'mt-w', 'nv-n', 'ak-se', 'marine'];
const LEVEL_VALUES = ['federal', 'tribal', 'first-nation', 'state', 'provincial', 'county', 'regional-district'];
const TYPE_VALUES = ['dr', 'em', 'fm', 'proclamation', 'local'];

/**
 * The canonical sovereignty statement (map/sovereignty.js carries the same words; a unit test keeps them
 * equal). Shown beside the map before the map module is requested, so no map display is ever without it.
 */
export const SOVEREIGNTY_HEADLINE = 'Representation, not jurisdiction.';
export const SOVEREIGNTY_BODY = 'Boundary lines shown here come from public federal sources; they are not a Tribal Nation\'s own statement of its land or authority.';
/** The legend sentence of blueprint 3.7.5. */
export const COVERAGE_LEGEND = 'Dashed areas are forecast zones named in the alert; solid areas were drawn by the forecaster.';

/** @type {UrlStateSchema} */
export const ALERT_URL_SCHEMA = Object.freeze({
  n: { type: 'nation-id' },
  view: { type: 'enum', values: ['list', 'map', 'declarations'] },
  j: { type: 'enum-list', values: REGION_VALUES },
  hz: { type: 'enum-list', values: ['flood', 'coastal', 'rain-landslide', 'wind', 'winter', 'cold', 'heat', 'fire', 'smoke-air', 'marine', 'tsunami', 'avalanche', 'geologic', 'evacuation', 'other'] },
  des: { type: 'enum-list', values: ['emergency', 'warning', 'watch', 'advisory', 'statement', 'other'] },
  band: { type: 'enum-list', values: ['extreme', 'severe', 'moderate', 'minor', 'unstated'] },
  posture: { type: 'enum-list', values: ['act-now', 'prepare', 'monitor'] },
  src: { type: 'enum-list', values: ['nws', 'eccc', 'ntwc', 'bc-rfc'] },
  only: { type: 'flag' },
  lang: { type: 'enum', values: ['en', 'fr'] },
  alert: { type: 'string' },
  level: { type: 'enum-list', values: LEVEL_VALUES },
  type: { type: 'enum-list', values: TYPE_VALUES },
  tribal: { type: 'flag' },
});

/** @type {Readonly<Record<string, number>>} */
const RANK = Object.freeze({ live: 0, cached: 1, stale: 2, degraded: 3, unavailable: 4 });
/** @type {Readonly<Record<string, string>>} */
const AGENCY_NAMES = Object.freeze({ [NWS]: 'National Weather Service', [ECCC]: 'Environment and Climate Change Canada', [NTWC]: 'National Tsunami Warning Center' });

/**
 * One status for a panel that reads several sources: the worst state of the sources that answered; a source
 * that did not answer makes the panel at least degraded (never silently live), and only a panel with no
 * answering source is unavailable. `asOf` is the oldest time among the sources that answered.
 * @param {Map<string, StatusSnapshot>} statuses
 * @param {string[]} relevant source ids that feed the panel
 * @param {string[]} sourceIds ids the panel names in its footer
 * @param {Date} now
 * @returns {StatusSnapshot}
 */
export function combineStatuses(statuses, relevant, sourceIds, now) {
  const list = relevant.map((id) => ({ id, s: statuses.get(id) })).filter((x) => x.s !== undefined);
  const checkedAt = now.toISOString();
  const answered = list.filter((x) => /** @type {StatusSnapshot} */ (x.s).state !== 'unavailable');
  if (answered.length === 0) {
    return {
      state: 'unavailable', asOf: null, asOfBasis: null, sourceIds: [...sourceIds], origin: 'direct', completeness: 'partial', checkedAt,
      detail: list.map((x) => `${AGENCY_NAMES[x.id] ?? x.id}: ${/** @type {StatusSnapshot} */ (x.s).detail ?? 'not available'}`).join(' ') || 'No alert source has answered yet.',
    };
  }
  const all = answered.map((x) => /** @type {StatusSnapshot} */ (x.s));
  const worst = all.reduce((a, b) => ((RANK[b.state] ?? 0) > (RANK[a.state] ?? 0) ? b : a));
  const missing = answered.length < list.length || list.length < relevant.length;
  /** @type {StatusSnapshot['state']} */
  let state = worst.state;
  if (missing && (RANK[state] ?? 0) < (RANK.degraded ?? 3)) state = 'degraded';
  const dated = all.filter((s) => s.asOf !== null);
  const oldest = dated.length > 0 ? dated.reduce((a, b) => (Date.parse(/** @type {string} */ (a.asOf)) <= Date.parse(/** @type {string} */ (b.asOf)) ? a : b)) : null;
  const details = list.flatMap((x) => {
    const s = /** @type {StatusSnapshot} */ (x.s);
    if (s.state === 'live' && s.completeness === 'complete') return [];
    return s.detail ? [`${AGENCY_NAMES[x.id] ?? x.id}: ${s.detail}`] : [];
  });
  if (list.length < relevant.length) details.push('Not every alert source has reported.');
  return {
    state,
    asOf: oldest ? oldest.asOf : null,
    asOfBasis: oldest ? oldest.asOfBasis : null,
    sourceIds: [...sourceIds],
    origin: all.some((s) => s.origin === 'direct') ? 'direct' : all.some((s) => s.origin === 'device') ? 'device' : 'snapshot',
    completeness: missing || all.some((s) => s.completeness === 'partial') ? 'partial' : 'complete',
    checkedAt,
    ...(details.length > 0 ? { detail: details.join(' ') } : {}),
  };
}

/**
 * Declaration type for the filter, shared by federal and curated rows.
 * @param {{ fema: FemaDeclaration } | { curated: CuratedDeclaration }} item
 * @returns {string}
 */
export function declarationTypeOf(item) {
  if ('fema' in item) return item.fema.type.toLowerCase();
  switch (item.curated.kind) {
    case 'disaster-declaration': return 'dr';
    case 'emergency-declaration': return 'em';
    case 'emergency-proclamation': return 'proclamation';
    default: return 'local';
  }
}

/**
 * Region for a curated declaration: its Nation's registry region, else the state or province in the issuer's
 * name. Null when neither is known; a row with no known region is never hidden by a jurisdiction filter.
 * @param {CuratedDeclaration} d
 * @param {Map<string, string>} regionByNation
 * @returns {string | null}
 */
export function curatedRegion(d, regionByNation) {
  if (d.issuer.nationId) {
    const r = regionByNation.get(d.issuer.nationId);
    if (r) return r;
  }
  const name = d.issuer.name.toLowerCase();
  /** @type {[RegExp, string][]} */
  const rules = [[/british columbia|\bbc\b/, 'bc'], [/washington/, 'wa'], [/oregon/, 'or'], [/idaho/, 'id'], [/california/, 'ca-n'], [/montana/, 'mt-w'], [/nevada/, 'nv-n'], [/alaska/, 'ak-se']];
  for (const [re, region] of rules) if (re.test(name)) return region;
  return null;
}

/** @type {Readonly<Record<string, [string, string]>>} */
const TILE_WORDS = Object.freeze({
  emergency: ['Emergency', 'Emergencies'], warning: ['Warning', 'Warnings'], watch: ['Watch', 'Watches'],
  advisory: ['Advisory', 'Advisories'], statement: ['Statement', 'Statements'], other: ['Other Alert', 'Other Alerts'],
});

/**
 * @param {string} designation
 * @param {number} count
 * @returns {string} the tile label, singular for one
 */
export function tileLabel(designation, count) {
  const words = TILE_WORDS[designation] ?? [designation, designation];
  return count === 1 ? words[0] : words[1];
}

