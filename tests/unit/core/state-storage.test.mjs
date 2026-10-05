// @ts-check
/** core/store.js, core/storage.js, core/lastgood.js: change detection, namespacing, blocked storage, bounds, LRU. */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { createStore } from '../../../site/static/js/core/store.js';
import { getItem, listKeys, removeItem, setItem } from '../../../site/static/js/core/storage.js';
import { evictLastGood, MAX_ENTRY_BYTES, MAX_TOTAL_BYTES, readLastGood, writeLastGood } from '../../../site/static/js/core/lastgood.js';

/** A Storage stand-in with an optional quota and a block switch. */
class MemoryStorage {
  /** @param {{ quota?: number }} [opts] */
  constructor(opts = {}) {
    /** @type {Map<string, string>} */
    this.map = new Map();
    this.quota = opts.quota ?? Infinity;
    this.blocked = false;
  }

  get length() { return this.map.size; }

  /** @param {number} i */
  key(i) { return [...this.map.keys()][i] ?? null; }

  /** @param {string} k */
  getItem(k) { if (this.blocked) throw new Error('SecurityError'); return this.map.get(k) ?? null; }

  /** @param {string} k @param {string} v */
  setItem(k, v) {
    if (this.blocked) throw new Error('SecurityError');
    const used = [...this.map].reduce((n, [kk, vv]) => n + (kk === k ? 0 : kk.length + vv.length), 0);
    if (used + k.length + v.length > this.quota) throw new Error('QuotaExceededError');
    this.map.set(k, v);
  }

  /** @param {string} k */
  removeItem(k) { if (this.blocked) throw new Error('SecurityError'); this.map.delete(k); }
}

const desc = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
/** @type {MemoryStorage} */
let mem;

beforeEach(() => {
  mem = new MemoryStorage();
  Object.defineProperty(globalThis, 'localStorage', { value: mem, configurable: true, writable: true });
});
afterEach(() => {
  if (desc) Object.defineProperty(globalThis, 'localStorage', desc); else delete (/** @type {any} */ (globalThis)).localStorage;
});

describe('createStore', () => {
  test('get, set, and subscribe with previous state', () => {
    const s = createStore({ q: '', n: 0 });
    /** @type {Array<[object, object]>} */
    const seen = [];
    s.subscribe((next, prev) => seen.push([next, prev]));
    s.set({ q: 'skagit' });
    assert.deepEqual(s.get(), { q: 'skagit', n: 0 });
    assert.deepEqual(seen, [[{ q: 'skagit', n: 0 }, { q: '', n: 0 }]]);
  });

  test('a set that changes nothing notifies nobody (inputs are not re-rendered)', () => {
    const s = createStore({ q: 'a', n: 1 });
    let calls = 0;
    s.subscribe(() => { calls += 1; });
    s.set({ q: 'a' });
    s.set({});
    s.set({ n: 1, q: 'a' });
    assert.equal(calls, 0);
    s.set({ n: 2 });
    assert.equal(calls, 1);
  });

  test('NaN to NaN is no change; unsubscribe stops delivery; the initial object is not mutated', () => {
    const initial = { x: Number.NaN, y: 1 };
    const s = createStore(initial);
    let calls = 0;
    const off = s.subscribe(() => { calls += 1; });
    s.set({ x: Number.NaN });
    assert.equal(calls, 0);
    s.set({ y: 2 });
    off();
    s.set({ y: 3 });
    assert.equal(calls, 1);
    assert.equal(initial.y, 1);
  });

  test('a listener that unsubscribes itself during delivery does not break the others', () => {
    const s = createStore({ n: 0 });
    /** @type {string[]} */
    const log = [];
    const off = s.subscribe(() => { log.push('a'); off(); });
    s.subscribe(() => log.push('b'));
    s.set({ n: 1 });
    s.set({ n: 2 });
    assert.deepEqual(log, ['a', 'b', 'b']);
  });
});

describe('storage', () => {
  test('keys are namespaced cthd:v1:', () => {
    assert.equal(setItem('units', 'metric'), true);
    assert.equal(mem.map.get('cthd:v1:units'), 'metric');
    assert.equal(getItem('units'), 'metric');
    removeItem('units');
    assert.equal(getItem('units'), null);
  });

  test('invalid keys are refused rather than written', () => {
    assert.equal(setItem('../x', '1'), false);
    assert.equal(setItem('', '1'), false);
    assert.equal(setItem('a b', '1'), false);
    assert.equal(getItem('a b'), null);
    assert.equal(mem.map.size, 0);
  });

  test('blocked or full storage degrades to nulls and false, never throws', () => {
    mem.blocked = true;
    assert.equal(getItem('units'), null);
    assert.equal(setItem('units', 'us'), false);
    assert.doesNotThrow(() => removeItem('units'));
    assert.deepEqual(listKeys(), []);
    const small = new MemoryStorage({ quota: 10 });
    Object.defineProperty(globalThis, 'localStorage', { value: small, configurable: true, writable: true });
    assert.equal(setItem('units', 'x'.repeat(100)), false);
  });

  test('absent localStorage degrades the same way', () => {
    Object.defineProperty(globalThis, 'localStorage', { value: undefined, configurable: true, writable: true });
    assert.equal(getItem('units'), null);
    assert.equal(setItem('units', 'us'), false);
    assert.deepEqual(listKeys(), []);
  });

  test('listKeys returns the unprefixed keys under a prefix and ignores other apps', () => {
    setItem('lg:a:1', 'x');
    setItem('lg:b:2', 'y');
    setItem('units', 'us');
    mem.map.set('other-app:key', 'z');
    assert.deepEqual(listKeys('lg:').sort(), ['lg:a:1', 'lg:b:2']);
    assert.deepEqual(listKeys().sort(), ['lg:a:1', 'lg:b:2', 'units']);
  });
});

