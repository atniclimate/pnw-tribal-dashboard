import { describe, expect, it } from 'vitest';
import {
  createStatusRegistry,
  stateFromAge,
  validateSnapshot,
  type StatusSnapshot,
} from './index.js';

const LIVE_NOW: StatusSnapshot = { state: 'live', asOf: '2026-07-14T12:00:00Z' };

describe('createStatusRegistry', () => {
  it('registers with an honest default (unavailable, no asOf)', () => {
    const registry = createStatusRegistry();
    registry.register('hydro.demo');
    expect(registry.get('hydro.demo')).toEqual({
      state: 'unavailable',
      asOf: null,
      detail: 'not yet loaded',
    });
  });

  it('rejects duplicate registration — a status id has one owner', () => {
    const registry = createStatusRegistry();
    registry.register('hydro.demo');
    expect(() => registry.register('hydro.demo')).toThrow(/already registered/);
  });

  it('rejects reports to unregistered ids', () => {
    const registry = createStatusRegistry();
    expect(() => registry.report('ghost', LIVE_NOW)).toThrow(/not registered/);
  });

  it('updates and notifies subscribers on report', () => {
    const registry = createStatusRegistry();
    registry.register('hydro.demo');
    const seen: Array<{ id: string; state: string }> = [];
    registry.subscribe((id, snapshot) => seen.push({ id, state: snapshot.state }));
    registry.report('hydro.demo', LIVE_NOW);
    expect(registry.get('hydro.demo')).toEqual(LIVE_NOW);
    expect(seen).toEqual([{ id: 'hydro.demo', state: 'live' }]);
  });

  it('stops notifying after unsubscribe', () => {
    const registry = createStatusRegistry();
    registry.register('hydro.demo');
    let calls = 0;
    const unsubscribe = registry.subscribe(() => {
      calls += 1;
    });
    registry.report('hydro.demo', LIVE_NOW);
    unsubscribe();
    registry.report('hydro.demo', { state: 'stale', asOf: LIVE_NOW.asOf });
    expect(calls).toBe(1);
  });

  it('enforces the honesty rule: data-bearing states require asOf', () => {
    const registry = createStatusRegistry();
    registry.register('hydro.demo');
    for (const state of ['live', 'cached', 'stale', 'degraded'] as const) {
      expect(() => registry.report('hydro.demo', { state, asOf: null })).toThrow(/asOf/);
    }
    // unavailable legitimately has nothing to date
    expect(() => registry.report('hydro.demo', { state: 'unavailable', asOf: null })).not.toThrow();
  });

  it('rejects unparseable asOf timestamps', () => {
    const registry = createStatusRegistry();
    registry.register('hydro.demo');
    expect(() => registry.report('hydro.demo', { state: 'live', asOf: 'yesterday-ish' })).toThrow(
      /ISO 8601/,
    );
  });
});

describe('validateSnapshot', () => {
  it('returns no problems for a valid snapshot', () => {
    expect(validateSnapshot(LIVE_NOW)).toEqual([]);
  });

  it('collects multiple problems', () => {
    const problems = validateSnapshot({
      state: 'sideways' as never,
      asOf: 'not-a-date',
    });
    expect(problems).toHaveLength(2);
  });
});

describe('stateFromAge', () => {
  const now = new Date('2026-07-14T12:00:00Z');
  const policy = { freshForMs: 60 * 60 * 1000, usableForMs: 6 * 60 * 60 * 1000 };

  it('labels fresh data live', () => {
    expect(stateFromAge('2026-07-14T11:30:00Z', now, policy)).toBe('live');
  });

  it('labels data past the fresh window stale', () => {
    expect(stateFromAge('2026-07-14T09:00:00Z', now, policy)).toBe('stale');
  });

  it('labels data past the usable window degraded', () => {
    expect(stateFromAge('2026-07-13T12:00:00Z', now, policy)).toBe('degraded');
  });

  it('treats the window edges as inclusive', () => {
    expect(stateFromAge('2026-07-14T11:00:00Z', now, policy)).toBe('live');
    expect(stateFromAge('2026-07-14T06:00:00Z', now, policy)).toBe('stale');
  });

  it('rejects bad timestamps and inverted policies', () => {
    expect(() => stateFromAge('nope', now, policy)).toThrow(/ISO 8601/);
    expect(() =>
      stateFromAge('2026-07-14T11:00:00Z', now, { freshForMs: 10, usableForMs: 5 }),
    ).toThrow(/freshness policy/);
  });
});
