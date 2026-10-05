// @ts-check
/**
 * The one place Node pipeline code calls fetch (blueprint 3.1, 6.4). Owner: lane L9.
 *
 * - `createHttp()` builds the `SnapshotHttp` helper handed to snapshot tasks: every request names a
 *   registered source id, goes to that source's registered origin, carries the project User-Agent, has a
 *   timeout, retries once on a transient failure, and never throws for upstream failures (it returns
 *   `{ ok: false, error }` instead, with the `NetError` kinds of `core/net.js`).
 * - `createFixtureHttp()` answers the same calls from the dated captures in `tests/fixtures/upstream/`,
 *   for dry runs and tests; a request with no capture fails as a network error, never with invented data.
 * - `getOwn()` reads files the project itself deployed (the previous live snapshot, `build-info.json`).
 */
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CORE_SCHEMA, load as loadYaml } from 'js-yaml';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * @template [T=unknown]
 * @typedef {import('../../site/static/js/types.js').NetResult<T>} NetResult
 */
/** @typedef {import('../../site/static/js/types.js').NetError} NetError */
/** @typedef {import('../../site/static/js/types.js').SnapshotHttp} SnapshotHttp */
/** @typedef {{ timeoutMs?: number, headers?: Record<string, string> }} RequestOpts */
/** @typedef {'json' | 'text' | 'head'} BodyKind */
/** @typedef {(input: string, init?: RequestInit) => Promise<Response>} FetchLike */

/** Sent on every pipeline request; api.weather.gov requires an identifying User-Agent. */
export const USER_AGENT = '(atniclimate.github.io/pnw-tribal-dashboard, climate@atnitribes.org)';
export const DEFAULT_TIMEOUT_MS = 30_000;
/** Largest body a task may download (bytes). */
export const MAX_BODY_BYTES = 64 * 1024 * 1024;
const RETRY_STATUSES = new Set([429, 500, 502, 503, 504]);
const MAX_RETRY_WAIT_MS = 10_000;

/**
 * Default request headers for a URL and body kind.
 * @param {string} url
 * @param {BodyKind} kind
 * @returns {Record<string, string>}
 */
export function defaultHeaders(url, kind) {
  /** @type {Record<string, string>} */
  const h = { 'User-Agent': USER_AGENT };
  let host = '';
  try { host = new URL(url).hostname; } catch { /* invalid URLs fail later */ }
  if (kind === 'json') h.Accept = host === 'api.weather.gov' ? 'application/geo+json' : 'application/json, application/geo+json;q=0.9';
  return h;
}

/**
 * The origins a source record allows, from its `url` and the fixed part of its `urlTemplate`.
 * An empty set means the record names no parseable origin, and the origin check is skipped.
 * @param {{ url?: unknown, urlTemplate?: unknown }} record
 * @returns {Set<string>}
 */
export function recordOrigins(record) {
  const out = new Set();
  for (const v of [record.url, record.urlTemplate]) {
    if (typeof v !== 'string') continue;
    const fixed = v.split('{')[0] ?? '';
    try {
      const u = new URL(fixed);
      if (u.hostname) out.add(u.origin);
    } catch { /* a template whose host is a placeholder */ }
  }
  return out;
}

/**
 * Load the source registry (`data/sources/*.yaml`) as id to allowed origins.
 * @param {string} root repository root
 * @returns {Promise<Map<string, Set<string>>>}
 */
export async function loadSourceRegistry(root) {
  const dir = path.join(root, 'data', 'sources');
  /** @type {Map<string, Set<string>>} */
  const reg = new Map();
  /** @type {string[]} */
  let names = [];
  try { names = (await readdir(dir)).filter((n) => n.endsWith('.yaml')).sort(); } catch { return reg; }
  for (const n of names) {
    const rec = /** @type {Record<string, unknown>} */ (loadYaml(await readFile(path.join(dir, n), 'utf8'), { schema: CORE_SCHEMA }));
    if (rec && typeof rec.id === 'string') reg.set(rec.id, recordOrigins(rec));
  }
  return reg;
}

