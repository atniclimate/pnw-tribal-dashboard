// @ts-check
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import vm from 'node:vm';

const source = await readFile(new URL('../../../site/sw.js', import.meta.url), 'utf8');
const BASE = 'https://example.test/pnw-tribal-dashboard/';

/** A browser-independent worker harness exercises actual fetch events and CacheStorage. */
function harness() {
  /** @type {Map<string, Map<string, Response>>} */
  const stores = new Map();
  /** @type {Record<string, (event: any) => void>} */
  const listeners = {};
  /** @type {unknown[]} */
  const messages = [];
  let online = true;
  let killed = false;
  let unregistered = false;
  let status = 200;
  let noStore = false;
  let afterDelete = async () => {};
  let body = JSON.stringify({ observedAt: '2026-10-05T07:00:00Z', items: [] });
  /** @param {Request | string} request */
  const key = (request) => typeof request === 'string' ? request : request.url;
  const cacheStorage = {
    keys: async () => [...stores.keys()],
    delete: async (/** @type {string} */ name) => stores.delete(name),
    open: async (/** @type {string} */ name) => {
      if (!stores.has(name)) stores.set(name, new Map());
      const rows = /** @type {Map<string, Response>} */ (stores.get(name));
      return {
        keys: async () => [...rows.keys()].map((url) => new Request(url)),
        match: async (/** @type {Request | string} */ request) => rows.get(key(request))?.clone(),
        delete: async (/** @type {Request | string} */ request) => {
          const deleted = rows.delete(key(request));
          await afterDelete();
          return deleted;
        },
        put: async (/** @type {Request | string} */ request, /** @type {Response} */ response) => { rows.set(key(request), response.clone()); },
      };
    },
  };
  const context = {
    URL, Request, Response, Headers, AbortController, setTimeout, clearTimeout, caches: cacheStorage,
    location: { href: `${BASE}sw.js` },
    registration: { unregister: async () => { unregistered = true; return true; } },
    clients: { claim: async () => {}, get: async () => ({ postMessage: (/** @type {unknown} */ value) => messages.push(value) }) },
    addEventListener: (/** @type {string} */ kind, /** @type {(event: any) => void} */ callback) => { listeners[kind] = callback; },
    fetch: async (/** @type {Request | string} */ request) => {
      if (!online) throw new Error('offline');
      return new Response(key(request).endsWith('build-info.json') ? JSON.stringify({ swDisabled: killed }) : body,
        { status, headers: { 'Content-Type': 'application/json', ...(noStore ? { 'Cache-Control': 'no-store' } : {}) } });
    },
  };
  vm.runInNewContext(source, context);
  /** @param {string} kind @param {string} [path] @param {string} [mode] @param {string} [method] */
  async function fire(kind, path = '', mode = 'cors', method = 'GET') {
    /** @type {Promise<unknown>[]} */
    const waiting = [];
    /** @type {Promise<Response> | null} */
    let result = null;
    listeners[kind]?.({ request: { url: new URL(path, BASE).href, method, mode, headers: new Headers() }, clientId: 'test-client',
      waitUntil: (/** @type {Promise<unknown>} */ promise) => waiting.push(promise),
      respondWith: (/** @type {Promise<Response>} */ promise) => { result = promise; } });
    const response = await /** @type {Promise<Response> | null} */ (result);
    await Promise.all(waiting);
    return response;
  }
  return { stores, messages, fire, setOnline: (/** @type {boolean} */ value) => { online = value; },
    setBody: (/** @type {string} */ value) => { body = value; },
    setStatus: (/** @type {number} */ value) => { status = value; }, setNoStore: () => { noStore = true; },
    setDeleteHook: (/** @type {() => Promise<void>} */ callback) => { afterDelete = callback; },
    kill: () => { killed = true; }, unregistered: () => unregistered };
}

test('live-data fallback marks the saved response and preserves observation timestamps', async () => {
  const h = harness();
  const fresh = await h.fire('fetch', 'data/live/alerts.json');
  assert.equal(fresh?.headers.get('X-CTHD-Cache'), null);
  const expected = await fresh?.json();
  h.setOnline(false);
  const saved = await h.fire('fetch', 'data/live/alerts.json');
  assert.equal(saved?.headers.get('X-CTHD-Cache'), 'cached');
  assert.deepEqual(await saved?.json(), expected);
  assert.equal(h.messages.length, 1);
});

