// @ts-check
/**
 * core/net.js (blueprint 3.2): never throws for network outcomes, never resolves ok on a non-OK status,
 * retries only on the listed cases, honors and caps Retry-After, dedupes, applies TTL, follows pages.
 * fetch is replaced by a scripted stub; the sleep hook records waits instead of waiting.
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { clearMemoryCache, configureNet, fetchAllPages, fetchJson, fetchLocal, fetchText, parseRetryAfter } from '../../../site/static/js/core/net.js';
import { registerSources } from '../../../site/static/js/core/sources.js';
import { record } from './helpers/records.mjs';

const realFetch = globalThis.fetch;
const navDesc = Object.getOwnPropertyDescriptor(globalThis, 'navigator');

/** @type {{ url: string, init: RequestInit }[]} */
let calls = [];
/** @type {number[]} */
let sleeps = [];
/** @type {Array<(url: string, init: RequestInit) => Promise<Response> | Response>} */
let script = [];

/** @param {unknown} body @param {ResponseInit} [init] */
const json = (body, init) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' }, ...init });

beforeEach(() => {
  calls = [];
  sleeps = [];
  script = [];
  clearMemoryCache();
  registerSources([
    record({ id: 'alerts', url: 'https://api.weather.gov/alerts/active', urlTemplate: 'https://api.weather.gov/alerts/active?{query}', access: { mode: 'direct', headers: { Accept: 'application/geo+json' }, cors: /** @type {any} */ ({}) } }),
    record({ id: 'cand', status: 'candidate' }),
    record({ id: 'lazy', url: 'https://example.test/x' }),
  ]);
  configureNet({ random: () => 0.5, sleep: async (ms) => { sleeps.push(ms); }, baseUrl: 'http://localhost' });
  globalThis.fetch = /** @type {any} */ (async (/** @type {string} */ url, /** @type {RequestInit} */ init) => {
    calls.push({ url, init });
    const next = script.shift();
    if (!next) throw new TypeError('script exhausted');
    return next(url, init);
  });
});

afterEach(() => {
  globalThis.fetch = realFetch;
  if (navDesc) Object.defineProperty(globalThis, 'navigator', navDesc);
});

