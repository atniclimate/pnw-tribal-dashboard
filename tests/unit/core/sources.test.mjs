// @ts-check
/**
 * core/sources.js (blueprint 3.12): the registry, URL templating, enablement, and getData for every access
 * mode, including the status each one derives. fetch is a scripted stub; storage is in memory.
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { clearMemoryCache, configureNet } from '../../../site/static/js/core/net.js';
import { findSource, getData, isEnabled, loadSources, registerSources, source, url } from '../../../site/static/js/core/sources.js';
import { MemoryStorage } from './helpers/memory-storage.mjs';
import { record } from './helpers/records.mjs';

const realFetch = globalThis.fetch;
const lsDesc = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
/** @type {{ url: string }[]} */
let calls = [];
/** @type {Record<string, () => Response>} */
let routes = {};
/** @type {MemoryStorage} */
let mem;

/** @param {unknown} body @param {ResponseInit} [init] */
const json = (body, init) => new Response(JSON.stringify(body), { status: 200, ...init });

const ENVELOPE = {
  schema: 'cthd.live.alerts/1', id: 'alerts', sourceIds: ['nws-alerts-active'], generatedAt: '2026-10-04T22:10:00Z', observedAt: '2026-10-04T22:09:00Z',
  asOf: '2026-10-04T22:05:00Z', asOfBasis: 'issued', completeness: 'complete', carriedForward: false, failure: null, perSource: {}, diagnostics: {}, items: [],
};

beforeEach(() => {
  calls = [];
  routes = {};
  clearMemoryCache();
  mem = new MemoryStorage();
  Object.defineProperty(globalThis, 'localStorage', { value: mem, configurable: true, writable: true });
  configureNet({ random: () => 0.5, sleep: async () => {}, baseUrl: 'http://localhost' });
  globalThis.fetch = /** @type {any} */ (async (/** @type {string} */ u) => {
    calls.push({ url: u });
    for (const [needle, make] of Object.entries(routes)) if (u.includes(needle)) return make();
    throw new TypeError('no route');
  });
  registerSources([
    record({ id: 'direct-src', url: 'https://api.weather.gov/points', urlTemplate: 'https://api.weather.gov/points/{lat},{lon}', freshness: { freshForMs: 3_600_000, usableForMs: 21_600_000 } }),
    record({ id: 'alerts', url: 'https://api.weather.gov/alerts/active', urlTemplate: 'https://api.weather.gov/alerts/active?{query}', access: { mode: 'direct+snapshot', snapshot: { task: 'alerts', files: ['alerts.json'], cadenceMin: 10 }, cors: /** @type {any} */ ({}) }, freshness: { freshForMs: 900_000, usableForMs: 7_200_000 } }),
    record({ id: 'snap-only', access: { mode: 'snapshot', snapshot: { task: 'x', files: ['news.json'], cadenceMin: 30 }, cors: /** @type {any} */ ({}) } }),
    record({ id: 'img', url: 'https://www.wpc.ncep.noaa.gov/qpf', urlTemplate: 'https://www.wpc.ncep.noaa.gov/qpf/{file}', kind: 'image', access: { mode: 'image', cors: /** @type {any} */ ({}) } }),
    record({ id: 'link-src', access: { mode: 'link', cors: /** @type {any} */ ({}) } }),
    record({ id: 'build-src', access: { mode: 'build', cors: /** @type {any} */ ({}) } }),
    record({ id: 'cand', status: 'candidate' }),
    record({ id: 'retired-src', status: 'retired' }),
    record({ id: 'plain', url: 'https://example.test/api' }),
  ]);
});

afterEach(() => {
  globalThis.fetch = realFetch;
  if (lsDesc) Object.defineProperty(globalThis, 'localStorage', lsDesc); else delete (/** @type {any} */ (globalThis)).localStorage;
});

const NOW = new Date('2026-10-04T22:30:00Z');

