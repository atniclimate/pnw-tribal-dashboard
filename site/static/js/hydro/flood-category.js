// @ts-check
/**
 * Flood category words and freshness (blueprint 5.5). DOM-free.
 *
 * Owner: lane L7. The category is the NWS's own; this module only words it and judges freshness.
 */

/** @typedef {import('../types.js').FloodCategory} FloodCategory */
/** @typedef {import('../types.js').GaugeStatus} GaugeStatus */

/** An observation older than this is "Observation not current". */
export const OBSERVATION_MAX_AGE_MS = 6 * 60 * 60 * 1000;

export const NOT_CURRENT_TEXT = 'Observation not current';
export const NOT_DEFINED_TEXT = 'No flood categories defined for this gauge';
export const NO_CATEGORY_TEXT = 'No category available';

/** @type {Record<string, string>} */
const LABELS = {
  no_flooding: 'No Flooding',
  action: 'Action Stage',
  minor: 'Minor Flood',
  moderate: 'Moderate Flood',
  major: 'Major Flood',
  not_defined: NOT_DEFINED_TEXT,
  out_of_service: 'Out of Service',
};

/**
 * 'No flood categories defined for this gauge' for not_defined; never 'normal'.
 * @param {FloodCategory | 'out_of_service' | null} category
 * @returns {string}
 */
export function categoryLabel(category) {
  if (category === null || category === undefined) return NO_CATEGORY_TEXT;
  return LABELS[category] ?? NO_CATEGORY_TEXT;
}

/**
 * False when older than six hours ("Observation not current"); false for a missing or unparseable time.
 * @param {string | null} validTime
 * @param {Date} now
 * @returns {boolean}
 */
export function isObservationCurrent(validTime, now) {
  if (typeof validTime !== 'string' || validTime === '') return false;
  const t = Date.parse(validTime);
  if (!Number.isFinite(t) || t < Date.UTC(1990, 0, 1)) return false;
  return now.getTime() - t <= OBSERVATION_MAX_AGE_MS;
}

/**
 * What a chip or row says for one gauge's observation: out of service first, then staleness, then the NWS word.
 * @param {GaugeStatus | null | undefined} status
 * @param {Date} now
 * @returns {{ label: string, category: FloodCategory | 'out_of_service' | null, current: boolean }}
 */
export function observedDisplay(status, now) {
  const obs = status?.observed ?? null;
  if (!obs) return { label: NO_CATEGORY_TEXT, category: null, current: false };
  if (obs.category === 'out_of_service') return { label: categoryLabel('out_of_service'), category: 'out_of_service', current: false };
  const current = isObservationCurrent(obs.validTime, now);
  if (!current) return { label: NOT_CURRENT_TEXT, category: obs.category, current: false };
  return { label: categoryLabel(obs.category), category: obs.category, current: true };
}

/** Higher number is more severe; used to rank gauges and find the highest category among nearby gauges. */
const SEVERITY = { no_flooding: 1, action: 2, minor: 3, moderate: 4, major: 5 };

/**
 * Highest NWS category across statuses (observed, current only). not_defined and unknown never rank.
 * @param {(GaugeStatus | null | undefined)[]} statuses
 * @param {Date} now
 * @returns {FloodCategory | null}
 */
export function highestCategory(statuses, now) {
  /** @type {FloodCategory | null} */
  let best = null;
  let rank = 0;
  for (const s of statuses) {
    const d = observedDisplay(s, now);
    if (!d.current || d.category === null || d.category === 'out_of_service') continue;
    const r = /** @type {Record<string, number>} */ (SEVERITY)[d.category] ?? 0;
    if (r > rank) { rank = r; best = d.category; }
  }
  return best;
}
