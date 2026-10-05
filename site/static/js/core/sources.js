// @ts-check
/**
 * Access mode as configuration (blueprint 3.12). Every URL in the browser comes from here. DOM-free.
 * The registry is data/curated/sources.json, compiled from data/sources/*.yaml.
 */
import { APP } from '../config/app.js';
import { fetchJson, fetchLocal } from './net.js';
import { readLastGood, writeLastGood } from './lastgood.js';
import { deriveStatus } from './status.js';

/** @typedef {import('../types.js').StatusSnapshot} StatusSnapshot */
/** @typedef {import('../types.js').FetchOptions} FetchOptions */
/** @typedef {import('../types.js').SourceRecord} SourceRecord */
/** @typedef {import('../types.js').AsOfBasis} AsOfBasis */
/** @typedef {import('../types.js').FreshnessPolicy} FreshnessPolicy */
/** @typedef {Record<string, string | number | string[]>} Params */
/**
 * Extra options for getData. `onSnapshot` fires with the scheduled copy as soon as it is read, so a page can
 * paint before the direct request finishes (direct+snapshot). `asOfOf` reads the upstream's own time out of a
 * direct payload; without it the Last-Modified header is used, and then the retrieval time with basis 'retrieved'.
 * @typedef {FetchOptions & {
 *   onSnapshot?: (result: { data: unknown, status: StatusSnapshot }) => void,
 *   asOfOf?: (data: unknown) => { asOf: string | null, asOfBasis: AsOfBasis | null, completeness?: 'complete' | 'partial', detail?: string },
 *   file?: string, now?: Date
 * }} GetDataOptions
 */

/** Used when a source declares no freshness: the forecast defaults of config/app.js. */
const DEFAULT_POLICY = APP.freshness.forecasts;

/** @type {Map<string, SourceRecord>} */
const registry = new Map();
/** @type {Promise<void> | null} */
let loading = null;

/**
 * Replaces the registry with the given records. For tests and the developer harness; pages call loadSources().
 * @param {SourceRecord[]} records
 * @returns {void}
 */
export function registerSources(records) {
  registry.clear();
  for (const r of records) registry.set(r.id, r);
}

/**
 * Loads data/curated/sources.json once; concurrent callers share one request. Throws when the registry
 * cannot be loaded, because nothing on the page can name a source without it.
 * @param {AbortSignal} [signal]
 * @returns {Promise<void>}
 */
export async function loadSources(signal) {
  if (registry.size > 0) return;
  loading ??= (async () => {
    /** @type {FetchOptions} */
    const o = { priority: 1 };
    if (signal) o.signal = signal;
    const res = await fetchLocal('data/curated/sources.json', o);
    if (!res.ok) throw new Error(`The source registry could not be loaded (${res.error.message}).`);
    const doc = /** @type {{ schema?: string, items?: SourceRecord[] }} */ (res.data);
    if (!doc || doc.schema !== 'cthd.curated.sources/1' || !Array.isArray(doc.items)) {
      throw new Error('The source registry has an unexpected format.');
    }
    registerSources(doc.items);
  })().finally(() => { loading = null; });
  return loading;
}

/**
 * Throws on an unknown id (CAST registry invariant).
 * @param {string} id
 * @returns {SourceRecord}
 */
export function source(id) {
  const rec = registry.get(id);
  if (!rec) throw new Error(`Unknown source id "${id}"`);
  return rec;
}

/**
 * The record, or null: for display code that tolerates ids outside the registry (curated datasets).
 * @param {string} id
 * @returns {SourceRecord | null}
 */
export function findSource(id) {
  return registry.get(id) ?? null;
}

/**
 * @param {string | number | string[]} v
 * @returns {string}
 */
function encodeValue(v) {
  const s = Array.isArray(v) ? v.join(',') : String(v);
  return encodeURIComponent(s).replace(/%2C/gi, ',').replace(/%3A/gi, ':');
}

/**
 * Fills urlTemplate, encodes params, appends defaults. A `{name}` placeholder takes that param; `{query}`
 * takes every param not consumed by a named placeholder as a sorted query string. Without a template the
 * params become a query string on `url`.
 * @param {string} id
 * @param {Params} [params]
 * @returns {string}
 */