/**
 * @param {string} sourceId
 * @param {NetError} error
 * @param {() => Date} now
 * @returns {NetResult & { ok: false }}
 */
function fail(sourceId, error, now) {
  return { ok: false, error, fetchedAt: now().toISOString(), sourceId };
}

/** @param {number} ms @param {AbortSignal | undefined} signal */
function wait(ms, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) { resolve(undefined); return; }
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(t); resolve(undefined); }, { once: true });
  });
}

/**
 * Read a response body with a size cap.
 * @param {Response} res
 * @returns {Promise<string>}
 */
async function readCapped(res) {
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) throw new Error(`body larger than ${MAX_BODY_BYTES} bytes`);
  const text = await res.text();
  if (Buffer.byteLength(text) > MAX_BODY_BYTES) throw new Error(`body larger than ${MAX_BODY_BYTES} bytes`);
  return text;
}

/**
 * @param {{
 *   registry?: Map<string, Set<string>> | null,
 *   signal?: AbortSignal,
 *   fetchImpl?: FetchLike,
 *   now?: () => Date,
 *   retries?: number,
 *   retryDelayMs?: number,
 *   allowHttp?: boolean,
 * }} [opts] `registry` defaults to this repository's data/sources/ (loaded on the first request); null disables
 *   the registry check (tests only). `allowHttp` permits http:// (tests only).
 * @returns {SnapshotHttp}
 */
