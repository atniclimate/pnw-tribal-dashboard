// @ts-check
/**
 * Time zones per Nation, house-style date formatting, and DST-safe day bucketing (blueprint 3.11). DOM-free.
 * Every rendered time prints its zone abbreviation; relative ages never stand alone.
 */

const HOUR_MS = 3_600_000;
const UNAVAILABLE = 'Time unavailable';

/**
 * Rules checked against provincial sources on 10/05/2026. Probe offsets, not abbreviations or a
 * claimed tzdb version: browser ICU releases may backport rules and use different zone labels.
 * Local mountain-time arrangements in British Columbia are not covered by the Vancouver check.
 * https://news.gov.bc.ca/releases/2026CITZ0009-001073
 * https://www.alberta.ca/albertas-new-time-system-abt
 */
const TIME_ZONE_CHECKS = Object.freeze([
  { timeZone: 'America/Vancouver', region: 'Pacific-time British Columbia', expectedMinutes: -420 },
  { timeZone: 'America/Edmonton', region: 'Alberta', expectedMinutes: -360 },
]);
const TIME_ZONE_PROBE = '2026-11-02T12:00:00Z';

/**
 * @typedef {{ timeZone: string, region: string, expectedMinutes: number,
 *   actualMinutes: number | null }} TimeZoneDataIssue
 */

/** @type {Map<string, Intl.DateTimeFormat>} */
const formatters = new Map();

/**
 * Cached formatter; construction is the slow part of Intl.
 * @param {string} key
 * @param {() => Intl.DateTimeFormat} make
 * @returns {Intl.DateTimeFormat}
 */
function cached(key, make) {
  let f = formatters.get(key);
  if (!f) { f = make(); formatters.set(key, f); }
  return f;
}

/**
 * Numeric UTC offset read from the device's own time zone database. No inferred abbreviation mapping.
 * A missing zone or unsupported offset format returns null rather than a guessed offset.
 * @param {Date} date
 * @param {string} timeZone
 * @returns {number | null}
 */
export function timeZoneOffsetMinutes(date, timeZone) {
  try {
    const name = cached(`offset|${timeZone}`, () => new Intl.DateTimeFormat('en-US', {
      timeZone, timeZoneName: 'longOffset',
    })).formatToParts(date).find((part) => part.type === 'timeZoneName')?.value;
    if (name === 'GMT' || name === 'UTC') return 0;
    const match = /^(?:GMT|UTC)([+-])(\d{2}):(\d{2})$/.exec(name ?? '');
    if (!match) return null;
    return (match[1] === '-' ? -1 : 1) * (Number(match[2]) * 60 + Number(match[3]));
  } catch { return null; }
}

/**
 * Startup self-check for the confirmed 2026 Pacific-time British Columbia and Alberta rule changes.
 * Returns only mismatches. Formatting and day bucketing continue to use the browser's actual rules;
 * the UI warns when those rules cannot be trusted rather than silently applying an invented offset.
 * @param {(date: Date, timeZone: string) => number | null} [readOffset]
 * @returns {TimeZoneDataIssue[]}
 */
export function checkTimeZoneData(readOffset = timeZoneOffsetMinutes) {
  /** @type {TimeZoneDataIssue[]} */
  const issues = [];
  for (const rule of TIME_ZONE_CHECKS) {
    let actualMinutes = null;
    try { actualMinutes = readOffset(new Date(TIME_ZONE_PROBE), rule.timeZone); } catch { /* unavailable */ }
    if (actualMinutes !== null && !Number.isFinite(actualMinutes)) actualMinutes = null;
    if (actualMinutes !== rule.expectedMinutes) issues.push({ ...rule, actualMinutes });
  }
  return issues;
}

/**
 * @param {string | Date} iso
 * @returns {Date | null} null when unparseable
 */
