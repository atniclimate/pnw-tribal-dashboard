// @ts-check
/**
 * Fetch with timeout, retry, priority, dedupe, and in-memory TTL (blueprint 3.2). The only place in site/
 * that calls fetch(). Never throws for network outcomes; never resolves ok on a non-OK status.
 *
 * Rules: the URL always comes from the source registry (core/sources.js); at most four concurrent upstream
 * requests per page, served by priority; 12 s timeout per attempt; two retries, only for network, timeout,
 * and HTTP 502, 503, 504, with backoff of 1 s then 3 s plus or minus 20 percent; HTTP 429 honors Retry-After
 * (seconds or an HTTP date) up to 30 s once, then returns rate-limited; other 4xx are final; offline
 * short-circuits; concurrent identical requests share one fetch.
 */
import { APP } from '../config/app.js';
import { SITE_BASE_PATH } from '../config/pages.js';
import { sharedLimiter } from './priority.js';
import { isEnabled, source, url as sourceUrl } from './sources.js';

/** @typedef {import('../types.js').FetchOptions} FetchOptions */
/** @typedef {import('../types.js').NetResult} NetResult */
/** @typedef {import('../types.js').NetError} NetError */
/** @typedef {import('../types.js').PagedResult} PagedResult */

/** Same-origin paths fetchLocal accepts: committed and generated data, plus the build marker. */
const LOCAL_PATH = /^(?:data\/(?:registry|geo|ref|curated|live)\/[A-Za-z0-9._\-/]+|build-info\.json)$/;

/**
 * Test hooks (core/net.js is deterministic under test): the sleep, the jitter source, and a URL prefix for
 * same-origin paths when there is no browser origin.
 * @type {{ sleep: (ms: number, signal?: AbortSignal) => Promise<void>, random: () => number, baseUrl: string }}
 */
const hooks = {
  sleep(ms, signal) {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) { reject(new Error('aborted')); return; }
      const t = setTimeout(resolve, ms);
      signal?.addEventListener('abort', () => { clearTimeout(t); reject(new Error('aborted')); }, { once: true });
    });
  },
  random() {
    const c = globalThis.crypto;
    return c?.getRandomValues ? (c.getRandomValues(new Uint32Array(1))[0] ?? 0) / 4_294_967_296 : 0.5;
  },
  baseUrl: '',
};

/**
 * Overrides test hooks. Production code never calls this.
 * @param {Partial<typeof hooks>} overrides
 * @returns {void}
 */
export function configureNet(overrides) {
  Object.assign(hooks, overrides);
}

/** @type {Map<string, { expires: number, result: NetResult }>} */
const ttlCache = new Map();
/** @type {Map<string, { controller: AbortController, refs: number, promise: Promise<NetResult> }>} */
const inflight = new Map();

/**
 * Drops the in-memory TTL cache (tests and Nation changes).
 * @returns {void}
 */
export function clearMemoryCache() {
  ttlCache.clear();
}

/**
 * @param {string} sourceId
 * @param {NetError} error
 * @returns {NetResult}
 */
function failure(sourceId, error) {
  return { ok: false, error, fetchedAt: new Date().toISOString(), sourceId };
}

/**
 * Seconds or an HTTP date to milliseconds, or null.
 * @param {string | null | undefined} header
 * @returns {number | null}
 */
export function parseRetryAfter(header) {
  if (!header) return null;
  const t = header.trim();
  if (/^\d+$/.test(t)) return Number(t) * 1000;
  const when = Date.parse(t);
  return Number.isNaN(when) ? null : Math.max(0, when - Date.now());
}

/**
 * @typedef {{
 *   key: string, sourceId: string, url: string, headers: Record<string, string>, timeoutMs: number,
 *   retries: number, priority: import('../types.js').Priority, parse: 'json' | 'text', limited: boolean,
 *   cache?: RequestInit['cache'] | undefined, signal: AbortSignal
 * }} Job
 */

/**
 * One attempt. Resolves to a NetResult; never rejects.
 * @param {Job} job
 * @returns {Promise<NetResult & { retryable?: boolean }>}
 */