export function createHttp(opts = {}) {
  /** @type {Promise<Map<string, Set<string>> | null> | null} */
  let registryOnce = null;
  const registryFor = () => (registryOnce ??= opts.registry === undefined ? loadSourceRegistry(REPO_ROOT) : Promise.resolve(opts.registry));
  const fetchImpl = opts.fetchImpl ?? fetch;
  const now = opts.now ?? (() => new Date());
  const retries = opts.retries ?? 1;
  const retryDelayMs = opts.retryDelayMs ?? 1000;

  /**
   * @param {BodyKind} kind
   * @param {string} sourceId
   * @param {string} url
   * @param {RequestOpts} [o]
   * @returns {Promise<NetResult<any>>}
   */
  async function request(kind, sourceId, url, o = {}) {
    let u;
    try { u = new URL(url); } catch { return fail(sourceId, { kind: 'network', message: `invalid URL: ${url}` }, now); }
    if (u.protocol !== 'https:' && !(opts.allowHttp && u.protocol === 'http:')) {
      return fail(sourceId, { kind: 'network', message: `only https URLs are fetched: ${url}` }, now);
    }
    const registry = await registryFor();
    if (registry) {
      const origins = registry.get(sourceId);
      if (!origins) return fail(sourceId, { kind: 'unregistered', message: `source id "${sourceId}" is not in data/sources/` }, now);
      if (origins.size > 0 && !origins.has(u.origin)) {
        return fail(sourceId, { kind: 'unregistered', message: `${u.origin} is not a registered origin of "${sourceId}"` }, now);
      }
    }
    const headers = { ...defaultHeaders(url, kind), ...(o.headers ?? {}) };
    const timeoutMs = o.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    /** @type {NetResult<any>} */
    let last = fail(sourceId, { kind: 'network', message: 'not attempted' }, now);
    for (let attempt = 0; attempt <= retries; attempt++) {
      if (opts.signal?.aborted) return fail(sourceId, { kind: 'aborted', message: 'task budget exhausted' }, now);
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(new Error('timeout')), timeoutMs);
      const onAbort = () => ctl.abort(new Error('aborted'));
      opts.signal?.addEventListener('abort', onAbort, { once: true });
      let retryAfterMs = 0;
      try {
        const res = await fetchImpl(url, { method: kind === 'head' ? 'HEAD' : 'GET', headers, signal: ctl.signal, redirect: 'follow' });
        const fetchedAt = now().toISOString();
        const lastModified = res.headers.get('last-modified');
        if (!res.ok) {
          const ra = Number(res.headers.get('retry-after'));
          retryAfterMs = Number.isFinite(ra) && ra > 0 ? Math.min(ra * 1000, MAX_RETRY_WAIT_MS) : 0;
          /** @type {NetError} */
          const error = { kind: res.status === 429 ? 'rate-limited' : 'http', status: res.status, message: `HTTP ${res.status} from ${u.host}` };
          if (retryAfterMs) error.retryAfterMs = retryAfterMs;
          last = { ok: false, error, fetchedAt, sourceId };
          await res.body?.cancel().catch(() => {});
          if (!RETRY_STATUSES.has(res.status)) return last;
        } else if (kind === 'head') {
          await res.body?.cancel().catch(() => {});
          return { ok: true, data: null, status: res.status, fetchedAt, lastModified, sourceId };
        } else {
          const text = await readCapped(res);
          if (kind === 'text') return { ok: true, data: text, status: res.status, fetchedAt, lastModified, sourceId };
          try {
            return { ok: true, data: JSON.parse(text), status: res.status, fetchedAt, lastModified, sourceId };
          } catch (e) {
            return fail(sourceId, { kind: 'parse', status: res.status, message: `invalid JSON from ${u.host}: ${/** @type {Error} */ (e).message}` }, now);
          }
        }
      } catch (e) {
        const reason = ctl.signal.reason instanceof Error ? ctl.signal.reason.message : '';
        if (opts.signal?.aborted) return fail(sourceId, { kind: 'aborted', message: 'task budget exhausted' }, now);
        last = reason === 'timeout'
          ? fail(sourceId, { kind: 'timeout', message: `no response from ${u.host} within ${timeoutMs} ms` }, now)
          : fail(sourceId, { kind: 'network', message: `${u.host}: ${/** @type {Error} */ (e).message}` }, now);
      } finally {
        clearTimeout(timer);
        opts.signal?.removeEventListener('abort', onAbort);
      }
      if (attempt < retries) await wait(retryAfterMs || retryDelayMs * (attempt + 1), opts.signal);
    }
    return last;
  }

  return {
    getJson: (sourceId, url, o) => request('json', sourceId, url, o),
    getText: (sourceId, url, o) => request('text', sourceId, url, o),
    head: (sourceId, url, o) => request('head', sourceId, url, o),
  };
}

/**
 * Fetch a file this project deployed (or a local copy of one). Returns null when absent (404, missing
 * file) and throws only for an unusable location.
 * @param {string} location https URL or local file path
 * @param {{ fetchImpl?: FetchLike, timeoutMs?: number }} [opts]
 * @returns {Promise<string | null>}
 */
export async function getOwn(location, opts = {}) {
  if (!/^https?:\/\//.test(location)) {
    try { return await readFile(location, 'utf8'); } catch { return null; }
  }
  const fetchImpl = opts.fetchImpl ?? fetch;
  try {
    const res = await fetchImpl(location, {
      headers: { 'User-Agent': USER_AGENT, 'Cache-Control': 'no-cache' },
      signal: AbortSignal.timeout(opts.timeoutMs ?? 20_000),
    });
    if (!res.ok) { await res.body?.cancel().catch(() => {}); return null; }
    return await readCapped(res);
  } catch {
    return null;
  }
}

/**
 * Download a file as raw bytes (reference-build inputs whose exact bytes are hashed). Unlike the snapshot
 * client this throws on any failure, and it is not registry-checked: callers pin the URL themselves
 * (data/pipeline/inputs.yaml). Only https URLs are fetched; the body is capped at MAX_BODY_BYTES.
 * @param {string} url
 * @param {{ fetchImpl?: FetchLike, timeoutMs?: number, maxBytes?: number }} [opts]
 * @returns {Promise<Buffer>}
 */
