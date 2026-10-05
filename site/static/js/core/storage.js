// @ts-check
/**
 * Namespaced localStorage (cthd:v1:*) for per-viewer conveniences only; every call wrapped in try/catch (blueprint 3.13). DOM module.
 *
 * STUB (lane L0). Owner: lane L2. Signatures are the contract; bodies throw until the owner implements them.
 */
const NOT_IMPLEMENTED = 'not implemented';

/**
 * @param {string} key without the cthd:v1: prefix
 * @returns {string | null}
 */
export function getItem(key) {
  throw new Error(NOT_IMPLEMENTED);
}

/**
 * False when storage is blocked.
 * @param {string} key
 * @param {string} value
 * @returns {boolean}
 */
export function setItem(key, value) {
  throw new Error(NOT_IMPLEMENTED);
}

/**
 * @param {string} key
 * @returns {void}
 */
export function removeItem(key) {
  throw new Error(NOT_IMPLEMENTED);
}
