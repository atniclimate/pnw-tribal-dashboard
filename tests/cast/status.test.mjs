// @ts-check
/**
 * CAST parity (blueprint 10.1): site/static/js/core/status.js reproduces @ewm/core-status on CAST's own
 * cases (tests/fixtures/cast/core-status/src/index.test.ts, ported case for case from vitest to node:test).
 * The dashboard snapshot has three more fields, so a helper completes each CAST snapshot with them; the two
 * added rules (sourceIds non-empty, asOfBasis whenever asOf) are then shown to be the only differences.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, test } from 'node:test';
import { createStatusRegistry, stateFromAge, STATUS_STATES, validateSnapshot } from '../../site/static/js/core/status.js';

/**
 * CAST snapshot to dashboard snapshot: the same state, asOf, and detail, plus the dashboard fields.
 * @param {{ state: string, asOf: string | null, detail?: string }} cast
 * @returns {any}
 */
const dash = (cast) => ({
  ...cast, asOfBasis: cast.asOf === null ? null : 'issued', sourceIds: ['hydro-demo'], origin: 'direct', completeness: 'complete', checkedAt: '2026-07-14T12:00:01Z',
});

const LIVE_NOW = dash({ state: 'live', asOf: '2026-07-14T12:00:00Z' });

test('the CAST test file is present and unchanged in shape (guards against a silent fixture refresh)', async () => {
  const src = await readFile(new URL('../fixtures/cast/core-status/src/index.test.ts', import.meta.url), 'utf8');
  for (const name of ['registers with an honest default', 'rejects duplicate registration', 'enforces the honesty rule', 'treats the window edges as inclusive']) {
    assert.ok(src.includes(name), `CAST case "${name}" no longer exists upstream; re-port this file`);
  }
});

describe('createStatusRegistry (CAST cases)', () => {
  test('registers with an honest default (unavailable, no asOf)', () => {
    const registry = createStatusRegistry();
    registry.register('hydro.demo');
    const s = registry.get('hydro.demo');
    assert.equal(s.state, 'unavailable');
    assert.equal(s.asOf, null);
    assert.equal(s.detail, 'not yet loaded');
  });

  test('rejects duplicate registration: a status id has one owner', () => {
    const registry = createStatusRegistry();
    registry.register('hydro.demo');
    assert.throws(() => registry.register('hydro.demo'), /already registered/);
  });

  test('rejects reports to unregistered ids', () => {
    const registry = createStatusRegistry();
    assert.throws(() => registry.report('ghost', LIVE_NOW), /not registered/);
  });

  test('updates and notifies subscribers on report', () => {
    const registry = createStatusRegistry();
    registry.register('hydro.demo');
    /** @type {Array<{ id: string, state: string }>} */
    const seen = [];
    registry.subscribe((id, snapshot) => seen.push({ id, state: snapshot.state }));
    registry.report('hydro.demo', LIVE_NOW);
    assert.deepEqual(registry.get('hydro.demo'), LIVE_NOW);
    assert.deepEqual(seen, [{ id: 'hydro.demo', state: 'live' }]);
  });

  test('stops notifying after unsubscribe', () => {
    const registry = createStatusRegistry();
    registry.register('hydro.demo');
    let calls = 0;
    const unsubscribe = registry.subscribe(() => { calls += 1; });
    registry.report('hydro.demo', LIVE_NOW);
    unsubscribe();
    registry.report('hydro.demo', { ...LIVE_NOW, state: 'stale' });
    assert.equal(calls, 1);
  });

  test('enforces the honesty rule: data-bearing states require asOf', () => {
    const registry = createStatusRegistry();
    registry.register('hydro.demo');
    for (const state of ['live', 'cached', 'stale', 'degraded']) {
      assert.throws(() => registry.report('hydro.demo', dash({ state, asOf: null })), /asOf/);
    }
    // unavailable legitimately has nothing to date
    assert.doesNotThrow(() => registry.report('hydro.demo', dash({ state: 'unavailable', asOf: null })));
  });

  test('rejects unparseable asOf timestamps', () => {
    const registry = createStatusRegistry();
    registry.register('hydro.demo');
    assert.throws(() => registry.report('hydro.demo', dash({ state: 'live', asOf: 'yesterday-ish' })), /ISO 8601/);
  });
});

describe('validateSnapshot (CAST cases)', () => {
  test('returns no problems for a valid snapshot', () => {
    assert.deepEqual(validateSnapshot(LIVE_NOW), []);
  });

  test('collects multiple problems', () => {
    const problems = validateSnapshot(dash({ state: 'sideways', asOf: 'not-a-date' }));
    assert.equal(problems.length, 2);
  });

  test('STATUS_STATES matches CAST', () => {
    assert.deepEqual([...STATUS_STATES], ['live', 'cached', 'stale', 'degraded', 'unavailable']);
  });
});

describe('the two added rules are the only difference', () => {
  test('a bare CAST snapshot (no sourceIds, no asOfBasis) fails exactly the two added rules', () => {
    const problems = validateSnapshot(/** @type {any} */ ({ state: 'live', asOf: '2026-07-14T12:00:00Z' }));
    assert.equal(problems.length, 2);
    assert.ok(problems.some((p) => p.includes('sourceIds')));
    assert.ok(problems.some((p) => p.includes('asOfBasis')));
  });

  test('a bare CAST unavailable snapshot fails only the sourceIds rule', () => {
    const problems = validateSnapshot(/** @type {any} */ ({ state: 'unavailable', asOf: null }));
    assert.equal(problems.length, 1);
    assert.ok(problems[0]?.includes('sourceIds'));
  });
});

describe('stateFromAge (CAST cases)', () => {
  const now = new Date('2026-07-14T12:00:00Z');
  const policy = { freshForMs: 60 * 60 * 1000, usableForMs: 6 * 60 * 60 * 1000 };

  test('labels fresh data live', () => assert.equal(stateFromAge('2026-07-14T11:30:00Z', now, policy), 'live'));
  test('labels data past the fresh window stale', () => assert.equal(stateFromAge('2026-07-14T09:00:00Z', now, policy), 'stale'));
  test('labels data past the usable window degraded', () => assert.equal(stateFromAge('2026-07-13T12:00:00Z', now, policy), 'degraded'));

  test('treats the window edges as inclusive', () => {
    assert.equal(stateFromAge('2026-07-14T11:00:00Z', now, policy), 'live');
    assert.equal(stateFromAge('2026-07-14T06:00:00Z', now, policy), 'stale');
  });

  test('rejects bad timestamps and inverted policies', () => {
    assert.throws(() => stateFromAge('nope', now, policy), /ISO 8601/);
    assert.throws(() => stateFromAge('2026-07-14T11:00:00Z', now, { freshForMs: 10, usableForMs: 5 }), /freshness policy/);
  });
});