describe('fetchJson outcomes', () => {
  test('success returns data, status, and the Last-Modified header', async () => {
    script.push(() => json({ a: 1 }, { headers: { 'last-modified': 'Sun, 04 Oct 2026 22:00:00 GMT' } }));
    const r = await fetchJson('alerts', { params: { area: ['WA', 'OR'] } });
    assert.equal(r.ok, true);
    assert.ok(r.ok);
    assert.deepEqual(r.data, { a: 1 });
    assert.equal(r.status, 200);
    assert.equal(r.lastModified, 'Sun, 04 Oct 2026 22:00:00 GMT');
    assert.equal(r.sourceId, 'alerts');
    assert.equal(calls[0]?.url, 'https://api.weather.gov/alerts/active?area=WA,OR');
  });

  test('requests are GET, credentials omitted, with registry headers', async () => {
    script.push(() => json({}));
    await fetchJson('alerts');
    assert.equal(calls[0]?.init.method, 'GET');
    assert.equal(calls[0]?.init.credentials, 'omit');
    assert.deepEqual(calls[0]?.init.headers, { Accept: 'application/geo+json' });
  });

  test('a JSON error body on a non-OK status is an error, never data', async () => {
    script.push(() => json({ title: 'Not Found', detail: 'no such zone' }, { status: 404 }));
    const r = await fetchJson('alerts');
    assert.equal(r.ok, false);
    assert.ok(!r.ok);
    assert.equal(r.error.kind, 'http');
    assert.equal(r.error.status, 404);
    assert.equal(calls.length, 1, '404 is final');
    assert.equal('data' in r, false);
  });

  for (const status of [400, 401, 403, 404, 410, 500, 501]) {
    test(`HTTP ${status} is not retried`, async () => {
      script.push(() => json({}, { status }));
      const r = await fetchJson('alerts');
      assert.ok(!r.ok);
      assert.equal(r.error.status, status);
      assert.equal(calls.length, 1);
    });
  }

  for (const status of [502, 503, 504]) {
    test(`HTTP ${status} is retried, then succeeds`, async () => {
      script.push(() => json({}, { status }), () => json({ ok: 1 }));
      const r = await fetchJson('alerts');
      assert.ok(r.ok);
      assert.equal(calls.length, 2);
      assert.deepEqual(sleeps, [1000]);
    });
  }

  test('network errors retry twice with 1 s then 3 s backoff, then fail', async () => {
    script.push(() => { throw new TypeError('down'); }, () => { throw new TypeError('down'); }, () => { throw new TypeError('down'); });
    const r = await fetchJson('alerts');
    assert.ok(!r.ok);
    assert.equal(r.error.kind, 'network');
    assert.equal(calls.length, 3);
    assert.deepEqual(sleeps, [1000, 3000]);
  });

  test('backoff carries plus or minus 20 percent jitter', async () => {
    for (const [rand, lo, hi] of /** @type {const} */ ([[0, 800, 800], [0.999999, 1199, 1200]])) {
      sleeps = [];
      configureNet({ random: () => rand });
      script.push(() => { throw new TypeError('x'); }, () => json({}));
      await fetchJson('alerts');
      assert.ok((sleeps[0] ?? 0) >= lo && (sleeps[0] ?? 0) <= hi, `delay ${sleeps[0]}`);
      clearMemoryCache();
    }
  });

  test('retries option overrides the default and zero disables retry', async () => {
    script.push(() => { throw new TypeError('x'); });
    const r = await fetchJson('alerts', { retries: 0 });
    assert.ok(!r.ok);
    assert.equal(calls.length, 1);
  });

  test('timeout is its own kind and is retried', async () => {
    const hang = (/** @type {string} */ _u, /** @type {RequestInit} */ init) => new Promise((_res, rej) => {
      init.signal?.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError')));
    });
    script.push(/** @type {any} */ (hang), /** @type {any} */ (hang));
    const r = await fetchJson('alerts', { timeoutMs: 15, retries: 1 });
    assert.ok(!r.ok);
    assert.equal(r.error.kind, 'timeout');
    assert.match(r.error.message, /timed out after/);
    assert.equal(calls.length, 2);
  });

  test('an unparseable body is a parse error and is not retried', async () => {
    script.push(() => new Response('<html>', { status: 200 }));
    const r = await fetchJson('alerts');
    assert.ok(!r.ok);
    assert.equal(r.error.kind, 'parse');
    assert.equal(calls.length, 1);
  });

  test('never throws, whatever fetch does', async () => {
    script.push(() => { throw new Error('boom'); }, () => { throw 'string thrown'; }, () => { throw null; });
    const r = await fetchJson('alerts');
    assert.ok(!r.ok);
    assert.equal(typeof r.fetchedAt, 'string');
  });
});

describe('Retry-After and rate limits', () => {
  test('429 waits Retry-After seconds once, then retries', async () => {
    script.push(() => json({}, { status: 429, headers: { 'retry-after': '2' } }), () => json({ ok: 1 }));
    const r = await fetchJson('alerts');
    assert.ok(r.ok);
    assert.deepEqual(sleeps, [2000]);
  });

  test('Retry-After is capped at 30 s', async () => {
    script.push(() => json({}, { status: 429, headers: { 'retry-after': '600' } }), () => json({}));
    await fetchJson('alerts');
    assert.deepEqual(sleeps, [30_000]);
  });

  test('a second 429 returns rate-limited with the wait it asked for', async () => {
    script.push(() => json({}, { status: 429, headers: { 'retry-after': '5' } }), () => json({}, { status: 429, headers: { 'retry-after': '7' } }));
    const r = await fetchJson('alerts');
    assert.ok(!r.ok);
    assert.equal(r.error.kind, 'rate-limited');
    assert.equal(r.error.status, 429);
    assert.equal(r.error.retryAfterMs, 7000);
    assert.equal(calls.length, 2);
  });

  test('429 without Retry-After waits the first backoff step', async () => {
    script.push(() => json({}, { status: 429 }), () => json({}));
    await fetchJson('alerts');
    assert.deepEqual(sleeps, [1000]);
  });

  test('503 honors Retry-After in place of the backoff, capped', async () => {
    script.push(() => json({}, { status: 503, headers: { 'retry-after': '4' } }), () => json({}, { status: 503, headers: { 'retry-after': '99' } }), () => json({}));
    const r = await fetchJson('alerts');
    assert.ok(r.ok);
    assert.deepEqual(sleeps, [4000, 30_000]);
  });

  test('parseRetryAfter reads seconds, HTTP dates, and rejects junk', () => {
    assert.equal(parseRetryAfter('3'), 3000);
    assert.equal(parseRetryAfter(null), null);
    assert.equal(parseRetryAfter('soon'), null);
    const ms = parseRetryAfter(new Date(Date.now() + 10_000).toUTCString());
    assert.ok(ms !== null && ms > 8000 && ms <= 10_000);
    assert.equal(parseRetryAfter(new Date(Date.now() - 10_000).toUTCString()), 0);
  });
});