describe('lastgood', () => {
  const URL_A = 'https://api.weather.gov/points/47.6,-122.3';

  test('round-trips data with the original asOf and a savedAt', () => {
    assert.equal(writeLastGood('nws-points', URL_A, { asOf: '2026-10-04T22:00:00Z', data: { forecast: 'x' } }), true);
    const got = readLastGood('nws-points', URL_A);
    assert.deepEqual(got?.data, { forecast: 'x' });
    assert.equal(got?.asOf, '2026-10-04T22:00:00Z');
    assert.ok(!Number.isNaN(Date.parse(got?.savedAt ?? '')));
    assert.ok([...mem.map.keys()].some((k) => k.startsWith('cthd:v1:lg:nws-points:')));
  });

  test('keys are per source and per URL', () => {
    writeLastGood('nws-points', URL_A, { asOf: '2026-10-04T22:00:00Z', data: 1 });
    assert.equal(readLastGood('nws-points', `${URL_A}x`), null);
    assert.equal(readLastGood('nws-forecast', URL_A), null);
  });

  test('an entry over 200 KB is refused', () => {
    const big = 'x'.repeat(MAX_ENTRY_BYTES);
    assert.equal(writeLastGood('nws-points', URL_A, { asOf: '2026-10-04T22:00:00Z', data: big }), false);
    assert.equal(readLastGood('nws-points', URL_A), null);
  });

  test('total size is held to 2 MB by evicting the least recently used', () => {
    const chunk = 'y'.repeat(150 * 1024);
    const t = Date.now();
    const realNow = Date.now;
    let i = 0;
    Date.now = () => t + (i += 1);
    try {
      for (let n = 0; n < 12; n += 1) writeLastGood('nws-points', `u${n}`, { asOf: '2026-10-04T22:00:00Z', data: chunk });
      // Touch u0 so it is recently used, then add three more; u1 (the oldest untouched) must go first.
      assert.ok(readLastGood('nws-points', 'u0'));
      for (let n = 12; n < 15; n += 1) writeLastGood('nws-points', `u${n}`, { asOf: '2026-10-04T22:00:00Z', data: chunk });
    } finally {
      Date.now = realNow;
    }
    const total = [...mem.map].filter(([k]) => k.startsWith('cthd:v1:lg:')).reduce((n, [, v]) => n + v.length, 0);
    assert.ok(total <= MAX_TOTAL_BYTES, `total ${total}`);
    assert.ok(readLastGood('nws-points', 'u0'), 'recently read entry survives');
    assert.ok(readLastGood('nws-points', 'u14'), 'newest entry survives');
    assert.equal(readLastGood('nws-points', 'u1'), null, 'least recently used entry is evicted');
  });

  test('a full device evicts to make room, then writes', () => {
    mem.quota = 400_000;
    const chunk = 'z'.repeat(150_000);
    for (let n = 0; n < 4; n += 1) writeLastGood('nws-points', `q${n}`, { asOf: '2026-10-04T22:00:00Z', data: chunk });
    assert.ok(readLastGood('nws-points', 'q3'), 'the newest write succeeded by evicting older entries');
  });

  test('blocked storage: reads null, writes false, evict is silent', () => {
    mem.blocked = true;
    assert.equal(readLastGood('nws-points', URL_A), null);
    assert.equal(writeLastGood('nws-points', URL_A, { asOf: '2026-10-04T22:00:00Z', data: 1 }), false);
    assert.doesNotThrow(() => evictLastGood());
  });

  test('a corrupt entry is dropped and reads null', () => {
    writeLastGood('nws-points', URL_A, { asOf: '2026-10-04T22:00:00Z', data: 1 });
    const key = [...mem.map.keys()].find((k) => k.startsWith('cthd:v1:lg:nws-points:'));
    mem.map.set(/** @type {string} */ (key), '{not json');
    assert.equal(readLastGood('nws-points', URL_A), null);
    assert.equal(mem.map.has(/** @type {string} */ (key)), false);
    mem.map.set(/** @type {string} */ (key), '{"foo":1}');
    assert.equal(readLastGood('nws-points', URL_A), null);
  });
});