function toDate(iso) {
  const d = iso instanceof Date ? iso : new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * 'YYYY-MM-DD' for an instant in a zone.
 * @param {Date} date
 * @param {string} timeZone
 * @returns {string}
 */
export function zonedDayKey(date, timeZone) {
  return cached(`day|${timeZone}`, () => new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' })).format(date);
}

/**
 * Split an interval value across zoned days by hour; NWS gridpoint intervals are whole hours. DST-safe
 * because each hour is a real elapsed hour mapped to its local day.
 * @param {Date} start
 * @param {Date} end
 * @param {number} value
 * @param {string} timeZone
 * @returns {Map<string, number>}
 */
export function splitByZonedDay(start, end, value, timeZone) {
  /** @type {Map<string, number>} */
  const out = new Map();
  const hours = Math.max(1, Math.round((end.getTime() - start.getTime()) / HOUR_MS));
  for (let i = 0; i < hours; i += 1) {
    const key = zonedDayKey(new Date(start.getTime() + i * HOUR_MS), timeZone);
    out.set(key, (out.get(key) ?? 0) + value / hours);
  }
  return out;
}

/**
 * Parts of an instant in a zone, with 12-hour time.
 * @param {Date} d
 * @param {string | undefined} timeZone viewer's zone when absent
 */
function parts(d, timeZone) {
  const fmt = cached(`parts|${timeZone ?? ''}`, () => new Intl.DateTimeFormat('en-US', {
    ...(timeZone ? { timeZone } : {}),
    year: 'numeric', month: '2-digit', day: '2-digit', hour: 'numeric', minute: '2-digit', hour12: true, timeZoneName: 'short',
  }));
  /** @type {Record<string, string>} */
  const p = {};
  for (const part of fmt.formatToParts(d)) p[part.type] = part.value;
  /** @param {string} t */
  const g = (t) => p[t] ?? '';
  return {
    month: g('month'), day: g('day'), year: g('year'), hour: g('hour'), minute: g('minute'),
    dayPeriod: g('dayPeriod').toUpperCase(), timeZoneName: g('timeZoneName'),
  };
}

/**
 * 'PDT', 'MST', 'AKDT'; never a bare offset when a name exists.
 * @param {Date} date
 * @param {string} timeZone
 * @returns {string}
 */
export function zoneAbbreviation(date, timeZone) {
  return parts(date, timeZone).timeZoneName;
}

/**
 * '10/04/2026 3:15 PM PDT': MM/DD/YYYY, 12-hour time, zone abbreviation.
 * @param {string} iso
 * @param {string} [timeZone] viewer's zone when absent
 * @returns {string}
 */
export function formatAsOf(iso, timeZone) {
  const d = toDate(iso);
  if (!d) return UNAVAILABLE;
  const p = parts(d, timeZone);
  return `${p.month}/${p.day}/${p.year} ${p.hour}:${p.minute} ${p.dayPeriod} ${p.timeZoneName}`;
}

/**
 * '3:15 PM PDT'.
 * @param {string} iso
 * @param {string} [timeZone]
 * @returns {string}
 */
export function formatTime(iso, timeZone) {
  const d = toDate(iso);
  if (!d) return UNAVAILABLE;
  const p = parts(d, timeZone);
  return `${p.hour}:${p.minute} ${p.dayPeriod} ${p.timeZoneName}`;
}

/**
 * '10/04/2026'.
 * @param {string} iso
 * @param {string} [timeZone]
 * @returns {string}
 */
export function formatDate(iso, timeZone) {
  const d = toDate(iso);
  if (!d) return UNAVAILABLE;
  const p = parts(d, timeZone);
  return `${p.month}/${p.day}/${p.year}`;
}

/**
 * '1 min ago'; never shown without the absolute stamp.
 * @param {string} iso
 * @param {Date} now
 * @returns {string}
 */
export function relativeAge(iso, now) {
  const d = toDate(iso);
  if (!d) return UNAVAILABLE;
  const s = Math.floor((now.getTime() - d.getTime()) / 1000);
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h} hr ago`;
  return `${Math.floor(h / 24)} days ago`;
}

const DURATION = /^P(?:(\d+(?:\.\d+)?)W)?(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/;

/**
 * Milliseconds. Weeks, days, hours, minutes, and seconds only: years and months have no fixed length, and
 * NWS gridpoint intervals never use them. Throws on anything else.
 * @param {string} duration for example 'PT6H' or 'P1DT6H'
 * @returns {number}
 */
export function parseIsoDuration(duration) {
  const m = DURATION.exec(String(duration));
  if (!m || duration === 'P' || /T$/.test(duration)) throw new Error(`Unsupported ISO 8601 duration: "${duration}"`);
  /** @param {number} i */
  const n = (i) => (m[i] === undefined ? 0 : Number(m[i]));
  const [w, d, h, min, s] = [n(1), n(2), n(3), n(4), n(5)];
  if (w === undefined || d === undefined || h === undefined || min === undefined || s === undefined) throw new Error('unreachable');
  return Math.round((((w * 7 + d) * 24 + h) * 60 + min) * 60_000 + s * 1000);
}