describe('registry', () => {
  test('source() returns a record, throws on an unknown id; findSource() returns null', () => {
    assert.equal(source('plain').id, 'plain');
    assert.throws(() => source('nope'), /Unknown source id "nope"/);
    assert.equal(findSource('nope'), null);
    assert.equal(findSource('plain')?.id, 'plain');
  });

  test('isEnabled: active yes, candidate no while the flag is off, retired no', () => {
    assert.equal(isEnabled('plain'), true);
    assert.equal(isEnabled('cand'), false);
    assert.equal(isEnabled('retired-src'), false);
    assert.throws(() => isEnabled('nope'));
  });

  test('loadSources reads data/curated/sources.json once and shares concurrent loads', async () => {
    registerSources([]);
    routes['data/curated/sources.json'] = () => json({ schema: 'cthd.curated.sources/1', generatedAt: '2026-10-04T00:00:00Z', items: [record({ id: 'from-file' })] });
    await Promise.all([loadSources(), loadSources()]);
    assert.equal(calls.length, 1);
    assert.equal(source('from-file').id, 'from-file');
    await loadSources();
    assert.equal(calls.length, 1, 'already loaded');
  });

  test('loadSources throws when the file is missing or malformed, and can be retried', async () => {
    registerSources([]);
    routes['data/curated/sources.json'] = () => json({}, { status: 404 });
    await assert.rejects(loadSources(), /could not be loaded/);
    routes['data/curated/sources.json'] = () => json({ schema: 'wrong', items: [] });
    await assert.rejects(loadSources(), /unexpected format/);
    routes['data/curated/sources.json'] = () => json({ schema: 'cthd.curated.sources/1', items: [record({ id: 'ok' })] });
    await loadSources(new AbortController().signal);
    assert.equal(source('ok').id, 'ok');
  });
});

describe('url()', () => {
  test('{query} takes every parameter as a sorted, encoded query string; arrays join with commas', () => {
    assert.equal(url('alerts', { status: 'actual', area: ['WA', 'OR'] }), 'https://api.weather.gov/alerts/active?area=WA,OR&status=actual');
  });

  test('an empty {query} leaves no dangling separator', () => {
    assert.equal(url('alerts', {}), 'https://api.weather.gov/alerts/active');
    assert.equal(url('alerts', { area: '' }), 'https://api.weather.gov/alerts/active');
  });

  test('named placeholders take their parameter, encoded', () => {
    assert.equal(url('direct-src', { lat: 47.6062, lon: -122.3321 }), 'https://api.weather.gov/points/47.6062,-122.3321');
    assert.equal(url('img', { file: 'fill 94qwbg.gif' }), 'https://www.wpc.ncep.noaa.gov/qpf/fill%2094qwbg.gif');
  });

  test('a missing named parameter throws', () => {
    assert.throws(() => url('direct-src', { lat: 1 }), /needs the "lon" parameter/);
  });

  test('without a template, parameters become a query string on url', () => {
    assert.equal(url('plain'), 'https://example.test/api');
    assert.equal(url('plain', { b: 2, a: 'x y' }), 'https://example.test/api?a=x%20y&b=2');
    registerSources([record({ id: 'q', url: 'https://example.test/api?fixed=1' })]);
    assert.equal(url('q', { a: 1 }), 'https://example.test/api?fixed=1&a=1');
  });

  test('a parameter used by a named placeholder is not repeated in {query}', () => {
    registerSources([record({ id: 'mix', url: 'https://example.test/x', urlTemplate: 'https://example.test/{zone}/forecast?{query}' })]);
    assert.equal(url('mix', { zone: 'WAZ001', units: 'us' }), 'https://example.test/WAZ001/forecast?units=us');
  });

  test('values cannot break out of their position', () => {
    const u = url('plain', { q: 'a&b=c#frag?x' });
    assert.equal(u, 'https://example.test/api?q=a%26b%3Dc%23frag%3Fx');
  });
});