export async function downloadBytes(url, opts = {}) {
  if (new URL(url).protocol !== 'https:') throw new Error(`only https URLs are downloaded: ${url}`);
  const fetchImpl = opts.fetchImpl ?? fetch;
  const max = opts.maxBytes ?? MAX_BODY_BYTES * 8;
  const res = await fetchImpl(url, {
    redirect: 'follow',
    headers: { 'User-Agent': USER_AGENT, Accept: '*/*' },
    signal: AbortSignal.timeout(opts.timeoutMs ?? 300_000),
  });
  if (!res.ok) { await res.body?.cancel().catch(() => {}); throw new Error(`HTTP ${res.status} for ${url}`); }
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > max) { await res.body?.cancel().catch(() => {}); throw new Error(`body larger than ${max} bytes: ${url}`); }
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > max) throw new Error(`body larger than ${max} bytes: ${url}`);
  return buf;
}

/**
 * Join a base location (URL or directory) and a file name.
 * @param {string} base
 * @param {string} file
 */
export function joinLocation(base, file) {
  if (/^https?:\/\//.test(base)) return base.endsWith('/') ? base + file : `${base}/${file}`;
  return path.join(base, file);
}

/**
 * A `SnapshotHttp` that answers from dated fixture captures (`<dir>/<source-id>/*.meta.json`). Requests
 * match on source id and exact URL; when one URL has several captures, the underived capture wins. The result's
 * `fetchedAt` is the capture time, so a dry run never presents a fixture as a fresh observation.
 * @param {string} dir fixtures root, normally tests/fixtures/upstream
 * @returns {Promise<SnapshotHttp>}
 */
export async function createFixtureHttp(dir) {
  /** @type {Map<string, { file: string, status: number, capturedAt: string, lastModified: string | null, derived: boolean }>} */
  const byKey = new Map();
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    for (const n of (await readdir(path.join(dir, entry.name))).filter((x) => x.endsWith('.meta.json')).sort()) {
      const meta = JSON.parse(await readFile(path.join(dir, entry.name, n), 'utf8'));
      const key = `${meta.sourceId} ${meta.url}`;
      const rec = { file: path.join(dir, entry.name, meta.file), status: meta.status, capturedAt: meta.capturedAt,
        lastModified: meta.lastModified ?? null, derived: Boolean(meta.derivedFrom) };
      const prev = byKey.get(key);
      if (!prev || (prev.derived && !rec.derived)) byKey.set(key, rec);
    }
  }
  /**
   * @param {BodyKind} kind
   * @param {string} sourceId
   * @param {string} url
   * @returns {Promise<NetResult<any>>}
   */
  async function answer(kind, sourceId, url) {
    const rec = byKey.get(`${sourceId} ${url}`);
    if (!rec) return { ok: false, error: { kind: 'network', message: `no fixture capture for ${sourceId} ${url}` }, fetchedAt: new Date(0).toISOString(), sourceId };
    if (rec.status < 200 || rec.status > 299) {
      return { ok: false, error: { kind: 'http', status: rec.status, message: `HTTP ${rec.status} (fixture)` }, fetchedAt: rec.capturedAt, sourceId };
    }
    const base = { ok: /** @type {const} */ (true), status: rec.status, fetchedAt: rec.capturedAt, lastModified: rec.lastModified, sourceId };
    if (kind === 'head') return { ...base, data: null };
    const text = await readFile(rec.file, 'utf8');
    if (kind === 'text') return { ...base, data: text };
    try { return { ...base, data: JSON.parse(text) }; } catch (e) {
      return { ok: false, error: { kind: 'parse', message: /** @type {Error} */ (e).message }, fetchedAt: rec.capturedAt, sourceId };
    }
  }
  return {
    getJson: (sourceId, url) => answer('json', sourceId, url),
    getText: (sourceId, url) => answer('text', sourceId, url),
    head: (sourceId, url) => answer('head', sourceId, url),
  };
}