async function attempt(job) {
  const timeoutController = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; timeoutController.abort(); }, job.timeoutMs);
  const onAbort = () => timeoutController.abort();
  job.signal.addEventListener('abort', onAbort, { once: true });
  try {
    /** @type {RequestInit} */
    const init = { method: 'GET', headers: job.headers, credentials: 'omit', signal: timeoutController.signal };
    if (job.cache) init.cache = job.cache;
    const res = await fetch(job.url, init);
    if (!res.ok) {
      const retryAfterMs = parseRetryAfter(res.headers.get('retry-after'));
      return {
        ok: false, retryable: res.status === 502 || res.status === 503 || res.status === 504,
        error: { kind: 'http', status: res.status, message: `HTTP ${res.status}`, ...(retryAfterMs !== null ? { retryAfterMs } : {}) },
        fetchedAt: new Date().toISOString(), sourceId: job.sourceId,
      };
    }
    /** @type {unknown} */
    let data;
    try {
      data = job.parse === 'text' ? await res.text() : await res.json();
    } catch (e) {
      if (timeoutController.signal.aborted) throw e;
      return { ok: false, error: { kind: 'parse', status: res.status, message: 'The response could not be read' }, fetchedAt: new Date().toISOString(), sourceId: job.sourceId };
    }
    return { ok: true, data, status: res.status, fetchedAt: new Date().toISOString(), lastModified: res.headers.get('last-modified'), sourceId: job.sourceId };
  } catch (e) {
    if (job.signal.aborted) return { ok: false, error: { kind: 'aborted', message: 'The request was canceled' }, fetchedAt: new Date().toISOString(), sourceId: job.sourceId };
    if (timedOut) {
      return { ok: false, retryable: true, error: { kind: 'timeout', message: `timed out after ${Math.round(job.timeoutMs / 1000)} s` }, fetchedAt: new Date().toISOString(), sourceId: job.sourceId };
    }
    return { ok: false, retryable: true, error: { kind: 'network', message: 'network request failed' }, fetchedAt: new Date().toISOString(), sourceId: job.sourceId };
  } finally {
    clearTimeout(timer);
    job.signal.removeEventListener('abort', onAbort);
  }
}

/**
 * @param {number} ms
 * @param {AbortSignal} signal
 * @returns {Promise<boolean>} false when aborted during the wait
 */
async function wait(ms, signal) {
  try { await hooks.sleep(ms, signal); return true; } catch { return false; }
}

/**
 * Runs a job with the priority limiter and the retry policy.
 * @param {Job} job
 * @returns {Promise<NetResult>}
 */
async function execute(job) {
  const { backoffMs, jitter, retryAfterCapMs } = APP.net;
  let tries = 0;
  let rateLimited = false;
  for (;;) {
    const result = await (job.limited
      ? sharedLimiter().run(job.priority, () => attempt(job), job.signal).catch(() => /** @type {NetResult} */ ({ ok: false, error: { kind: 'aborted', message: 'The request was canceled' }, fetchedAt: new Date().toISOString(), sourceId: job.sourceId }))
      : attempt(job));
    if (result.ok) return result;
    const retryable = /** @type {{ retryable?: boolean }} */ (result).retryable === true;
    const err = result.error;
    /** @type {NetResult} */
    const clean = { ok: false, error: err, fetchedAt: result.fetchedAt, sourceId: result.sourceId };
    if (err.kind === 'aborted') return clean;

    if (err.kind === 'http' && err.status === 429) {
      if (rateLimited) return { ...clean, error: { ...err, kind: 'rate-limited' } };
      rateLimited = true;
      const delay = Math.min(err.retryAfterMs ?? backoffMs[0] ?? 1000, retryAfterCapMs);
      if (!(await wait(delay, job.signal))) return failure(job.sourceId, { kind: 'aborted', message: 'The request was canceled' });
      continue;
    }
    if (!retryable || tries >= job.retries) return clean;
    const base = err.retryAfterMs !== undefined ? Math.min(err.retryAfterMs, retryAfterCapMs) : (backoffMs[Math.min(tries, backoffMs.length - 1)] ?? 1000);
    const delay = err.retryAfterMs !== undefined ? base : Math.round(base * (1 + (hooks.random() * 2 - 1) * jitter));
    tries += 1;
    if (!(await wait(delay, job.signal))) return failure(job.sourceId, { kind: 'aborted', message: 'The request was canceled' });
  }
}