describe('getData: direct', () => {
  test('success derives live from Last-Modified (basis issued) and saves a device last-good', async () => {
    routes['/points/'] = () => json({ forecast: 'url' }, { headers: { 'last-modified': 'Sun, 04 Oct 2026 22:00:00 GMT' } });
    const r = await getData('direct-src', { lat: 47.6, lon: -122.3 }, { now: NOW });
    assert.deepEqual(r.data, { forecast: 'url' });
    assert.equal(r.status.state, 'live');
    assert.equal(r.status.asOf, '2026-10-04T22:00:00.000Z');
    assert.equal(r.status.asOfBasis, 'issued');
    assert.equal(r.status.origin, 'direct');
    assert.ok([...mem.map.keys()].some((k) => k.startsWith('cthd:v1:lg:direct-src:')));
  });

  test('with no source time the status is stamped retrieved at now', async () => {
    routes['/points/'] = () => json({});
    const r = await getData('direct-src', { lat: 1, lon: 2 }, { now: NOW });
    assert.equal(r.status.asOfBasis, 'retrieved');
    assert.equal(r.status.asOf, NOW.toISOString());
  });

  test('asOfOf supplies the upstream time and partial completeness', async () => {
    routes['/points/'] = () => json({ updateTime: '2026-10-04T20:00:00Z' });
    const r = await getData('direct-src', { lat: 1, lon: 2 }, {
      now: NOW,
      asOfOf: (d) => ({ asOf: /** @type {any} */ (d).updateTime, asOfBasis: 'model-run', completeness: 'partial', detail: 'Partial: one of two grids loaded' }),
    });
    assert.equal(r.status.asOf, '2026-10-04T20:00:00Z');
    assert.equal(r.status.asOfBasis, 'model-run');
    assert.equal(r.status.state, 'degraded');
    assert.equal(r.status.detail, 'Partial: one of two grids loaded');
  });

  test('an old upstream time is stale with the not-updated detail', async () => {
    routes['/points/'] = () => json({});
    const r = await getData('direct-src', { lat: 1, lon: 2 }, { now: NOW, asOfOf: () => ({ asOf: '2026-10-04T20:00:00Z', asOfBasis: 'issued' }) });
    assert.equal(r.status.state, 'stale');
    assert.match(r.status.detail ?? '', /Upstream has not updated since/);
  });

  test('failure with a device copy serves it as cached with its original time', async () => {
    routes['/points/'] = () => json({ v: 1 }, { headers: { 'last-modified': 'Sun, 04 Oct 2026 12:00:00 GMT' } });
    await getData('direct-src', { lat: 1, lon: 2 }, { now: NOW });
    clearMemoryCache();
    routes['/points/'] = () => json({}, { status: 500 });
    const r = await getData('direct-src', { lat: 1, lon: 2 }, { now: NOW });
    assert.deepEqual(r.data, { v: 1 });
    assert.equal(r.status.state, 'cached');
    assert.equal(r.status.asOf, '2026-10-04T12:00:00.000Z');
    assert.equal(r.status.detail, 'Saved on this device');
  });

  test('failure with nothing saved is unavailable, naming the source and the reason', async () => {
    routes['/points/'] = () => json({}, { status: 404 });
    const r = await getData('direct-src', { lat: 1, lon: 2 }, { now: NOW });
    assert.equal(r.data, null);
    assert.equal(r.status.state, 'unavailable');
    assert.equal(r.status.asOf, null);
    assert.match(r.status.detail ?? '', /National Weather Service could not be reached \(HTTP 404\)/);
  });
});

describe('getData: snapshot modes', () => {
  test('snapshot: reads data/live and derives the state from the envelope age', async () => {
    routes['data/live/news.json'] = () => json({ ...ENVELOPE, asOf: '2026-10-04T22:05:00Z' });
    const r = await getData('snap-only', {}, { now: NOW });
    assert.equal(r.status.state, 'live');
    assert.equal(r.status.origin, 'snapshot');
    assert.match(r.status.detail ?? '', /^Scheduled copy from /);
    assert.equal(/** @type {any} */ (r.data).id, 'alerts');
  });

  test('snapshot: a carried-forward envelope keeps its original time and says so', async () => {
    routes['data/live/news.json'] = () => json({ ...ENVELOPE, asOf: '2026-10-04T20:00:00Z', carriedForward: true });
    const r = await getData('snap-only', {}, { now: NOW });
    assert.equal(r.status.asOf, '2026-10-04T20:00:00Z');
    assert.equal(r.status.state, 'stale');
    assert.match(r.status.detail ?? '', /earlier copy/);
  });

  test('snapshot: a rejected envelope is unavailable with the runner\'s reason', async () => {
    routes['data/live/news.json'] = () => json({ ...ENVELOPE, completeness: 'rejected', asOf: null, failure: { code: 'upstream', message: 'feed unreachable', at: '2026-10-04T22:00:00Z' } });
    const r = await getData('snap-only', {}, { now: NOW });
    assert.equal(r.status.state, 'unavailable');
    assert.match(r.status.detail ?? '', /feed unreachable/);
  });

  test('snapshot: a missing file or a malformed body is unavailable', async () => {
    routes['data/live/news.json'] = () => json({}, { status: 404 });
    assert.equal((await getData('snap-only', {}, { now: NOW })).status.state, 'unavailable');
    clearMemoryCache();
    routes['data/live/news.json'] = () => json({ hello: 'world' });
    const r = await getData('snap-only', {}, { now: NOW });
    assert.match(r.status.detail ?? '', /unexpected format/);
  });

  test('snapshot: an envelope without asOf falls back to observedAt, basis retrieved', async () => {
    routes['data/live/news.json'] = () => json({ ...ENVELOPE, asOf: null, asOfBasis: null, observedAt: '2026-10-04T22:20:00Z' });
    const r = await getData('snap-only', {}, { now: NOW });
    assert.equal(r.status.asOf, '2026-10-04T22:20:00Z');
    assert.equal(r.status.asOfBasis, 'retrieved');
  });

  test('direct+snapshot: onSnapshot fires first with the pending status, then direct wins', async () => {
    routes['data/live/alerts.json'] = () => json(ENVELOPE);
    routes['api.weather.gov/alerts/active'] = () => json({ updated: 'x' }, { headers: { 'last-modified': 'Sun, 04 Oct 2026 22:28:00 GMT' } });
    let early = /** @type {import('../../../site/static/js/types.js').StatusSnapshot | null} */ (null);
    const r = await getData('alerts', { area: 'WA' }, { now: NOW, onSnapshot: (s) => { early = s.status; } });
    assert.match(early?.detail ?? '', /checking for updates/);
    assert.equal(early?.origin, 'snapshot');
    assert.deepEqual(r.data, { updated: 'x' });
    assert.equal(r.status.origin, 'direct');
    assert.equal(r.status.state, 'live');
  });

  test('direct+snapshot: a failed direct request keeps the snapshot and says why', async () => {
    routes['data/live/alerts.json'] = () => json(ENVELOPE);
    routes['api.weather.gov/alerts/active'] = () => json({}, { status: 500 });
    const r = await getData('alerts', {}, { now: NOW });
    assert.equal(/** @type {any} */ (r.data).id, 'alerts');
    assert.equal(r.status.origin, 'snapshot');
    assert.equal(r.status.detail, 'Direct request failed (HTTP 500); showing the scheduled copy');
  });

  test('direct+snapshot: both failing is unavailable, with both reasons', async () => {
    routes['data/live/alerts.json'] = () => json({}, { status: 404 });
    routes['api.weather.gov/alerts/active'] = () => json({}, { status: 500 });
    const r = await getData('alerts', {}, { now: NOW });
    assert.equal(r.status.state, 'unavailable');
    assert.match(r.status.detail ?? '', /scheduled copy could not be read/);
    assert.match(r.status.detail ?? '', /direct request also failed \(HTTP 500\)/);
  });
});

