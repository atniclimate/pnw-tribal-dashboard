// @ts-check
/** core/poller.js: visibility-aware polling, doubling backoff to ten minutes, online resume, no overlap. */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, mock, test } from 'node:test';
import { createPoller, MAX_BACKOFF_MS } from '../../../site/static/js/core/poller.js';
import { FakeEvent, installFakeDom } from './helpers/fake-dom.mjs';

/** @type {ReturnType<typeof installFakeDom>} */
let dom;
/** @type {Map<string, Set<() => void>>} */
let winListeners;
const realAdd = globalThis.addEventListener;
const realRemove = globalThis.removeEventListener;

beforeEach(() => {
  dom = installFakeDom();
  winListeners = new Map();
  globalThis.addEventListener = /** @type {any} */ ((/** @type {string} */ t, /** @type {() => void} */ f) => {
    if (!winListeners.has(t)) winListeners.set(t, new Set());
    winListeners.get(t)?.add(f);
  });
  globalThis.removeEventListener = /** @type {any} */ ((/** @type {string} */ t, /** @type {() => void} */ f) => { winListeners.get(t)?.delete(f); });
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
});

afterEach(() => {
  mock.timers.reset();
  dom.restore();
  globalThis.addEventListener = realAdd;
  globalThis.removeEventListener = realRemove;
});

/** Let promise continuations run between timer ticks. */
const flush = async () => { for (let i = 0; i < 10; i += 1) await Promise.resolve(); };

/** @param {number} ms */
async function advance(ms) {
  mock.timers.tick(ms);
  await flush();
}

const hide = (/** @type {boolean} */ h) => {
  dom.document.hidden = h;
  dom.document.dispatchEvent(Object.assign(new FakeEvent('visibilitychange'), { target: dom.document }));
};

describe('createPoller', () => {
  test('runs on the interval after start, not immediately', async () => {
    let runs = 0;
    const p = createPoller({ statusId: 's', visibleMs: 90_000, minMs: 30_000, jitter: 0, run: async () => { runs += 1; return true; } });
    p.start();
    await advance(89_999);
    assert.equal(runs, 0);
    await advance(1);
    assert.equal(runs, 1);
    await advance(90_000);
    assert.equal(runs, 2);
    p.stop();
    await advance(500_000);
    assert.equal(runs, 2, 'stop halts polling');
  });

  test('jitter spreads the interval by at most ten percent', async () => {
    let runs = 0;
    const p = createPoller({ statusId: 's', visibleMs: 100_000, minMs: 1000, jitter: 0.1, run: async () => { runs += 1; return true; } });
    p.start();
    await advance(89_999);
    assert.equal(runs, 0, 'never earlier than 90 percent');
    await advance(20_002);
    assert.equal(runs, 1, 'always by 110 percent');
    p.stop();
  });

  test('doubles the interval after each failure up to ten minutes and resets on success', async () => {
    let ok = false;
    const p = createPoller({ statusId: 's', visibleMs: 90_000, minMs: 30_000, jitter: 0, run: async () => ok });
    assert.equal(p.intervalMs, 90_000);
    p.start();
    await advance(90_000);
    assert.equal(p.intervalMs, 180_000);
    await advance(180_000);
    assert.equal(p.intervalMs, 360_000);
    await advance(360_000);
    assert.equal(p.intervalMs, MAX_BACKOFF_MS);
    await advance(MAX_BACKOFF_MS);
    assert.equal(p.intervalMs, MAX_BACKOFF_MS, 'capped at ten minutes');
    ok = true;
    await advance(MAX_BACKOFF_MS);
    assert.equal(p.intervalMs, 90_000, 'success resets');
    p.stop();
  });

  test('a throwing run counts as a failure and never escapes', async () => {
    const p = createPoller({ statusId: 's', visibleMs: 60_000, minMs: 30_000, jitter: 0, run: async () => { throw new Error('boom'); } });
    p.start();
    await advance(60_000);
    assert.equal(p.intervalMs, 120_000);
    p.stop();
  });

  test('the interval never drops below minMs', () => {
    const p = createPoller({ statusId: 's', visibleMs: 5000, minMs: 30_000, run: async () => true });
    assert.equal(p.intervalMs, 30_000);
  });

  test('pauses while hidden and refreshes immediately on return when the data is older than the interval', async () => {
    let runs = 0;
    const p = createPoller({ statusId: 's', visibleMs: 60_000, minMs: 30_000, jitter: 0, run: async () => { runs += 1; return true; } });
    p.start();
    await advance(10_000);
    hide(true);
    await advance(600_000);
    assert.equal(runs, 0, 'no polling while hidden');
    hide(false);
    await flush();
    assert.equal(runs, 1, 'immediate refresh on return');
    p.stop();
  });

  test('returning early reschedules for the remainder rather than refreshing', async () => {
    let runs = 0;
    const p = createPoller({ statusId: 's', visibleMs: 60_000, minMs: 30_000, jitter: 0, run: async () => { runs += 1; return true; } });
    p.start();
    await advance(20_000);
    hide(true);
    hide(false);
    await flush();
    assert.equal(runs, 0);
    await advance(39_999);
    assert.equal(runs, 0);
    await advance(1);
    assert.equal(runs, 1);
    p.stop();
  });

  test('the online event resets the backoff and runs now', async () => {
    let runs = 0;
    const p = createPoller({ statusId: 's', visibleMs: 60_000, minMs: 30_000, jitter: 0, run: async () => { runs += 1; return false; } });
    p.start();
    await advance(60_000);
    assert.equal(p.intervalMs, 120_000);
    for (const f of winListeners.get('online') ?? []) f();
    await flush();
    assert.equal(runs, 2);
    p.stop();
    assert.equal(winListeners.get('online')?.size, 0, 'stop removes the listener');
    assert.equal(dom.document.listeners.get('visibilitychange')?.size ?? 0, 0);
  });

  test('runNow does not overlap an in-flight run', async () => {
    let runs = 0;
    /** @type {() => void} */
    let release = () => {};
    const p = createPoller({ statusId: 's', visibleMs: 60_000, minMs: 30_000, run: () => new Promise((r) => { runs += 1; release = () => r(true); }) });
    const a = p.runNow();
    const b = p.runNow();
    assert.equal(runs, 1);
    release();
    await Promise.all([a, b]);
    assert.equal(runs, 1);
  });

  test('stop aborts the signal handed to run', async () => {
    /** @type {AbortSignal | null} */
    let seen = null;
    const p = createPoller({ statusId: 's', visibleMs: 60_000, minMs: 30_000, run: (signal) => new Promise(() => { seen = signal; }) });
    void p.runNow();
    p.stop();
    assert.equal(/** @type {AbortSignal | null} */ (seen)?.aborted, true);
  });

  test('start twice is harmless and does not double the schedule', async () => {
    let runs = 0;
    const p = createPoller({ statusId: 's', visibleMs: 60_000, minMs: 30_000, jitter: 0, run: async () => { runs += 1; return true; } });
    p.start();
    p.start();
    await advance(60_000);
    assert.equal(runs, 1);
    p.stop();
  });
});