export function url(id, params = {}) {
  const rec = source(id);
  const used = new Set();
  const rest = () => Object.keys(params)
    .filter((k) => !used.has(k) && params[k] !== undefined && params[k] !== '')
    .sort()
    .map((k) => `${encodeURIComponent(k)}=${encodeValue(/** @type {string | number | string[]} */ (params[k]))}`)
    .join('&');
  if (!rec.urlTemplate) {
    const q = rest();
    return q ? `${rec.url}${rec.url.includes('?') ? '&' : '?'}${q}` : rec.url;
  }
  let out = rec.urlTemplate.replace(/\{(\w+)\}/g, (_, name) => {
    if (name === 'query') return '\u0000query\u0000';
    const v = params[name];
    if (v === undefined) throw new Error(`Source "${id}" needs the "${name}" parameter`);
    used.add(name);
    return encodeValue(v);
  });
  out = out.replace('\u0000query\u0000', rest());
  // An empty {query} leaves a dangling separator.
  return out.replace(/[?&]$/, '');
}

/**
 * False for status 'candidate' unless config flag enableCandidateSources is on, and for retired sources.
 * @param {string} id
 * @returns {boolean}
 */
export function isEnabled(id) {
  const rec = source(id);
  if (rec.status === 'retired') return false;
  if (rec.status === 'candidate') return APP.flags.enableCandidateSources;
  return true;
}

/**
 * @param {SourceRecord} rec
 * @returns {FreshnessPolicy}
 */
const policyOf = (rec) => rec.freshness ?? DEFAULT_POLICY;

/**
 * @param {string} id
 * @param {string} reason
 * @param {Date} now
 * @returns {{ data: null, status: StatusSnapshot }}
 */
function unavailable(id, reason, now) {
  const rec = registry.get(id);
  return {
    data: null,
    status: deriveStatus({ sourceIds: [id], policy: rec ? policyOf(rec) : DEFAULT_POLICY, now, unavailableReason: reason }),
  };
}

/**
 * Reads the scheduled copy for a source from data/live.
 * @param {SourceRecord} rec
 * @param {GetDataOptions} opts
 * @returns {Promise<{ ok: true, data: any, snapshot: { asOf: string | null, asOfBasis: AsOfBasis | null, carriedForward: boolean } } | { ok: false, reason: string }>}
 */
async function readSnapshot(rec, opts) {
  const file = opts.file ?? rec.access.snapshot?.files[0];
  if (!file) return { ok: false, reason: 'No scheduled copy is configured for this source.' };
  /** @type {FetchOptions} */
  const o = { priority: opts.priority ?? 1, cache: 'no-cache' };
  if (opts.signal) o.signal = opts.signal;
  const res = await fetchLocal(`data/live/${file}`, o);
  if (!res.ok) return { ok: false, reason: `The scheduled copy could not be read (${res.error.message}).` };
  const env = /** @type {any} */ (res.data);
  if (!env || typeof env !== 'object' || !('completeness' in env)) return { ok: false, reason: 'The scheduled copy has an unexpected format.' };
  if (env.completeness === 'rejected') {
    return { ok: false, reason: env.failure?.message ? `The scheduled copy was rejected: ${env.failure.message}` : 'The scheduled copy was rejected.' };
  }
  const asOf = typeof env.asOf === 'string' ? env.asOf : typeof env.observedAt === 'string' ? env.observedAt : null;
  return {
    ok: true,
    data: env,
    snapshot: { asOf, asOfBasis: env.asOfBasis ?? (asOf ? 'retrieved' : null), carriedForward: Boolean(env.carriedForward) },
  };
}

/**
 * Image, video, and tile sources: no fetch of the media; the stamp comes from imagery-stamps.json.
 * @param {SourceRecord} rec
 * @param {Params} params
 * @param {GetDataOptions} opts
 * @param {Date} now
 */
async function resolveMedia(rec, params, opts, now) {
  const link = url(rec.id, params);
  /** @type {StatusSnapshot} */
  let status;
  const productId = typeof params.product === 'string' ? params.product : null;
  /** @type {FetchOptions} */
  const o = { priority: 3, cache: 'no-cache' };
  if (opts.signal) o.signal = opts.signal;
  const res = await fetchLocal('data/live/imagery-stamps.json', o);
  const items = res.ok ? /** @type {any} */ (res.data)?.items : null;
  const stamp = Array.isArray(items) && productId ? items.find((/** @type {any} */ i) => i.productId === productId) : null;
  if (stamp?.lastModified) {
    status = deriveStatus({
      sourceIds: [rec.id], policy: policyOf(rec), now,
      direct: { ok: true, asOf: stamp.lastModified, asOfBasis: 'issued', completeness: 'complete' },
    });
  } else {
    // The source publishes no usable time for this product: say so, never imply currency.
    status = {
      state: 'degraded', asOf: now.toISOString(), asOfBasis: 'retrieved', sourceIds: [rec.id], origin: 'direct',
      completeness: 'partial', checkedAt: now.toISOString(), detail: 'The source did not publish an update time for this image.',
    };
  }
  return { data: link, status };
}

