// @ts-check
/** Real NWPS stage/flow samples. No curve, missing reading, or threshold is inferred. */
import { getData } from '../core/sources.js';
import { isoOrNull } from '../forecast/nws-forecast.js';

/** @typedef {{ time: string, primary: number | null, secondary: number | null }} RiverSample */
/** @typedef {{ kind: 'observed' | 'forecast', issuedTime: string | null, primaryName: string, primaryUnit: string, secondaryName: string, secondaryUnit: string, samples: RiverSample[] }} RiverSeries */
/** @typedef {{ observed: RiverSeries, forecast: RiverSeries }} RiverHistory */

/** @param {unknown} value @returns {Record<string, unknown>} */
const record = (value) => value !== null && typeof value === 'object' ? /** @type {Record<string, unknown>} */ (value) : {};
/** @param {unknown} value @returns {number | null} */
const reading = (value) => typeof value === 'number' && Number.isFinite(value) && value !== -999 && value !== -9999 ? value : null;

/** @param {unknown} value @returns {RiverHistory} */
export function normalizeRiverHistory(value) {
  const root = record(value);
  /** @param {'observed' | 'forecast'} kind @returns {RiverSeries} */
  const series = (kind) => {
    const source = record(root[kind]);
    /** @type {Map<string, RiverSample>} */
    const samples = new Map();
    for (const raw of Array.isArray(source.data) ? source.data : []) {
      const item = record(raw);
      const time = isoOrNull(item.validTime);
      if (!time) continue;
      const primary = reading(item.primary);
      const secondary = reading(item.secondary);
      if (primary !== null || secondary !== null) samples.set(time, { time, primary, secondary });
    }
    const text = (/** @type {unknown} */ v) => typeof v === 'string' ? v : '';
    return { kind, issuedTime: isoOrNull(source.issuedTime), primaryName: text(source.primaryName), primaryUnit: text(source.primaryUnits), secondaryName: text(source.secondaryName), secondaryUnit: text(source.secondaryUnits), samples: [...samples.values()].sort((a, b) => a.time.localeCompare(b.time)) };
  };
  return { observed: series('observed'), forecast: series('forecast') };
}

/** @param {string} lid @param {{ signal?: AbortSignal, retry?: boolean }} [opts] */
export async function loadRiverHistory(lid, opts = {}) {
  const result = await getData('nwps-gauge-series', { lid: lid.toUpperCase() }, {
    ...(opts.signal ? { signal: opts.signal } : {}),
    ttlMs: opts.retry ? 0 : 300_000,
    asOfOf: (value) => {
      const history = normalizeRiverHistory(value);
      const last = history.observed.samples.at(-1);
      return { asOf: last?.time ?? history.forecast.issuedTime, asOfBasis: last ? 'valid' : 'issued', completeness: history.observed.samples.length && history.forecast.samples.length ? 'complete' : 'partial' };
    },
  });
  const history = result.data ? normalizeRiverHistory(result.data) : null;
  return { history, status: result.status };
}

/** Convert only recognized source units; unknown units stay native. */
/** @param {number} value @param {string} unit @param {'us' | 'metric' | 'native'} system */
export function riverValue(value, unit, system) {
  if (system === 'metric' && unit === 'ft') return { value: value * 0.3048, unit: 'm' };
  if (system === 'metric' && unit === 'kcfs') return { value: value * 28.316846592, unit: 'm³/s' };
  if (system === 'metric' && unit === 'cfs') return { value: value * 0.028316846592, unit: 'm³/s' };
  if (system === 'us' && unit === 'm') return { value: value / 0.3048, unit: 'ft' };
  if (system === 'us' && unit === 'm³/s') return { value: value / 0.028316846592, unit: 'cfs' };
  return { value, unit };
}
