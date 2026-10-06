// @ts-check
/** core/sw-register.js and data/reference.js. */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { loadReference } from '../../../site/static/js/data/reference.js';
import { clearMemoryCache, configureNet } from '../../../site/static/js/core/net.js';
import { registerServiceWorker } from '../../../site/static/js/core/sw-register.js';

const realFetch = globalThis.fetch;
/** @type {Array<[PropertyKey, PropertyDescriptor | undefined]>} */
let saved = [];
/** @type {string[]} */
let urls = [];
/** @type {() => Response} */
let respond;

/** @param {PropertyKey} k @param {unknown} v */
function setGlobal(k, v) {
  saved.push([k, Object.getOwnPropertyDescriptor(globalThis, k)]);
  Object.defineProperty(globalThis, k, { value: v, configurable: true, writable: true });
}

beforeEach(() => {
  saved = [];
  urls = [];
  clearMemoryCache();
  respond = () => new Response('{}', { status: 200 });
  configureNet({ sleep: async () => {}, baseUrl: 'http://localhost' });
  globalThis.fetch = /** @type {any} */ (async (/** @type {string} */ u) => { urls.push(u); return respond(); });
});

afterEach(() => {
  globalThis.fetch = realFetch;
  for (const [k, d] of saved.reverse()) {
    if (d) Object.defineProperty(globalThis, k, d); else delete (/** @type {any} */ (globalThis))[k];
  }
});

/** @param {{ framed?: boolean, protocol?: string, sw?: unknown }} o */
function browser(o = {}) {
  const win = { self: /** @type {any} */ (null), top: /** @type {any} */ (null) };
  win.self = win;
  win.top = o.framed ? {} : win;
  setGlobal('top', win.top);
  setGlobal('self', win.self);
  const protocol = o.protocol ?? 'https:';
  setGlobal('location', { protocol, origin: `${protocol}//example.test`, href: `${protocol}//example.test/pnw-tribal-dashboard/` });
  setGlobal('navigator', { serviceWorker: o.sw });
}

/** @returns {{ registered: string[], unregistered: number, sw: any }} */
function fakeSw() {
  /** @type {{ registered: string[], unregistered: number, sw: any }} */
  const state = { registered: [], unregistered: 0, sw: null };
  state.sw = {
    register: async (/** @type {string} */ url) => { state.registered.push(url); return { addEventListener: () => {}, waiting: null, installing: null }; },
    getRegistrations: async () => [
      { scope: 'https://example.test/pnw-tribal-dashboard/', unregister: async () => { state.unregistered += 1; return true; } },
      { scope: 'https://example.test/another-site/', unregister: async () => { throw new Error('must preserve another application'); } },
    ],
  };
  return state;
}