describe('getData: media, link, build, and disabled', () => {
  test('image: returns the templated URL, stamped from imagery-stamps.json', async () => {
    routes['imagery-stamps.json'] = () => json({
      items: [{ productId: 'wpc-qpf-day1', url: 'https://www.wpc.ncep.noaa.gov/qpf/fill_94qwbg.gif', status: 200, lastModified: '2026-10-04T21:45:00Z', contentLength: 50_000, checkedAt: '2026-10-04T22:10:00Z' }],
    });
    const r = await getData('img', { file: 'fill_94qwbg.gif', product: 'wpc-qpf-day1' }, { now: NOW });
    assert.equal(r.data, 'https://www.wpc.ncep.noaa.gov/qpf/fill_94qwbg.gif');
    assert.equal(r.status.asOf, '2026-10-04T21:45:00Z');
    assert.equal(r.status.asOfBasis, 'issued');
    assert.equal(r.status.state, 'live');
  });

  test('image: with no stamp the status admits it, never implying currency', async () => {
    routes['imagery-stamps.json'] = () => json({ items: [] });
    const r = await getData('img', { file: 'x.gif', product: 'unknown' }, { now: NOW });
    assert.equal(r.status.state, 'degraded');
    assert.equal(r.status.asOfBasis, 'retrieved');
    assert.match(r.status.detail ?? '', /did not publish an update time/);
  });

  test('image: a missing stamps file is the same honest degraded state', async () => {
    const r = await getData('img', { file: 'x.gif' }, { now: NOW });
    assert.equal(r.status.state, 'degraded');
    assert.ok(typeof r.data === 'string');
  });

  test('link and build sources never fetch', async () => {
    const l = await getData('link-src', {}, { now: NOW });
    const b = await getData('build-src', {}, { now: NOW });
    assert.equal(l.status.state, 'unavailable');
    assert.match(l.status.detail ?? '', /reference page only/);
    assert.equal(b.status.state, 'unavailable');
    assert.match(b.status.detail ?? '', /only when the site is built/);
    assert.equal(calls.length, 0);
  });

  test('candidate and retired sources resolve to unavailable "Not yet enabled" without a request', async () => {
    for (const id of ['cand', 'retired-src']) {
      const r = await getData(id, {}, { now: NOW });
      assert.equal(r.status.state, 'unavailable');
      assert.equal(r.status.detail, 'Not yet enabled');
    }
    assert.equal(calls.length, 0);
  });

  test('an unknown id throws (the registry invariant)', async () => {
    await assert.rejects(getData('nope'), /Unknown source id/);
  });
});