describe('registry, offline, and abort', () => {
  test('an unregistered id never reaches fetch', async () => {
    const r = await fetchJson('nope');
    assert.ok(!r.ok);
    assert.equal(r.error.kind, 'unregistered');
    assert.equal(calls.length, 0);
  });

  test('a candidate source is not requested while the flag is off', async () => {
    const r = await fetchJson('cand');
    assert.ok(!r.ok);
    assert.equal(r.error.kind, 'unregistered');
    assert.equal(r.error.message, 'Not yet enabled');
    assert.equal(calls.length, 0);
  });

  test('a template with a missing named parameter is an error result', async () => {
    registerSources([record({ id: 'pt', url: 'https://api.weather.gov/points', urlTemplate: 'https://api.weather.gov/points/{lat},{lon}' })]);
    const r = await fetchJson('pt', { params: { lat: 47.6 } });
    assert.ok(!r.ok);
    assert.equal(r.error.kind, 'unregistered');
    assert.match(r.error.message, /lon/);
  });

  test('offline short-circuits without a request', async () => {
    Object.defineProperty(globalThis, 'navigator', { value: { onLine: false }, configurable: true });
    const r = await fetchJson('alerts');
    assert.ok(!r.ok);
    assert.equal(r.error.kind, 'offline');
    assert.equal(calls.length, 0);
  });

  test('an already aborted signal returns aborted without a request', async () => {
    const ctl = new AbortController();
    ctl.abort();
    const r = await fetchJson('alerts', { signal: ctl.signal });
    assert.ok(!r.ok);
    assert.equal(r.error.kind, 'aborted');
    assert.equal(calls.length, 0);
  });

  test('aborting during a request returns aborted and cancels it', async () => {
    let seen = /** @type {AbortSignal | null | undefined} */ (null);
    script.push(((/** @type {string} */ _u, /** @type {RequestInit} */ init) => new Promise((_r, rej) => {
      seen = init.signal;
      init.signal?.addEventListener('abort', () => rej(new DOMException('x', 'AbortError')));
    })));
    const ctl = new AbortController();
    const p = fetchJson('alerts', { signal: ctl.signal });
    await new Promise((r) => setTimeout(r, 5));
    ctl.abort();
    const r = await p;
    assert.ok(!r.ok);
    assert.equal(r.error.kind, 'aborted');
    assert.equal(/** @type {AbortSignal | null | undefined} */ (seen)?.aborted, true);
  });
});

