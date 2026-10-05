// @ts-check
/**
 * Curated declaration status, computed at render and never stored (blueprint 5.7). DOM-free.
 *
 * Curated rows are Tribal, state, provincial, county, and regional district declarations that no machine feed
 * carries. A row says "In effect" only while its review date has not passed; after that the honest word is
 * "not re-confirmed", and once its own end date passes it says "Ended". Nothing is inferred from silence.
 */
import { zonedDayKey } from '../core/time.js';

/** @typedef {import('../types.js').CuratedDeclaration} CuratedDeclaration */

/** Day boundaries are read in Pacific time, the zone of most of the footprint. */
const DAY_ZONE = 'America/Los_Angeles';

/**
 * 'YYYY-MM-DD' to 'MM/DD/YYYY' without a time zone shift.
 * @param {string} iso
 * @returns {string}
 */
export function isoDateToUs(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso));
  return m ? `${m[2]}/${m[3]}/${m[1]}` : '';
}

/**
 * Ended once `effectiveUntil` has passed; not re-confirmed once `reviewBy` has passed; otherwise in effect
 * since its verification date. `since` is the date that status counts from: the verification date, the
 * review date that lapsed, or the end date.
 * @param {CuratedDeclaration} declaration
 * @param {Date} now
 * @returns {{ kind: 'in-effect' | 'not-reconfirmed' | 'ended', since: string }}
 */
export function curatedStatus(declaration, now) {
  const today = zonedDayKey(now, DAY_ZONE);
  if (declaration.effectiveUntil && today > declaration.effectiveUntil) {
    return { kind: 'ended', since: declaration.effectiveUntil };
  }
  if (today > declaration.reviewBy) {
    return { kind: 'not-reconfirmed', since: declaration.reviewBy };
  }
  return { kind: 'in-effect', since: declaration.verifiedAt };
}

/**
 * The status sentence: "In effect (confirmed 10/05/2026)", "Status not re-confirmed since 01/11/2026", or
 * "Ended 01/20/2026".
 * @param {{ kind: 'in-effect' | 'not-reconfirmed' | 'ended', since: string }} status
 * @returns {string}
 */
export function curatedStatusText(status) {
  const date = isoDateToUs(status.since);
  if (status.kind === 'ended') return `Ended ${date}`;
  if (status.kind === 'not-reconfirmed') return `Status not re-confirmed since ${date}`;
  return `In effect (confirmed ${date})`;
}

/** Issuer levels in words, for filters and cards. */
export const ISSUER_LEVEL_WORDS = Object.freeze(/** @type {Record<CuratedDeclaration['issuer']['type'], string>} */ ({
  tribal: 'Tribal Nation',
  'first-nation': 'First Nation',
  state: 'State',
  provincial: 'Province',
  county: 'County',
  'regional-district': 'Regional District',
}));

/** Declaration kinds in words. */
export const CURATED_KIND_WORDS = Object.freeze(/** @type {Record<CuratedDeclaration['kind'], string>} */ ({
  'disaster-declaration': 'Disaster Declaration',
  'emergency-declaration': 'Emergency Declaration',
  'emergency-proclamation': 'Emergency Proclamation',
  'state-of-local-emergency': 'State of Local Emergency',
}));
