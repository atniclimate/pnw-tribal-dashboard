// @ts-check
/**
 * Units read from payloads, never assumed; zero versus sentinel (blueprint 3.10). DOM-free.
 *
 * STUB (lane L0). Owner: lane L2. Signatures are the contract; bodies throw until the owner implements them.
 */
const NOT_IMPLEMENTED = 'not implemented';

/**
 * The sanctioned replacement for parseFloat(x) || null (which lint bans): 0 stays 0.
 * @param {unknown} value
 * @returns {number | null}
 */
export function toNumberOrNull(value) {
  throw new Error(NOT_IMPLEMENTED);
}

/**
 * null, NaN, USGS -999999, NWPS -999 and -9999, and per-unit out-of-range values.
 * @param {number | null | undefined} value
 * @param {string} [unit]
 * @returns {boolean}
 */
export function isMissingReading(value, unit) {
  throw new Error(NOT_IMPLEMENTED);
}

/**
 * Nation default, overridden by units= or the stored preference; native when no Nation.
 * @param {'us' | 'metric' | null} nationUnits
 * @param {'us' | 'metric' | null} override
 * @returns {'us' | 'metric' | 'native'}
 */
export function unitSystemFor(nationUnits, override) {
  throw new Error(NOT_IMPLEMENTED);
}

/**
 * Two decimals under one inch, one above; whole millimetres; "less than 0.01 in"; "No current reading".
 * @param {number | null} value
 * @param {'mm' | 'in'} unit
 * @param {'us' | 'metric' | 'native'} system
 * @returns {string}
 */
export function formatPrecipitation(value, unit, system) {
  throw new Error(NOT_IMPLEMENTED);
}

/**
 * One decimal in feet, two in metres.
 * @param {number | null} value
 * @param {'ft' | 'm'} unit
 * @param {'us' | 'metric' | 'native'} system
 * @returns {string}
 */
export function formatStage(value, unit, system) {
  throw new Error(NOT_IMPLEMENTED);
}

/**
 * Three significant figures.
 * @param {number | null} value
 * @param {'cfs' | 'kcfs' | 'm3/s'} unit
 * @param {'us' | 'metric' | 'native'} system
 * @returns {string}
 */
export function formatFlow(value, unit, system) {
  throw new Error(NOT_IMPLEMENTED);
}

/**
 * Integers.
 * @param {number | null} value
 * @param {'F' | 'C'} unit
 * @param {'us' | 'metric' | 'native'} system
 * @returns {string}
 */
export function formatTemperature(value, unit, system) {
  throw new Error(NOT_IMPLEMENTED);
}
