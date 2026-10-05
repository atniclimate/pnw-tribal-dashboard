// @ts-check
/**
 * scripts/lib/http.mjs: registry enforcement, headers, timeout, retry, parse failures, fixtures, and
 * reads of the project's own deploy. A local HTTP server stands in for upstreams. Owner: lane L9.
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  USER_AGENT, createFixtureHttp, createHttp, defaultHeaders, getOwn, joinLocation, loadSourceRegistry, recordOrigins,
} from '../../../scripts/lib/http.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** @type {import('node:http').Server} */
let server;
let base = '';
/** @type {Record<string, number>} */
const hits = {};
/** @type {Record<string, string | undefined>} */
const seenHeaders = {};

before(async () => {
  server = createServer((req, res) => {
    const url = req.url ?? '/';
    hits[url] = (hits[url] ?? 0) + 1;
    seenHeaders[url] = req.headers['user-agent'];
    if (url === '/flaky') {
      if (hits[url] === 1) { res.writeHead(503); res.end(); return; }
      res.writeHead(200, { 'content-type': 'application/json', 'last-modified': 'Mon, 05 Oct 2026 06:24:12 GMT' });
      res.end('{"ok":true}');
    } else if (url === '/missing') { res.writeHead(404); res.end(); }
    else if (url === '/bad-json') { res.writeHead(200); res.end('{not json'); }
    else if (url === '/slow') { setTimeout(() => { res.writeHead(200); res.end('{}'); }, 2000); }
    else if (url === '/text') { res.writeHead(200); res.end('hello'); }
    else { res.writeHead(200); res.end('{"a":1}'); }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', () => r(undefined)));
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
});
after(() => { server.closeAllConnections(); server.close(); });

/** @param {Partial<Parameters<typeof createHttp>[0]>} [o] */
const local = (o = {}) => createHttp({ registry: new Map([['test-source', new Set([base])]]), allowHttp: true, retryDelayMs: 10, ...o });

describe('headers and registry', () => {
  test('every request identifies the project; api.weather.gov gets geo+json', () => {
    assert.equal(defaultHeaders('https://api.weather.gov/alerts/active', 'json').Accept, 'application/geo+json');
    assert.equal(defaultHeaders('https://api.weather.gov/alerts/active', 'json')['User-Agent'], USER_AGENT);
    assert.equal(defaultHeaders('https://example.org/feed', 'text').Accept, undefined);
  });

  test('recordOrigins reads url and the fixed part of urlTemplate', () => {
    assert.deepEqual([...recordOrigins({ url: 'https://api.weather.gov/alerts', urlTemplate: 'https://api.water.noaa.gov/nwps/v1/gauges/{lid}' })],
      ['https://api.weather.gov', 'https://api.water.noaa.gov']);
    assert.equal(recordOrigins({ urlTemplate: 'https://{s}.tile.example/{z}' }).size, 0);
  });

  test('an unregistered source id or origin fails without a request', async () => {
    const http = local();
    const a = await http.getJson('not-registered', `${base}/x`);
    assert.equal(a.ok, false);
    assert.equal(!a.ok && a.error.kind, 'unregistered');
    const b = await http.getJson('test-source', 'https://elsewhere.example/x');
    assert.equal(!b.ok && b.error.kind, 'unregistered');
    assert.equal(hits['/x'], undefined);
  });

  test('the default client checks the repository source registry', async () => {
    const r = await createHttp().getJson('no-such-source-id', 'https://api.weather.gov/alerts/active');
    assert.equal(!r.ok && r.error.kind, 'unregistered');
  });

  test('plain http is refused outside tests', async () => {
    const r = await createHttp({ registry: null }).getJson('any', `${base}/x`);
    assert.equal(r.ok, false);
    assert.match(!r.ok ? r.error.message : '', /only https/);
  });

  test('loadSourceRegistry tolerates a missing data/sources directory', async () => {
    const reg = await loadSourceRegistry(path.join(ROOT, 'tests', 'no-such-root'));
    assert.equal(reg.size, 0);
  });
});

describe('requests', () => {
  test('a transient 503 is retried once', async () => {
    const r = await local().getJson('test-source', `${base}/flaky`);
    assert.equal(r.ok, true);
    assert.deepEqual(r.ok && r.data, { ok: true });
    assert.equal(r.ok && r.lastModified, 'Mon, 05 Oct 2026 06:24:12 GMT');
    assert.equal(hits['/flaky'], 2);
    assert.equal(seenHeaders['/flaky'], USER_AGENT);
  });

  test('a 404 is not retried and is an http error', async () => {
    const r = await local().getJson('test-source', `${base}/missing`);
    assert.equal(!r.ok && r.error.kind, 'http');
    assert.equal(!r.ok && r.error.status, 404);
    assert.equal(hits['/missing'], 1);
  });

  test('invalid JSON is a parse error, text and HEAD succeed', async () => {
    const http = local();
    assert.equal((/** @type {any} */ (await http.getJson('test-source', `${base}/bad-json`))).error.kind, 'parse');
    const t = await http.getText('test-source', `${base}/text`);
    assert.equal(t.ok && t.data, 'hello');
    const h = await http.head('test-source', `${base}/text`);
    assert.equal(h.ok, true);
  });

  test('a slow upstream times out', async () => {
    const r = await local({ retries: 0 }).getJson('test-source', `${base}/slow`, { timeoutMs: 100 });
    assert.equal(!r.ok && r.error.kind, 'timeout');
  });

  test('an aborted task budget stops requests', async () => {
    const ctl = new AbortController();
    const p = local({ signal: ctl.signal }).getJson('test-source', `${base}/slow`);
    setTimeout(() => ctl.abort(), 50);
    const r = await p;
    assert.equal(!r.ok && r.error.kind, 'aborted');
  });
});

describe('fixtures and own deploy', () => {
  test('fixture http answers by source id and URL with the capture time', async () => {
    const http = await createFixtureHttp(path.join(ROOT, 'tests', 'fixtures', 'upstream'));
    const r = await http.getText('news-opb', 'https://www.opb.org/arc/outboundfeeds/rss/?outputType=xml');
    assert.equal(r.ok, true);
    assert.equal(r.fetchedAt, '2026-10-05T06:25:56.283Z');
    assert.ok(r.ok && !r.data.includes('javascript:alert'), 'the underived capture wins over the derived one');
    const miss = await http.getJson('news-opb', 'https://www.opb.org/other');
    assert.equal(!miss.ok && miss.error.kind, 'network');
  });

  test('getOwn returns null for absent files and URLs', async () => {
    assert.equal(await getOwn(`${base}/missing`), null);
    assert.equal(await getOwn(path.join(ROOT, 'no-such-file.json')), null);
    assert.equal(await getOwn(`${base}/text`), 'hello');
    assert.equal(joinLocation('https://h.example/data/live/', 'a.json'), 'https://h.example/data/live/a.json');
    assert.equal(joinLocation('https://h.example/data/live', 'a.json'), 'https://h.example/data/live/a.json');
  });
});