/**
 * Dedupe: callers with the same key share one request; each caller can abort without canceling the others,
 * and the request itself is canceled only when every caller has gone.
 * @param {Job & { callerSignal?: AbortSignal | undefined, ttlMs?: number | undefined }} spec
 * @returns {Promise<NetResult>}
 */
async function shared(spec) {
  const cachedHit = spec.ttlMs ? ttlCache.get(spec.key) : undefined;
  if (cachedHit && cachedHit.expires > Date.now()) return cachedHit.result;
  if (spec.callerSignal?.aborted) return failure(spec.sourceId, { kind: 'aborted', message: 'The request was canceled' });

  let entry = inflight.get(spec.key);
  if (!entry) {
    const controller = new AbortController();
    const e = { controller, refs: 0, promise: /** @type {Promise<NetResult>} */ (Promise.resolve(/** @type {any} */ (null))) };
    e.promise = execute({ ...spec, signal: controller.signal }).finally(() => { if (inflight.get(spec.key) === e) inflight.delete(spec.key); });
    inflight.set(spec.key, e);
    entry = e;
  }
  entry.refs += 1;
  const current = entry;
  /** @type {(() => void) | undefined} */
  let onAbort;
  const aborted = new Promise((resolve) => {
    onAbort = () => resolve(failure(spec.sourceId, { kind: 'aborted', message: 'The request was canceled' }));
    spec.callerSignal?.addEventListener('abort', onAbort, { once: true });
  });
  try {
    const result = /** @type {NetResult} */ (await Promise.race([current.promise, spec.callerSignal ? aborted : current.promise]));
    if (result.ok && spec.ttlMs) ttlCache.set(spec.key, { expires: Date.now() + spec.ttlMs, result });
    return result;
  } finally {
    if (onAbort) spec.callerSignal?.removeEventListener('abort', onAbort);
    current.refs -= 1;
    if (current.refs === 0 && spec.callerSignal?.aborted) current.controller.abort();
  }
}

/**
 * Resolves a registered source to a request, or an error result.
 * @param {string} sourceId
 * @param {FetchOptions} opts
 * @param {string | null} urlOverride a next-page URL, which must stay on the source's host
 * @returns {{ ok: true, url: string, rec: import('../types.js').SourceRecord } | { ok: false, result: NetResult }}
 */
function resolve(sourceId, opts, urlOverride) {
  let rec;
  try { rec = source(sourceId); } catch {
    return { ok: false, result: failure(sourceId, { kind: 'unregistered', message: `"${sourceId}" is not a registered source` }) };
  }
  if (!isEnabled(sourceId)) return { ok: false, result: failure(sourceId, { kind: 'unregistered', message: 'Not yet enabled' }) };
  let target;
  try { target = urlOverride ?? sourceUrl(sourceId, opts.params ?? {}); } catch (e) {
    return { ok: false, result: failure(sourceId, { kind: 'unregistered', message: e instanceof Error ? e.message : 'The request could not be built' }) };
  }
  if (urlOverride !== null) {
    try {
      if (new URL(urlOverride).host !== new URL(rec.url).host) {
        return { ok: false, result: failure(sourceId, { kind: 'unregistered', message: 'The next page is not on the registered host' }) };
      }
    } catch {
      return { ok: false, result: failure(sourceId, { kind: 'unregistered', message: 'The next page address is not valid' }) };
    }
  }
  return { ok: true, url: target, rec };
}

const isOffline = () => /** @type {{ onLine?: boolean } | undefined} */ (globalThis.navigator)?.onLine === false;

/**
 * @param {string} sourceId
 * @param {FetchOptions} opts
 * @param {'json' | 'text'} parse
 * @param {string | null} [urlOverride]
 * @returns {Promise<NetResult>}
 */
