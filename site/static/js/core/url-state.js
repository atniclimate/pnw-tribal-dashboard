// @ts-check
/**
 * URL as state: query string, not hash, so it survives an iframe src, SMS sharing, and GitHub Pages
 * (blueprint 3.5). Unknown keys are preserved on every write; renamed Nation ids are rewritten silently
 * through id-redirects. parseQuery and serializeQuery are pure; the rest touch location and history. DOM module.
 */

/** @typedef {import('../types.js').UrlStateSchema} UrlStateSchema */
/** @typedef {import('../types.js').UrlState} UrlState */
/** @typedef {import('../types.js').IdRedirects} IdRedirects */

/** Same pattern as data/ids.js NATION_ID_PATTERN (core/ may not import data/). */
const NATION_ID = /^(?:us-(?:wa|or|id|ca|mt|nv|ak)-[a-z0-9]+(?:-[a-z0-9]+)*|ca-fn-[1-9][0-9]{0,4})$/;
const MAX_STRING = 200;

/** @type {IdRedirects['redirects']} */
let redirects = {};

/**
 * Supplies id-redirects.json so n= rewrites renamed ids silently. Pass null to clear.
 * @param {IdRedirects | null} doc
 * @returns {void}
 */
export function setIdRedirects(doc) {
  redirects = doc?.redirects ?? {};
}

/**
 * @param {string} id
 * @returns {string}
 */
function followRedirects(id) {
  let current = id;
  for (let hop = 0; hop < 32; hop += 1) {
    const next = Object.hasOwn(redirects, current) ? redirects[current]?.to : undefined;
    if (next === undefined || next === id) return current;
    current = next;
  }
  return current;
}

/**
 * @param {string} raw
 * @returns {string[]}
 */
const splitList = (raw) => raw.split(',').map((s) => s.trim()).filter(Boolean);

/**
 * @param {string} raw
 * @param {import('../types.js').UrlKeySpec} spec
 * @returns {UrlState[string]}
 */
function parseValue(raw, spec) {
  switch (spec.type) {
    case 'string': {
      const v = raw.trim();
      return v && v.length <= MAX_STRING ? v : undefined;
    }
    case 'list': {
      const v = splitList(raw).filter((s) => s.length <= MAX_STRING);
      return v.length ? v : undefined;
    }
    case 'enum': return spec.values?.includes(raw) ? raw : undefined;
    case 'enum-list': {
      const v = splitList(raw).filter((s) => spec.values?.includes(s));
      return v.length ? v : undefined;
    }
    case 'nation-id': {
      const id = raw.trim();
      if (!NATION_ID.test(id)) return undefined;
      const to = followRedirects(id);
      return NATION_ID.test(to) ? to : undefined;
    }
    case 'flag':
      if (raw === '' || raw === '1' || raw === 'true') return true;
      if (raw === '0' || raw === 'false') return false;
      return undefined;
    case 'int': {
      if (!/^-?\d+$/.test(raw)) return undefined;
      const n = Number(raw);
      if (!Number.isSafeInteger(n)) return undefined;
      if ((spec.min !== undefined && n < spec.min) || (spec.max !== undefined && n > spec.max)) return undefined;
      return n;
    }
    case 'latlonzoom': {
      const p = raw.split(',');
      if (p.length !== 3 || p.some((s) => !/^-?\d+(?:\.\d+)?$/.test(s.trim()))) return undefined;
      const lat = Number(p[0]);
      const lon = Number(p[1]);
      const zoom = Number(p[2]);
      if (lat < -90 || lat > 90 || lon < -180 || lon > 180 || zoom < 0 || zoom > 24) return undefined;
      return [lat, lon, zoom];
    }
    default: return undefined;
  }
}

/**
 * Pure parser: typed values; invalid values dropped; keys outside the schema ignored (but see serializeQuery).
 * @param {string} search with or without the leading '?'
 * @param {UrlStateSchema} schema
 * @returns {UrlState}
 */
export function parseQuery(search, schema) {
  const params = new URLSearchParams(search);
  /** @type {UrlState} */
  const out = {};
  for (const [key, spec] of Object.entries(schema)) {
    const raw = params.get(key);
    if (raw === null) continue;
    const value = parseValue(raw, spec);
    if (value !== undefined) out[key] = value;
  }
  return out;
}