/**
 * Resolves by access.mode: direct, direct+snapshot, snapshot, image, video, tiles, link, build.
 * @param {string} id
 * @param {Params} [params]
 * @param {GetDataOptions} [opts]
 * @returns {Promise<{ data: unknown, status: StatusSnapshot }>}
 */
export async function getData(id, params = {}, opts = {}) {
  const rec = source(id);
  const now = opts.now ?? new Date();
  const policy = policyOf(rec);

  if (!isEnabled(id)) return unavailable(id, 'Not yet enabled', now);

  switch (rec.access.mode) {
    case 'build':
      return unavailable(id, 'This source is used only when the site is built; browsers never request it.', now);
    case 'link':
      return unavailable(id, `This source is a reference page only. See ${rec.attribution || rec.owner}.`, now);
    case 'image':
    case 'video':
    case 'tiles':
      return resolveMedia(rec, params, opts, now);
    case 'snapshot': {
      const snap = await readSnapshot(rec, opts);
      if (!snap.ok) return unavailable(id, snap.reason, now);
      return { data: snap.data, status: deriveStatus({ sourceIds: [id], policy, now, snapshot: snap.snapshot }) };
    }
    case 'direct+snapshot': {
      const snap = await readSnapshot(rec, opts);
      if (snap.ok) opts.onSnapshot?.({ data: snap.data, status: deriveStatus({ sourceIds: [id], policy, now, snapshot: snap.snapshot, direct: 'pending' }) });
      const res = await fetchJson(id, { ...opts, params });
      if (res.ok) return { data: res.data, status: directStatus(rec, res, opts, policy, now) };
      if (snap.ok) {
        return { data: snap.data, status: deriveStatus({ sourceIds: [id], policy, now, snapshot: snap.snapshot, direct: { ok: false, error: res.error } }) };
      }
      return unavailable(id, `${snap.reason} The direct request also failed (${res.error.message}).`, now);
    }
    case 'direct':
    default: {
      const requestUrl = url(id, params);
      const res = await fetchJson(id, { ...opts, params });
      if (res.ok) {
        const status = directStatus(rec, res, opts, policy, now);
        if (status.asOf) writeLastGood(id, requestUrl, { asOf: status.asOf, data: res.data });
        return { data: res.data, status };
      }
      const saved = readLastGood(id, requestUrl);
      if (saved) {
        return {
          data: saved.data,
          status: deriveStatus({ sourceIds: [id], policy, now, direct: { ok: false, error: res.error }, device: { asOf: saved.asOf, asOfBasis: 'retrieved' } }),
        };
      }
      return unavailable(id, `${rec.attribution || rec.owner} could not be reached (${res.error.message}).`, now);
    }
  }
}

/**
 * @param {SourceRecord} rec
 * @param {Extract<import('../types.js').NetResult, { ok: true }>} res
 * @param {GetDataOptions} opts
 * @param {FreshnessPolicy} policy
 * @param {Date} now
 * @returns {StatusSnapshot}
 */
function directStatus(rec, res, opts, policy, now) {
  const own = opts.asOfOf?.(res.data);
  // Last-Modified is an HTTP date; statuses carry ISO 8601.
  const modified = res.lastModified && !Number.isNaN(Date.parse(res.lastModified)) ? new Date(res.lastModified).toISOString() : null;
  const asOf = own?.asOf ?? modified ?? now.toISOString();
  const asOfBasis = own?.asOf ? (own.asOfBasis ?? 'retrieved') : modified ? 'issued' : 'retrieved';
  return deriveStatus({
    sourceIds: [rec.id], policy, now,
    direct: { ok: true, asOf, asOfBasis, completeness: own?.completeness ?? 'complete', ...(own?.detail ? { detail: own.detail } : {}) },
  });
}