describe('dedupe and TTL', () => {
  test('replacement callers share a fresh request while the canceled fetch finishes', async () => {
    /** @type {(reason: Error) => void} */
    let rejectOld = () => {};
    /** @type {(response: Response) => void} */
    let releaseNew = () => {};
    script.push(
      () => new Promise((_resolve, reject) => { rejectOld = reject; }),
      () => new Promise((resolve) => { releaseNew = resolve; }),
    );
    const ctl = new AbortController();
    const first = fetchJson('alerts', { signal: ctl.signal });
    await new Promise((resolve) => setTimeout(resolve, 0));
    ctl.abort();
    const canceled = await first;
    assert.ok(!canceled.ok && canceled.error.kind === 'aborted');
    const second = fetchJson('alerts');
    rejectOld(new DOMException('aborted', 'AbortError'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    const third = fetchJson('alerts');
    releaseNew(json({ done: true }));
    const replacements = await Promise.all([second, third]);
    assert.ok(replacements.every((result) => result.ok));
    assert.equal(calls.length, 2, 'the old completion must not remove the replacement from dedupe');
  });

  test('concurrent identical requests share one fetch', async () => {
    script.push(() => json({ n: 1 }));
    const [a, b] = await Promise.all([fetchJson('alerts', { params: { area: 'WA' } }), fetchJson('alerts', { params: { area: 'WA' } })]);
    assert.equal(calls.length, 1);
    assert.ok(a.ok && b.ok);
  });

  test('different parameters are different requests', async () => {
    script.push(() => json({}), () => json({}));
    await Promise.all([fetchJson('alerts', { params: { area: 'WA' } }), fetchJson('alerts', { params: { area: 'OR' } })]);
    assert.equal(calls.length, 2);
  });

  test('one caller aborting does not cancel the shared request for the other', async () => {
    /** @type {(r: Response) => void} */
    let release = () => {};
    script.push(() => new Promise((res) => { release = res; }));
    const ctl = new AbortController();
    const first = fetchJson('alerts', { signal: ctl.signal });
    const second = fetchJson('alerts');
    await new Promise((r) => setTimeout(r, 5));
    ctl.abort();
    const a = await first;
    assert.ok(!a.ok && a.error.kind === 'aborted');
    release(json({ done: true }));
    const b = await second;
    assert.ok(b.ok);
    assert.equal(calls.length, 1);
  });

  test('ttlMs serves repeats from memory until cleared; failures are not cached', async () => {
    script.push(() => json({ v: 1 }), () => json({ v: 2 }));
    const a = await fetchJson('alerts', { ttlMs: 60_000 });
    const b = await fetchJson('alerts', { ttlMs: 60_000 });
    assert.equal(calls.length, 1);
    assert.deepEqual(a.ok && a.data, b.ok && b.data);
    clearMemoryCache();
    const c = await fetchJson('alerts', { ttlMs: 60_000 });
    assert.equal(calls.length, 2);
    assert.ok(c.ok && /** @type {any} */ (c.data).v === 2);

    clearMemoryCache();
    script.push(() => json({}, { status: 404 }), () => json({ v: 3 }));
    await fetchJson('alerts', { ttlMs: 60_000 });
    const d = await fetchJson('alerts', { ttlMs: 60_000 });
    assert.ok(d.ok);
  });

  test('without ttlMs nothing is cached', async () => {
    script.push(() => json({}), () => json({}));
    await fetchJson('alerts');
    await fetchJson('alerts');
    assert.equal(calls.length, 2);
  });
});

describe('fetchText, fetchAllPages, fetchLocal', () => {
  test('fetchText returns the body as a string', async () => {
    script.push(() => new Response('AREA FORECAST DISCUSSION', { status: 200 }));
    const r = await fetchText('lazy');
    assert.ok(r.ok);
    assert.equal(r.data, 'AREA FORECAST DISCUSSION');
  });

  test('fetchAllPages follows next links and stops at the end', async () => {
    script.push(() => json({ next: 'https://api.weather.gov/alerts/active?cursor=2' }), () => json({ next: null }));
    const r = await fetchAllPages('alerts', {}, (d) => /** @type {any} */ (d).next);
    assert.equal(r.ok, true);
    assert.equal(r.truncated, false);
    assert.equal(r.pages.length, 2);
    assert.equal(calls[1]?.url, 'https://api.weather.gov/alerts/active?cursor=2');
  });

  test('fetchAllPages reports truncation at the page cap', async () => {
    for (let i = 0; i < 5; i += 1) script.push(() => json({ next: 'https://api.weather.gov/alerts/active?cursor=n' }));
    const r = await fetchAllPages('alerts', {}, (d) => /** @type {any} */ (d).next, 3);
    assert.equal(r.pages.length, 3);
    assert.equal(r.truncated, true);
    assert.equal(r.ok, true);
  });

  test('a failing later page is reported, with the pages already read kept', async () => {
    script.push(() => json({ next: 'https://api.weather.gov/alerts/active?cursor=2' }), () => json({}, { status: 404 }));
    const r = await fetchAllPages('alerts', {}, (d) => /** @type {any} */ (d).next);
    assert.equal(r.ok, false);
    assert.equal(r.truncated, true);
    assert.equal(r.pages.length, 2);
    assert.equal(r.error?.status, 404);
  });

  test('a next link on another host is refused', async () => {
    script.push(() => json({ next: 'https://evil.example/alerts' }));
    const r = await fetchAllPages('alerts', {}, (d) => /** @type {any} */ (d).next);
    assert.equal(r.ok, false);
    assert.equal(r.error?.kind, 'unregistered');
    assert.equal(calls.length, 1);
  });

  test('a malformed next link is refused', async () => {
    script.push(() => json({ next: 'not a url' }));
    const r = await fetchAllPages('alerts', {}, (d) => /** @type {any} */ (d).next);
    assert.equal(r.ok, false);
    assert.equal(r.error?.kind, 'unregistered');
  });

  test('fetchLocal reads data paths under the site base, with no-cache for live files', async () => {
    script.push(() => json({ x: 1 }), () => json({ y: 1 }));
    const a = await fetchLocal('data/live/alerts.json');
    assert.ok(a.ok);
    assert.equal(calls[0]?.url, 'http://localhost/pnw-tribal-dashboard/data/live/alerts.json');
    assert.equal(calls[0]?.init.cache, 'no-cache');
    await fetchLocal('data/ref/hazards.json');
    assert.equal(calls[1]?.init.cache, undefined);
  });

  for (const bad of ['data/live/../secret.json', 'index.html', '../data/live/a.json', 'data/other/a.json', 'data/live/', 'https://evil.example/data/live/a.json']) {
    test(`fetchLocal refuses ${bad}`, async () => {
      const r = await fetchLocal(bad);
      assert.ok(!r.ok);
      assert.equal(r.error.kind, 'unregistered');
      assert.equal(calls.length, 0);
    });
  }

  test('fetchLocal allows build-info.json and short-circuits offline', async () => {
    script.push(() => json({ swDisabled: false }));
    assert.ok((await fetchLocal('build-info.json')).ok);
    Object.defineProperty(globalThis, 'navigator', { value: { onLine: false }, configurable: true });
    const r = await fetchLocal('data/live/alerts.json');
    assert.ok(!r.ok && r.error.kind === 'offline');
  });

  test('offline local reads reach a controlling worker and retain its cache marker', async () => {
    Object.defineProperty(globalThis, 'navigator', {
      value: { onLine: false, serviceWorker: { controller: {} } }, configurable: true,
    });
    script.push(() => json({ asOf: '2026-10-05T08:00:00Z' }, { headers: { 'X-CTHD-Cache': 'cached' } }));
    const local = await fetchLocal('data/live/alerts.json');
    assert.ok(local.ok);
    assert.equal(local.fromCache, true);
    assert.deepEqual(local.data, { asOf: '2026-10-05T08:00:00Z' });
    const upstream = await fetchJson('alerts');
    assert.ok(!upstream.ok && upstream.error.kind === 'offline');
    assert.equal(calls.length, 1, 'upstream requests remain offline');
  });

  test('a normal local response is not marked as cached', async () => {
    script.push(() => json({}));
    const result = await fetchLocal('data/live/alerts.json');
    assert.ok(result.ok);
    assert.equal(result.fromCache, undefined);
  });

  test('fetchLocal is not held by the upstream limiter', async () => {
    // Five slow local requests all start at once (the upstream limit is four).
    let started = 0;
    /** @type {Array<() => void>} */
    const releases = [];
    for (let i = 0; i < 5; i += 1) script.push(() => new Promise((res) => { started += 1; releases.push(() => res(json({}))); }));
    const ps = Array.from({ length: 5 }, (_, i) => fetchLocal(`data/live/f${i}.json`));
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(started, 5);
    releases.forEach((r) => r());
    await Promise.all(ps);
  });
});

describe('priority through the limiter', () => {
  test('at most four upstream requests run at once, and alerts (0) start before media (3)', async () => {
    /** @type {string[]} */
    const startedOrder = [];
    /** @type {Array<() => void>} */
    const releases = [];
    const slow = (/** @type {string} */ u) => new Promise((res) => { startedOrder.push(u.split('?')[1] ?? ''); releases.push(() => res(json({}))); });
    for (let i = 0; i < 8; i += 1) script.push(/** @type {any} */ (slow));
    const mk = (/** @type {string} */ tag, /** @type {0|1|2|3} */ priority) => fetchJson('alerts', { params: { tag }, priority });
    const ps = [mk('a1', 3), mk('a2', 3), mk('a3', 3), mk('a4', 3), mk('media', 3), mk('alert', 0)];
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(startedOrder.length, 4, 'four in flight');
    releases.shift()?.();
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(startedOrder[4], 'tag=alert', 'the priority 0 request jumps the queued priority 3 request');
    while (releases.length || startedOrder.length < 6) { releases.shift()?.(); await new Promise((r) => setTimeout(r, 5)); if (/** @type {number} */ (startedOrder.length) === 6 && releases.length === 0) break; }
    await Promise.all(ps);
  });
});
