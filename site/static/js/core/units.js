// @ts-check
/**
 * Units read from payloads, never assumed; zero versus sentinel (blueprint 3.10). DOM-free.
 * A real zero is a reading. null, NaN, and agency sentinels are "No current reading".
 */

export const NO_READING = 'No current reading';

const SENTINELS = new Set([-999999, -999, -9999]);
const FT_PER_M = 3.280839895;
const MM_PER_IN = 25.4;
const CFS_PER_M3S = 35.3146667;

// Agency stages are relative to the station's datum, not water depth. Mountain lake and reservoir
// elevations legitimately exceed 2,000 ft. Share the same broad corruption guard with snapshots.
// https://api.water.noaa.gov/about/hydrograph
export const STAGE_FT_MIN = -50;
export const STAGE_FT_MAX = 20_000;

/** Plausible [min, max] per unit; values outside are sentinels or sensor faults, never readings. */
/** @type {Readonly<Record<string, readonly [number, number]>>} */
const RANGES = Object.freeze({
  ft: [STAGE_FT_MIN, STAGE_FT_MAX],
  m: [STAGE_FT_MIN / FT_PER_M, STAGE_FT_MAX / FT_PER_M],
  mm: [0, 5000],
  in: [0, 200],
  C: [-90, 60],
  F: [-130, 140],
  cfs: [0, 3_000_000],
  kcfs: [0, 3000],
  'm3/s': [0, 90_000],
});

/**
 * Accepts WMO and agency spellings ('wmoUnit:degC', 'degF', 'm3/s', 'm³/s') and returns a short key.
 * @param {string | undefined} unit
 * @returns {string}
 */
export function normalizeUnit(unit) {
  if (!unit) return '';
  const u = unit.replace(/^wmoUnit:/, '').replace('³', '3');
  if (u === 'degC') return 'C';
  if (u === 'degF') return 'F';
  if (u === 'm3/s' || u === 'm3_s-1') return 'm3/s';
  if (u === 'ft_us' || u === 'feet') return 'ft';
  return u;
}

/**
 * The sanctioned replacement for parseFloat(x) || null (which lint bans): 0 stays 0.
 * @param {unknown} value
 * @returns {number | null}
 */
export function toNumberOrNull(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') {
    const t = value.trim();
    if (t === '') return null;
    const n = Number(t);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/**
 * null, NaN, USGS -999999, NWPS -999 and -9999, and per-unit out-of-range values.
 * @param {number | null | undefined} value
 * @param {string} [unit]
 * @returns {boolean}
 */
export function isMissingReading(value, unit) {
  if (value === null || value === undefined || typeof value !== 'number' || !Number.isFinite(value)) return true;
  if (SENTINELS.has(value)) return true;
  const range = RANGES[normalizeUnit(unit)];
  return range !== undefined && (value < range[0] || value > range[1]);
}

/**
 * Nation default, overridden by units= or the stored preference; native when no Nation.
 * @param {'us' | 'metric' | null} nationUnits
 * @param {'us' | 'metric' | null} override
 * @returns {'us' | 'metric' | 'native'}
 */
export function unitSystemFor(nationUnits, override) {
  return override ?? nationUnits ?? 'native';
}

/**
 * @param {number} n
 * @param {number} digits
 * @returns {string}
 */
function fixed(n, digits) {
  const s = n.toFixed(digits);
  // Never print a negative zero.
  return /^-0(\.0+)?$/.test(s) ? s.slice(1) : s;
}

/**
 * Two decimals under one inch, one above; whole millimetres; "less than 0.01 in"; "No current reading".
 * @param {number | null} value
 * @param {'mm' | 'in'} unit
 * @param {'us' | 'metric' | 'native'} system
 * @returns {string}
 */
export function formatPrecipitation(value, unit, system) {
  if (isMissingReading(value, unit) || value === null) return NO_READING;
  const target = system === 'us' ? 'in' : system === 'metric' ? 'mm' : unit;
  if (target === 'in') {
    const inches = unit === 'in' ? value : value / MM_PER_IN;
    if (inches > 0 && inches < 0.005) return 'less than 0.01 in';
    return `${fixed(inches, inches < 1 ? 2 : 1)} in`;
  }
  const mm = unit === 'mm' ? value : value * MM_PER_IN;
  if (mm > 0 && mm < 0.5) return 'less than 1 mm';
  return `${fixed(mm, 0)} mm`;
}

/**
 * One decimal in feet, two in metres.
 * @param {number | null} value
 * @param {'ft' | 'm'} unit
 * @param {'us' | 'metric' | 'native'} system
 * @returns {string}
 */
export function formatStage(value, unit, system) {
  if (isMissingReading(value, unit) || value === null) return NO_READING;
  const target = system === 'us' ? 'ft' : system === 'metric' ? 'm' : unit;
  if (target === 'ft') return `${fixed(unit === 'ft' ? value : value * FT_PER_M, 1)} ft`;
  return `${fixed(unit === 'm' ? value : value / FT_PER_M, 2)} m`;
}

/**
 * Three significant figures, with thousands separators above 999.
 * @param {number} n
 * @returns {string}
 */
function sig3(n) {
  if (n === 0) return '0';
  const abs = Math.abs(n);
  if (abs >= 1000) {
    const pow = 10 ** (Math.floor(Math.log10(abs)) - 2);
    return (Math.round(n / pow) * pow).toLocaleString('en-US');
  }
  const s = n.toPrecision(3);
  return s.includes('e') ? String(Number(s)) : s;
}

/**
 * Three significant figures; kcfs above 10,000 cfs; m3/s for metric.
 * @param {number | null} value
 * @param {'cfs' | 'kcfs' | 'm3/s'} unit
 * @param {'us' | 'metric' | 'native'} system
 * @returns {string}
 */
export function formatFlow(value, unit, system) {
  if (isMissingReading(value, unit) || value === null) return NO_READING;
  const cfs = unit === 'cfs' ? value : unit === 'kcfs' ? value * 1000 : value * CFS_PER_M3S;
  const target = system === 'metric' ? 'm3/s' : system === 'us' ? 'cfs' : unit === 'm3/s' ? 'm3/s' : 'cfs';
  if (target === 'm3/s') return `${sig3(unit === 'm3/s' ? value : cfs / CFS_PER_M3S)} m³/s`;
  return cfs > 10_000 ? `${sig3(cfs / 1000)} kcfs` : `${sig3(cfs)} cfs`;
}

/**
 * Integers.
 * @param {number | null} value
 * @param {'F' | 'C'} unit
 * @param {'us' | 'metric' | 'native'} system
 * @returns {string}
 */
export function formatTemperature(value, unit, system) {
  if (isMissingReading(value, unit) || value === null) return NO_READING;
  const target = system === 'us' ? 'F' : system === 'metric' ? 'C' : unit;
  let v = value;
  if (target === 'F' && unit === 'C') v = (value * 9) / 5 + 32;
  else if (target === 'C' && unit === 'F') v = ((value - 32) * 5) / 9;
  return `${fixed(Math.round(v), 0)}°${target}`;
}
