// @ts-check
/**
 * Namespaced localStorage (cthd:v1:*) for per-viewer conveniences only: recents, units, low-data, theme,
 * safety checklist ticks, and dismissed notices. Nothing that must persist reliably, nothing personal.
 * Every call is wrapped in try/catch: storage can be blocked, full, or absent. DOM module (localStorage).
 */
import { APP } from '../config/app.js';

const KEY = /^[a-z0-9][a-z0-9:_.-]*$/i;

/** @returns {Storage | null} */
function store() {
  try { return globalThis.localStorage ?? null; } catch { return null; }
}

/**
 * @param {string} key without the cthd:v1: prefix
 * @returns {string | null}
 */
export function getItem(key) {
  if (!KEY.test(key)) return null;
  try { return store()?.getItem(APP.storagePrefix + key) ?? null; } catch { return null; }
}

/**
 * False when storage is blocked or full.
 * @param {string} key
 * @param {string} value
 * @returns {boolean}
 */
export function setItem(key, value) {
  if (!KEY.test(key)) return false;
  try {
    const s = store();
    if (!s) return false;
    s.setItem(APP.storagePrefix + key, String(value));
    return true;
  } catch { return false; }
}

/**
 * @param {string} key
 * @returns {void}
 */
export function removeItem(key) {
  if (!KEY.test(key)) return;
  try { store()?.removeItem(APP.storagePrefix + key); } catch { /* storage blocked */ }
}

/**
 * Keys (without the prefix) that start with `prefix`. Used by core/lastgood.js for eviction.
 * @param {string} [prefix]
 * @returns {string[]}
 */
export function listKeys(prefix = '') {
  /** @type {string[]} */
  const out = [];
  try {
    const s = store();
    if (!s) return out;
    const full = APP.storagePrefix + prefix;
    for (let i = 0; i < s.length; i += 1) {
      const k = s.key(i);
      if (k && k.startsWith(full)) out.push(k.slice(APP.storagePrefix.length));
    }
  } catch { /* storage blocked */ }
  return out;
}