async function request(sourceId, opts, parse, urlOverride = null) {
  const r = resolve(sourceId, opts, urlOverride);
  if (!r.ok) return r.result;
  if (isOffline()) return failure(sourceId, { kind: 'offline', message: 'This device is offline' });
  const { rec } = r;
  return shared({
    key: `${parse}|${r.url}`,
    sourceId,
    url: r.url,
    headers: { ...(rec.access.headers ?? {}) },
    timeoutMs: opts.timeoutMs ?? rec.access.timeoutMs ?? APP.net.timeoutMs,
    retries: opts.retries ?? rec.access.retries ?? APP.net.retries,
    priority: opts.priority ?? rec.access.priority ?? 2,
    parse,
    limited: true,
    cache: opts.cache,
    signal: /** @type {AbortSignal} */ (/** @type {unknown} */ (undefined)),
    callerSignal: opts.signal,
    ttlMs: opts.ttlMs,
  });
}

/**
 * Never throws for network outcomes; every caller handles failure explicitly. Checks response.ok before parsing.
 * @param {string} sourceId registered source id; the URL comes from core/sources.js
 * @param {FetchOptions} [opts]
 * @returns {Promise<NetResult>}
 */
export async function fetchJson(sourceId, opts = {}) {
  return request(sourceId, opts, 'json');
}

/**
 * As fetchJson, for text bodies (Area Forecast Discussion product text).
 * @param {string} sourceId
 * @param {FetchOptions} [opts]
 * @returns {Promise<import('../types.js').NetResult<string>>}
 */
export async function fetchText(sourceId, opts = {}) {
  return /** @type {Promise<import('../types.js').NetResult<string>>} */ (request(sourceId, opts, 'text'));
}

/**
 * Follows pagination up to maxPages and reports truncation. `ok` means every fetched page was ok;
 * `truncated` means more pages existed that were not fetched (page cap reached, or a later page failed).
 * Next-page URLs must stay on the source's registered host.
 * @param {string} sourceId
 * @param {FetchOptions} opts
 * @param {(data: unknown) => string | null} nextOf returns the next page URL (NWS pagination.next or an OGC next link) or null
 * @param {number} [maxPages] default 5
 * @returns {Promise<PagedResult>}
 */
export async function fetchAllPages(sourceId, opts, nextOf, maxPages = 5) {
  /** @type {NetResult[]} */
  const pages = [];
  /** @type {string | null} */
  let next = null;
  for (let i = 0; i < maxPages; i += 1) {
    const res = await request(sourceId, opts, 'json', next);
    pages.push(res);
    if (!res.ok) return { ok: false, pages, truncated: i > 0, error: res.error };
    next = nextOf(res.data);
    if (!next) return { ok: true, pages, truncated: false };
  }
  return { ok: true, pages, truncated: next !== null };
}

/**
 * Same-origin data files only (data/registry, data/geo, data/ref, data/curated, data/live, and build-info.json).
 * Not subject to the upstream concurrency limit.
 * @param {string} path site-relative data path
 * @param {FetchOptions} [opts]
 * @returns {Promise<NetResult>}
 */
export async function fetchLocal(path, opts = {}) {
  const sourceId = `local:${path}`;
  if (!LOCAL_PATH.test(path) || path.includes('..')) {
    return failure(sourceId, { kind: 'unregistered', message: 'Not a same-origin data file path' });
  }
  if (isOffline()) return failure(sourceId, { kind: 'offline', message: 'This device is offline' });
  const target = `${hooks.baseUrl}${SITE_BASE_PATH}${path}`;
  return shared({
    key: `local|${target}`,
    sourceId,
    url: target,
    headers: {},
    timeoutMs: opts.timeoutMs ?? APP.net.timeoutMs,
    retries: opts.retries ?? APP.net.retries,
    priority: opts.priority ?? 1,
    parse: 'json',
    limited: false,
    cache: opts.cache ?? (path.startsWith('data/live/') || path === 'build-info.json' ? 'no-cache' : undefined),
    signal: /** @type {AbortSignal} */ (/** @type {unknown} */ (undefined)),
    callerSignal: opts.signal,
    ttlMs: opts.ttlMs,
  });
}