/**
 * @param {UrlState[string]} value
 * @returns {string | null} null means remove the key
 */
function formatValue(value) {
  if (value === undefined || value === false || value === null) return null;
  if (value === true) return '1';
  if (Array.isArray(value)) {
    if (value.length === 0) return null;
    if (value.length === 3 && value.every((v) => typeof v === 'number')) {
      return `${Number(value[0].toFixed(4))},${Number(value[1].toFixed(4))},${Number(value[2].toFixed(2))}`;
    }
    return value.join(',');
  }
  return String(value);
}

/**
 * Pure serializer. Every key already in baseSearch (unknown keys, embed) is kept unless the state sets it
 * to undefined, false, or an empty list; keys are written in sorted order so equal states give equal URLs.
 * Returns '' or a string with the leading '?'.
 * @param {UrlState} state
 * @param {string} [baseSearch] existing query whose unknown keys are preserved
 * @returns {string}
 */
export function serializeQuery(state, baseSearch = '') {
  const params = new URLSearchParams(baseSearch);
  for (const [key, value] of Object.entries(state)) {
    const text = formatValue(value);
    if (text === null) params.delete(key);
    else params.set(key, text);
  }
  params.sort();
  const q = params.toString().replace(/%2C/gi, ',').replace(/%3A/gi, ':');
  return q ? `?${q}` : '';
}

/**
 * parseQuery over location.search.
 * @param {UrlStateSchema} schema
 * @returns {UrlState}
 */
export function readState(schema) {
  return parseQuery(globalThis.location?.search ?? '', schema);
}

/** @type {Set<(state: URLSearchParams) => void>} */
const listeners = new Set();
let popstateBound = false;

function notify() {
  const params = new URLSearchParams(globalThis.location?.search ?? '');
  for (const fn of [...listeners]) fn(params);
}

/**
 * Merges a patch into the URL (unknown keys kept).
 * @param {UrlState} patch
 * @param {{ push?: boolean }} [opts] replaceState for filters (default); pushState for Nation and view
 * @returns {void}
 */
export function writeState(patch, opts = {}) {
  const loc = globalThis.location;
  if (!loc) return;
  const next = `${loc.pathname}${serializeQuery(patch, loc.search)}${loc.hash}`;
  if (next !== `${loc.pathname}${loc.search}${loc.hash}`) {
    try {
      if (opts.push) globalThis.history.pushState(null, '', next);
      else globalThis.history.replaceState(null, '', next);
    } catch { /* history unavailable in this context */ }
  }
  notify();
}

/**
 * popstate and programmatic writes.
 * @param {(state: URLSearchParams) => void} fn
 * @returns {() => void}
 */
export function onStateChange(fn) {
  if (!popstateBound && typeof globalThis.addEventListener === 'function') {
    globalThis.addEventListener('popstate', notify);
    popstateBound = true;
  }
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/**
 * A link that carries the kept keys. The href's own query wins over the carried keys.
 * @param {string} href
 * @param {string[]} [keep] default ['n', 'embed', 'units', 'lowdata']
 * @returns {string}
 */
export function linkWithState(href, keep = ['n', 'embed', 'units', 'lowdata']) {
  const hashAt = href.indexOf('#');
  const hash = hashAt >= 0 ? href.slice(hashAt) : '';
  const beforeHash = hashAt >= 0 ? href.slice(0, hashAt) : href;
  const qAt = beforeHash.indexOf('?');
  const path = qAt >= 0 ? beforeHash.slice(0, qAt) : beforeHash;
  const own = new URLSearchParams(qAt >= 0 ? beforeHash.slice(qAt + 1) : '');
  const current = new URLSearchParams(globalThis.location?.search ?? '');
  for (const key of keep) {
    const v = current.get(key);
    if (v !== null && !own.has(key)) own.set(key, v);
  }
  own.sort();
  const q = own.toString().replace(/%2C/gi, ',').replace(/%3A/gi, ':');
  return `${path}${q ? `?${q}` : ''}${hash}`;
}
