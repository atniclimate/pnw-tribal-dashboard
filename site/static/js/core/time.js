// @ts-check
/**
 * Time zones per Nation, house-style date formatting, and DST-safe day bucketing (blueprint 3.11). DOM-free.
 *
 * STUB (lane L0). Owner: lane L2. Signatures are the contract; bodies throw until the owner implements them.
 */
const NOT_IMPLEMENTED = 'not implemented';

/**
 * 'YYYY-MM-DD' for an instant in a zone.
 * @param {Date} date
 * @param {string} timeZone
 * @returns {string}
 */
export function zonedDayKey(date, timeZone) {
  throw new Error(NOT_IMPLEMENTED);
}

/**
 * Split an interval value across zoned days by hour; DST-safe.
 * @param {Date} start
 * @param {Date} end
 * @param {number} value
 * @param {string} timeZone
 * @returns {Map<string, number>}
 */
export function splitByZonedDay(start, end, value, timeZone) {
  throw new Error(NOT_IMPLEMENTED);
}

/**
 * '10/04/2026 3:15 PM PDT': MM/DD/YYYY, 12-hour time, zone abbreviation.
 * @param {string} iso
 * @param {string} [timeZone] viewer's zone when absent
 * @returns {string}
 */
export function formatAsOf(iso, timeZone) {
  throw new Error(NOT_IMPLEMENTED);
}

/**
 * '10/04/2026'.
 * @param {string} iso
 * @param {string} [timeZone]
 * @returns {string}
 */
export function formatDate(iso, timeZone) {
  throw new Error(NOT_IMPLEMENTED);
}

/**
 * 'PDT', 'MST', 'AKDT'; never a bare offset when a name exists.
 * @param {Date} date
 * @param {string} timeZone
 * @returns {string}
 */
export function zoneAbbreviation(date, timeZone) {
  throw new Error(NOT_IMPLEMENTED);
}

/**
 * '1 min ago'; never shown without the absolute stamp.
 * @param {string} iso
 * @param {Date} now
 * @returns {string}
 */
export function relativeAge(iso, now) {
  throw new Error(NOT_IMPLEMENTED);
}

/**
 * Milliseconds.
 * @param {string} duration for example 'PT6H' or 'P1DT6H'
 * @returns {number}
 */
export function parseIsoDuration(duration) {
  throw new Error(NOT_IMPLEMENTED);
}
