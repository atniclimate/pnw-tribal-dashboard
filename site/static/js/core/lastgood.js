// @ts-check
/** Direct-source device cache: 200 KB per entry, 2 MB total, LRU eviction. Alerts use the service worker. */
import { getItem, listKeys, removeItem, setItem } from './storage.js';

export const MAX_ENTRY_BYTES = 200 * 1024;
export const MAX_TOTAL_BYTES = 2 * 1024 * 1024;
const PREFIX = 'lg:';
const INDEX = 'lgindex';

/**
 * @param {string} text
 * @returns {string}
 */
function hash(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/**
 * @param {string} sourceId
 * @param {string} url
 */
const keyFor = (sourceId, url) => `${PREFIX}${sourceId}:${hash(url)}`;

/** @returns {Record<string, number>} key to last-used epoch milliseconds */
function readIndex() {
  try {
    const raw = getItem(INDEX);
    const parsed = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch { return {}; }
}

/** @param {Record<string, number>} index */
function writeIndex(index) {
  setItem(INDEX, JSON.stringify(index));
}

/**
 * @param {string} sourceId
 * @param {string} url
 * @returns {{ asOf: string, asOfBasis?: import('../types.js').AsOfBasis, savedAt: string, data: unknown } | null}
 */
export function readLastGood(sourceId, url) {
  const key = keyFor(sourceId, url);
  try {
    const raw = getItem(key);
    if (raw === null) return null;
    const entry = JSON.parse(raw);
    if (!entry || typeof entry.asOf !== 'string' || typeof entry.savedAt !== 'string') {
      removeItem(key);
      return null;
    }
    const index = readIndex();
    index[key] = Date.now();
    writeIndex(index);
    const basis = ['issued', 'observed', 'valid', 'retrieved', 'model-run'].includes(entry.asOfBasis) ? entry.asOfBasis : undefined;
    return { asOf: entry.asOf, ...(basis ? { asOfBasis: basis } : {}), savedAt: entry.savedAt, data: entry.data };
  } catch {
    removeItem(key);
    return null;
  }
}

/**
 * @param {string} sourceId
 * @param {string} url
 * @param {{ asOf: string, asOfBasis?: import('../types.js').AsOfBasis | null, data: unknown }} entry
 * @returns {boolean}
 */
export function writeLastGood(sourceId, url, entry) {
  const key = keyFor(sourceId, url);
  try {
    const body = JSON.stringify({ asOf: entry.asOf, ...(entry.asOfBasis ? { asOfBasis: entry.asOfBasis } : {}), savedAt: new Date().toISOString(), data: entry.data });
    if (body.length > MAX_ENTRY_BYTES) return false;
    let ok = setItem(key, body);
    // A full device: drop the least recently used entries one at a time until the write fits.
    for (let guard = 0; !ok && guard < 64; guard += 1) {
      if (!evictOldest(key)) break;
      ok = setItem(key, body);
    }
    if (!ok) return false;
    const index = readIndex();
    index[key] = Date.now();
    writeIndex(index);
    evictLastGood();
    return true;
  } catch { return false; }
}

/**
 * @param {string} keep
 * @returns {boolean} false when there was nothing to remove
 */
function evictOldest(keep) {
  const index = readIndex();
  const victim = listKeys(PREFIX).filter((k) => k !== keep).sort((a, b) => (index[a] ?? 0) - (index[b] ?? 0))[0];
  if (victim === undefined) return false;
  removeItem(victim);
  delete index[victim];
  writeIndex(index);
  return true;
}

/**
 * @param {number} [reserve] characters about to be written, counted against the budget
 * @returns {void}
 */
export function evictLastGood(reserve = 0) {
  try {
    const index = readIndex();
    const entries = listKeys(PREFIX).map((key) => ({ key, size: (getItem(key) ?? '').length, used: index[key] ?? 0 }));
    let total = entries.reduce((n, e) => n + e.size, 0) + reserve;
    entries.sort((a, b) => a.used - b.used);
    for (const e of entries) {
      if (total <= MAX_TOTAL_BYTES) break;
      removeItem(e.key);
      delete index[e.key];
      total -= e.size;
    }
    for (const k of Object.keys(index)) if (!entries.some((e) => e.key === k) || !getItem(k)) delete index[k];
    writeIndex(index);
  } catch { /* storage blocked */ }
}