test('an offline request without a copy stays unavailable', async () => {
  const h = harness();
  h.setOnline(false);
  assert.equal((await h.fire('fetch', 'data/live/alerts.json'))?.status, 503);
});

test('concurrent offline reads cannot miss a saved alert during its LRU refresh', async () => {
  const h = harness();
  const fresh = await h.fire('fetch', 'data/live/alerts.json');
  const expected = await fresh?.text();
  h.setOnline(false);
  let announceDeletion = () => {};
  let releaseDeletion = () => {};
  const deleted = new Promise((resolve) => { announceDeletion = () => resolve(undefined); });
  const held = new Promise((resolve) => { releaseDeletion = () => resolve(undefined); });
  h.setDeleteHook(async () => { announceDeletion(); await held; });
  const first = h.fire('fetch', 'data/live/alerts.json');
  await deleted;
  const second = h.fire('fetch', 'data/live/alerts.json');
  // Let the second request reach the cache while the first LRU operation is
  // deliberately between delete and put. Its lookup must wait for that write.
  await new Promise((resolve) => setImmediate(resolve));
  releaseDeletion();
  for (const response of await Promise.all([first, second])) {
    assert.equal(response?.status, 200);
    assert.equal(response?.headers.get('X-CTHD-Cache'), 'cached');
    assert.equal(await response?.text(), expected);
  }
});

test('a failed LRU refresh still returns the saved alert already read', async () => {
  const h = harness();
  const fresh = await h.fire('fetch', 'data/live/alerts.json');
  const expected = await fresh?.text();
  h.setOnline(false);
  h.setDeleteHook(async () => { throw new Error('storage denied'); });
  const response = await h.fire('fetch', 'data/live/alerts.json');
  assert.equal(response?.status, 200);
  assert.equal(response?.headers.get('X-CTHD-Cache'), 'cached');
  assert.equal(await response?.text(), expected);
});

test('no-store responses are not available offline and a deleted resource is evicted', async () => {
  const privateResponse = harness();
  privateResponse.setNoStore();
  await privateResponse.fire('fetch', 'data/live/alerts.json');
  privateResponse.setOnline(false);
  assert.equal((await privateResponse.fire('fetch', 'data/live/alerts.json'))?.status, 503);
  const deleted = harness();
  await deleted.fire('fetch', 'data/live/alerts.json');
  deleted.setStatus(410);
  assert.equal((await deleted.fire('fetch', 'data/live/alerts.json'))?.status, 410);
  deleted.setOnline(false);
  assert.equal((await deleted.fire('fetch', 'data/live/alerts.json'))?.status, 503);
});

test('cross-origin, outside-scope, and non-GET requests bypass the worker', async () => {
  const h = harness();
  assert.equal(await h.fire('fetch', 'https://upstream.example/alerts'), null);
  assert.equal(await h.fire('fetch', '/other-app/data/live/x.json'), null);
  assert.equal(await h.fire('fetch', 'data/live/alerts.json', 'cors', 'POST'), null);
  assert.equal(h.stores.size, 0);
});

test('query-string navigation reuses the saved page shell without caching each selection', async () => {
  const h = harness();
  h.setBody('<!doctype html><title>Contacts</title>');
  await h.fire('fetch', 'contacts/?nation=one', 'navigate');
  h.setOnline(false);
  const response = await h.fire('fetch', 'contacts/?nation=two', 'navigate');
  assert.equal(response?.status, 200);
  assert.match(await response?.text() ?? '', /Contacts/);
  assert.equal(h.stores.get('cthd-shell-development')?.size, 1);
  assert.equal(h.messages.length, 0, 'navigation must not await its not-yet-ready destination client');
});

test('the data cache evicts the oldest entry before exceeding its bounded budget', async () => {
  const h = harness();
  h.setBody('x'.repeat(9 * 1024 * 1024));
  await h.fire('fetch', 'data/live/one.json');
  await h.fire('fetch', 'data/live/two.json');
  const rows = h.stores.get('cthd-data');
  assert.equal(rows?.size, 1);
  assert.ok(rows?.has(`${BASE}data/live/two.json`));
});

test('the kill switch clears only dashboard caches and unregisters', async () => {
  const h = harness();
  await h.fire('fetch', 'data/live/alerts.json');
  h.stores.set('another-app-cache', new Map());
  h.kill();
  await h.fire('activate');
  assert.equal(h.unregistered(), true);
  assert.deepEqual([...h.stores.keys()], ['another-app-cache']);
  assert.equal(await h.fire('fetch', 'data/live/alerts.json'), null);
});
