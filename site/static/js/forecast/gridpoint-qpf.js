// @ts-check
/**
 * The May 2026 gridpoint QPF aggregator, ported with Nation-zone day keys and hourly splitting (blueprint 3.14). DOM-free.
 */
import { getData } from '../core/sources.js';
import { parseIsoDuration, splitByZonedDay, zonedDayKey } from '../core/time.js';
import { isoOrNull } from './nws-forecast.js';

/** @typedef {import('../types.js').QpfDay} QpfDay */
/** @typedef {import('../types.js').QpfState} QpfState */
/** @typedef {import('../types.js').StatusSnapshot} StatusSnapshot */

const HOUR_MS = 3_600_000;
/** The May 2026 constant, kept so the port reproduces its amounts exactly. */
const MM_TO_IN = 0.0393701;
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/**
 * "{ISO datetime}/{ISO duration}" to a start and end.
 * @param {unknown} validTime
 * @returns {{ start: Date, end: Date } | null}
 */
export function parseValidTime(validTime) {
  const [startText, durText] = String(validTime ?? '').split('/');
  const start = new Date(startText ?? '');
  if (Number.isNaN(start.getTime()) || !durText) return null;
  let ms;
  try { ms = parseIsoDuration(durText); } catch { return null; }
  return { start, end: new Date(start.getTime() + ms) };
}

/**
 * Whole hours a local day has in a zone (23 and 25 on the transition days).
 * @param {string} dayKey 'YYYY-MM-DD'
 * @param {string} timeZone
 * @returns {number}
 */
export function hoursInZonedDay(dayKey, timeZone) {
  const [y, m, d] = dayKey.split('-').map(Number);
  const base = Date.UTC(/** @type {number} */ (y), /** @type {number} */ (m) - 1, /** @type {number} */ (d));
  let n = 0;
  for (let h = -14; h <= 38; h += 1) if (zonedDayKey(new Date(base + h * HOUR_MS), timeZone) === dayKey) n += 1;
  return n;
}

/**
 * Preserves ISO 8601 durations, proportional distribution, mm to in by WMO unit, max PoP per day, and the partial Today label.
 * A day with no probability series is null, never zero.
 * @param {unknown} props forecastGridData properties
 * @param {string} timeZone
 * @param {Date} now
 * @returns {QpfDay[]}
 */
export function aggregateGridpointDaily(props, timeZone, now) {
  const p = /** @type {any} */ (props) ?? {};
  const qpfSeries = Array.isArray(p.quantitativePrecipitation?.values) ? p.quantitativePrecipitation.values : [];
  const uom = String(p.quantitativePrecipitation?.uom ?? '');
  if (!['wmoUnit:mm', 'wmoUnit:in'].includes(uom)) return [];
  const popSeries = Array.isArray(p.probabilityOfPrecipitation?.values) ? p.probabilityOfPrecipitation.values : [];

  /** @type {Map<string, { raw: number, hours: number, pop: number | null, hasQpf: boolean }>} */
  const days = new Map();
  /** @param {string} key */
  const ensure = (key) => {
    let d = days.get(key);
    if (!d) { d = { raw: 0, hours: 0, pop: null, hasQpf: false }; days.set(key, d); }
    return d;
  };

  for (const entry of qpfSeries) {
    const iv = parseValidTime(entry?.validTime);
    if (!iv || !Number.isFinite(entry.value) || entry.value < 0) continue;
    const totalMs = iv.end.getTime() - iv.start.getTime();
    if (totalMs <= 0) continue;
    for (const [key, v] of splitByZonedDay(iv.start, iv.end, entry.value, timeZone)) { const day = ensure(key); day.raw += v; day.hasQpf = true; }
    const hours = Math.max(1, Math.round(totalMs / HOUR_MS));
    for (const [key, h] of splitByZonedDay(iv.start, iv.end, hours, timeZone)) ensure(key).hours += h;
  }

  for (const entry of popSeries) {
    const iv = parseValidTime(entry?.validTime);
    if (!iv || !Number.isFinite(entry.value)) continue;
    const touched = iv.end > iv.start ? [...splitByZonedDay(iv.start, iv.end, 1, timeZone).keys()] : [zonedDayKey(iv.start, timeZone)];
    for (const key of touched) {
      const d = ensure(key);
      if (d.pop === null || entry.value > d.pop) d.pop = entry.value;
    }
  }

  const inches = uom.includes('mm');
  const todayKey = zonedDayKey(now, timeZone);
  return [...days.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .filter(([k, v]) => k >= todayKey && v.hasQpf)
    .slice(0, 7)
    .map(([key, v]) => {
      const [y, m, d] = key.split('-').map(Number);
      const noon = new Date(Date.UTC(/** @type {number} */ (y), /** @type {number} */ (m) - 1, /** @type {number} */ (d), 12));
      const isToday = key === todayKey;
      return {
        dayKey: key,
        label: isToday ? 'Today' : /** @type {string} */ (WEEKDAYS[noon.getUTCDay()]),
        partial: isToday || v.hours < hoursInZonedDay(key, timeZone),
        amountIn: inches ? v.raw * MM_TO_IN : v.raw,
        amountMm: inches ? v.raw : v.raw / MM_TO_IN,
        maxPop: v.pop === null ? null : Math.round(v.pop),
      };
    });
}

/**
 * The idle, loading, ready, and error states of the May 2026 aggregator, as one result.
 * @param {{ wfo: string, x: number, y: number }} grid
 * @param {string} timeZone the Nation's zone
 * @param {{ signal?: AbortSignal, now?: Date }} [opts]
 * @returns {Promise<{ state: QpfState, status: StatusSnapshot }>}
 */
export async function loadQpf(grid, timeZone, opts = {}) {
  const now = opts.now ?? new Date();
  const res = await getData('nws-gridpoints', { wfo: grid.wfo, x: grid.x, y: grid.y }, {
    now,
    ...(opts.signal ? { signal: opts.signal } : {}),
    asOfOf: (d) => {
      const t = isoOrNull(/** @type {any} */ (d)?.properties?.updateTime);
      return { asOf: t, asOfBasis: t ? 'issued' : null };
    },
  });
  if (!res.data) return { state: { state: 'error', message: res.status.detail ?? 'The gridded forecast is not available.' }, status: res.status };
  const props = /** @type {any} */ (res.data).properties;
  const days = aggregateGridpointDaily(props, timeZone, now);
  if (days.length === 0) return { state: { state: 'error', message: 'The gridded forecast has no precipitation series.' }, status: { ...res.status, state: 'degraded', completeness: 'partial', detail: 'The gridded forecast has no precipitation series.' } };
  return { state: { state: 'ready', days, updateTime: isoOrNull(props?.updateTime) ?? '', timeZone }, status: res.status };
}
