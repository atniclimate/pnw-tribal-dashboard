// @ts-check
/** core/priority.js: the limiter serves priority 0 before 3 under contention, caps concurrency, honors abort. */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { createLimiter, sharedLimiter } from '../../../site/static/js/core/priority.js';

const tick = () => new Promise((r) => setTimeout(r, 0));

/** A task that runs until released. */
function gate() {
  /** @type {() => void} */
  let release = () => {};
  const done = new Promise((r) => { release = () => r(undefined); });
  return { release, task: () => done };
}

describe('createLimiter', () => {
  test('never runs more than maxConcurrent tasks', async () => {
    const lim = createLimiter({ maxConcurrent: 2 });
    let running = 0;
    let peak = 0;
    const gates = Array.from({ length: 6 }, gate);
    const ps = gates.map((g) => lim.run(1, async () => { running += 1; peak = Math.max(peak, running); await g.task(); running -= 1; }));
    await tick();
    assert.equal(running, 2);
    assert.equal(lim.pending(), 4);
    for (const g of gates) { g.release(); await tick(); }
    await Promise.all(ps);
    assert.equal(peak, 2);
    assert.equal(lim.pending(), 0);
  });

  test('serves priority 0 before 3 under contention', async () => {
    const lim = createLimiter({ maxConcurrent: 1 });
    const blocker = gate();
    /** @type {string[]} */
    const order = [];
    const first = lim.run(3, blocker.task);
    const queued = [
      lim.run(3, async () => { order.push('media-1'); }),
      lim.run(2, async () => { order.push('hydrology'); }),
      lim.run(3, async () => { order.push('media-2'); }),
      lim.run(0, async () => { order.push('alerts'); }),
      lim.run(1, async () => { order.push('forecast'); }),
    ];
    await tick();
    blocker.release();
    await Promise.all([first, ...queued]);
    assert.deepEqual(order, ['alerts', 'forecast', 'hydrology', 'media-1', 'media-2']);
  });

  test('equal priorities run in arrival order', async () => {
    const lim = createLimiter({ maxConcurrent: 1 });
    const blocker = gate();
    /** @type {number[]} */
    const order = [];
    const ps = [lim.run(2, blocker.task)];
    for (let i = 0; i < 5; i += 1) ps.push(lim.run(2, async () => { order.push(i); }));
    blocker.release();
    await Promise.all(ps);
    assert.deepEqual(order, [0, 1, 2, 3, 4]);
  });

  test('resolves with the task value and rejects with the task error, freeing the slot either way', async () => {
    const lim = createLimiter({ maxConcurrent: 1 });
    assert.equal(await lim.run(1, async () => 42), 42);
    await assert.rejects(lim.run(1, async () => { throw new Error('boom'); }), /boom/);
    assert.equal(await lim.run(1, async () => 'after'), 'after');
  });

  test('a task that is aborted while queued never starts', async () => {
    const lim = createLimiter({ maxConcurrent: 1 });
    const blocker = gate();
    const first = lim.run(1, blocker.task);
    const ctl = new AbortController();
    let started = false;
    const queued = lim.run(1, async () => { started = true; }, ctl.signal);
    ctl.abort();
    await assert.rejects(queued, (e) => e instanceof Error && e.name === 'AbortError');
    assert.equal(lim.pending(), 0);
    blocker.release();
    await first;
    assert.equal(started, false);
  });

  test('an already aborted signal rejects immediately', async () => {
    const lim = createLimiter({ maxConcurrent: 1 });
    const ctl = new AbortController();
    ctl.abort();
    await assert.rejects(lim.run(0, async () => 1, ctl.signal), /abort/i);
  });

  test('maxConcurrent below one is treated as one', async () => {
    const lim = createLimiter({ maxConcurrent: 0 });
    assert.equal(await lim.run(0, async () => 'ok'), 'ok');
  });
});

describe('sharedLimiter', () => {
  test('is a singleton limited to the configured four', async () => {
    assert.equal(sharedLimiter(), sharedLimiter());
    const lim = sharedLimiter();
    const gates = Array.from({ length: 5 }, gate);
    let running = 0;
    const ps = gates.map((g) => lim.run(1, async () => { running += 1; await g.task(); }));
    await tick();
    assert.equal(running, 4);
    for (const g of gates) { g.release(); await tick(); }
    await Promise.all(ps);
  });
});
