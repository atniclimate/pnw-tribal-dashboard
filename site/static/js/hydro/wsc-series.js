// @ts-check
/** A bounded, station-specific ECCC history request, only when station detail is opened. */
import { getData } from '../core/sources.js';
import { normalizeRiverHistory } from './nwps-series.js';

/** @param {unknown} value @returns {Record<string, unknown>} */
const record = (value) => value !== null && typeof value === 'object' ? /** @type {Record<string, unknown>} */ (value) : {};

/** @param {unknown} value @param {string} station */
export function normalizeWscHistory(value, station) {
  const root = record(value);
  const features = Array.isArray(root.features) ? root.features : [];
  const data = features.map((feature) => record(record(feature).properties)).filter((p) => p.STATION_NUMBER === station).map((p) => ({ validTime: p.DATETIME, primary: p.LEVEL, secondary: p.DISCHARGE }));
  const history = normalizeRiverHistory({ observed: { primaryName: 'Water Level', primaryUnits: 'm', secondaryName: 'Discharge', secondaryUnits: 'm³/s', data } });
  const truncated = typeof root.numberMatched === 'number' && root.numberMatched > features.length;
  return { history, truncated };
}

/** @param {string} station @param {{ signal?: AbortSignal, retry?: boolean, now?: Date }} [opts] */
export async function loadWscHistory(station, opts = {}) {
  const now = opts.now ?? new Date();
  // Quarter-hour rounding gives repeated detail visits the same cache key.
  const end = Math.floor(now.getTime() / 900_000) * 900_000;
  const start = new Date(end - 72 * 3_600_000).toISOString();
  const result = await getData('eccc-hydrometric-series', {
    f: 'json', STATION_NUMBER: station, datetime: `${start}/..`, limit: 1000, sortby: '-DATETIME',
    properties: 'STATION_NUMBER,DATETIME,LEVEL,DISCHARGE,LEVEL_SYMBOL_EN,DISCHARGE_SYMBOL_EN',
  }, {
    ...(opts.signal ? { signal: opts.signal } : {}), ttlMs: opts.retry ? 0 : 900_000,
    asOfOf: (value) => {
      const parsed = normalizeWscHistory(value, station);
      return { asOf: parsed.history.observed.samples.at(-1)?.time ?? null, asOfBasis: 'valid', completeness: parsed.truncated ? 'partial' : 'complete', ...(parsed.truncated ? { detail: 'The response limit was reached. Only the newest thousand readings are shown.' } : {}) };
    },
  });
  return { history: result.data ? normalizeWscHistory(result.data, station).history : null, status: result.status };
}