describe('registerServiceWorker', () => {
  test('registers in a top-level https context', async () => {
    const f = fakeSw();
    browser({ sw: f.sw });
    assert.equal(await registerServiceWorker({ scriptUrl: '/pnw-tribal-dashboard/sw.js' }), true);
    assert.deepEqual(f.registered, ['https://example.test/pnw-tribal-dashboard/sw.js']);
    assert.equal(urls[0], 'http://localhost/pnw-tribal-dashboard/build-info.json');
  });

  test('never registers inside an iframe', async () => {
    const f = fakeSw();
    browser({ framed: true, sw: f.sw });
    assert.equal(await registerServiceWorker({ scriptUrl: '/sw.js' }), false);
    assert.equal(f.registered.length, 0);
    assert.equal(urls.length, 0, 'does not even read build-info');
  });

  test('refuses worker scripts from another origin or application', async () => {
    const f = fakeSw();
    browser({ sw: f.sw });
    assert.equal(await registerServiceWorker({ scriptUrl: 'https://other.test/pnw-tribal-dashboard/sw.js' }), false);
    assert.equal(await registerServiceWorker({ scriptUrl: '/other-app/sw.js' }), false);
    assert.equal(f.registered.length, 0);
  });

  test('Save-Data registers the worker without install-time downloads', async () => {
    const f = fakeSw();
    browser({ sw: f.sw });
    setGlobal('navigator', { serviceWorker: f.sw, connection: { saveData: true } });
    assert.equal(await registerServiceWorker({ scriptUrl: '/pnw-tribal-dashboard/sw.js' }), true);
    assert.deepEqual(f.registered, ['https://example.test/pnw-tribal-dashboard/sw.js?precache=0']);
  });

  test('never registers on http, or without service worker support', async () => {
    const f = fakeSw();
    browser({ protocol: 'http:', sw: f.sw });
    assert.equal(await registerServiceWorker({ scriptUrl: '/sw.js' }), false);
    browser({ sw: undefined });
    assert.equal(await registerServiceWorker({ scriptUrl: '/sw.js' }), false);
    assert.equal(f.registered.length, 0);
  });

  test('swDisabled true unregisters existing workers and does not register', async () => {
    const f = fakeSw();
    browser({ sw: f.sw });
    respond = () => new Response(JSON.stringify({ sha: 'x', swDisabled: true }), { status: 200 });
    assert.equal(await registerServiceWorker({ scriptUrl: '/sw.js' }), false);
    assert.equal(f.unregistered, 1);
    assert.equal(f.registered.length, 0);
  });

  test('an unreadable build-info (404) still registers: the worker checks the marker itself', async () => {
    const f = fakeSw();
    browser({ sw: f.sw });
    respond = () => new Response('{}', { status: 404 });
    assert.equal(await registerServiceWorker({ scriptUrl: '/pnw-tribal-dashboard/sw.js' }), true);
    assert.equal(f.registered.length, 1);
  });

  test('a registration error is swallowed and reported as false', async () => {
    const f = fakeSw();
    f.sw.register = async () => { throw new Error('SecurityError'); };
    browser({ sw: f.sw });
    assert.equal(await registerServiceWorker({ scriptUrl: '/pnw-tribal-dashboard/sw.js' }), false);
  });

  test('a cross-origin top that throws on access is treated as framed', async () => {
    const f = fakeSw();
    browser({ sw: f.sw });
    saved.push(['top', Object.getOwnPropertyDescriptor(globalThis, 'top')]);
    Object.defineProperty(globalThis, 'top', { get() { throw new Error('cross-origin'); }, configurable: true });
    assert.equal(await registerServiceWorker({ scriptUrl: '/sw.js' }), false);
    assert.equal(f.registered.length, 0);
  });
});

describe('loadReference', () => {
  test('reads committed reference files through fetchLocal', async () => {
    respond = () => new Response(JSON.stringify({ schema: 'cthd.hazards/1' }), { status: 200 });
    const r = await loadReference('ref/hazards.json');
    assert.ok(r.ok);
    assert.equal(urls[0], 'http://localhost/pnw-tribal-dashboard/data/ref/hazards.json');
    await loadReference('geo/footprint-ugc.json');
    await loadReference('registry/nations-index.json');
    assert.equal(urls.length, 3);
  });

  test('keeps successful loads in memory', async () => {
    await loadReference('ref/hazards.json');
    await loadReference('ref/hazards.json');
    assert.equal(urls.length, 1);
  });

  test('refuses anything outside ref, geo, and registry, and any traversal', async () => {
    for (const bad of ['live/alerts.json', 'curated/sources.json', 'ref/../live/x.json', 'ref/x.txt', '/ref/x.json', 'ref/', 'x.json']) {
      const r = await loadReference(bad);
      assert.ok(!r.ok, bad);
      assert.equal(r.error.kind, 'unregistered');
    }
    assert.equal(urls.length, 0);
  });

  test('a failed load is returned, not thrown, and the signal is honored', async () => {
    respond = () => new Response('{}', { status: 404 });
    const r = await loadReference('ref/missing.json');
    assert.ok(!r.ok && r.error.status === 404);
    const ctl = new AbortController();
    ctl.abort();
    const r2 = await loadReference('ref/other.json', { signal: ctl.signal });
    assert.ok(!r2.ok && r2.error.kind === 'aborted');
  });
});
