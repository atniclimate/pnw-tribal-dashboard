// @ts-check
/**
 * core/status.js: every deriveStatus row of the blueprint 3.3 table, the two dashboard validation rules,
 * the registry, and stateFromAge. CAST's own cases run in tests/cast/status.test.mjs.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { createStatusRegistry, deriveStatus, stateFromAge, STATUS_STATES, validateSnapshot } from '../../../site/static/js/core/status.js';

const POLICY = { freshForMs: 15 * 60_000, usableForMs: 2 * 3_600_000 };
const NOW = new Date('2026-10-04T23:00:00Z');
const IDS = ['nws-alerts-active'];
const iso = (/** @type {number} */ minutesAgo) => new Date(NOW.getTime() - minutesAgo * 60_000).toISOString();

/** @param {Partial<import('../../../site/static/js/types.js').StatusInputs>} over */
const derive = (over) => deriveStatus({ sourceIds: IDS, policy: POLICY, now: NOW, ...over });

describe('deriveStatus: one test per row of the table', () => {
  test('row 1: snapshot painted, direct top-up pending: state from the snapshot age, with the scheduled-copy detail', () => {
    const s = derive({ snapshot: { asOf: iso(5), asOfBasis: 'issued', carriedForward: false }, direct: 'pending' });
    assert.equal(s.state, 'live');
    assert.equal(s.asOf, iso(5));
    assert.equal(s.asOfBasis, 'issued');
    assert.equal(s.origin, 'snapshot');
    assert.match(s.detail ?? '', /^Scheduled copy from \d{1,2}:\d{2} [AP]M [A-Z]{2,4}; checking for updates$/);
  });

  test('row 1: an older snapshot is stale, then degraded, by the usable window', () => {
    assert.equal(derive({ snapshot: { asOf: iso(60), asOfBasis: 'issued', carriedForward: false }, direct: 'pending' }).state, 'stale');
    assert.equal(derive({ snapshot: { asOf: iso(300), asOfBasis: 'issued', carriedForward: false }, direct: 'pending' }).state, 'degraded');
  });

  test('row 1: with no direct fetch configured the copy is labeled without claiming a check', () => {
    const s = derive({ snapshot: { asOf: iso(5), asOfBasis: 'issued', carriedForward: false }, direct: null });
    assert.match(s.detail ?? '', /^Scheduled copy from /);
    assert.doesNotMatch(s.detail ?? '', /checking/);
  });

  test('row 1: a carried-forward snapshot says so', () => {
    const s = derive({ snapshot: { asOf: iso(5), asOfBasis: 'issued', carriedForward: true } });
    assert.match(s.detail ?? '', /earlier copy/);
  });

  test('row 2: direct complete within freshForMs is live with the upstream time and no detail', () => {
    const s = derive({ direct: { ok: true, asOf: iso(3), asOfBasis: 'issued', completeness: 'complete' } });
    assert.equal(s.state, 'live');
    assert.equal(s.asOf, iso(3));
    assert.equal(s.origin, 'direct');
    assert.equal(s.detail, undefined);
    assert.equal(s.completeness, 'complete');
  });

  test('row 3: direct complete, upstream older than freshForMs: stale, with the upstream-has-not-updated detail', () => {
    const s = derive({ direct: { ok: true, asOf: iso(40), asOfBasis: 'observed', completeness: 'complete' } });
    assert.equal(s.state, 'stale');
    assert.equal(s.asOf, iso(40));
    assert.match(s.detail ?? '', /^Upstream has not updated since \d{1,2}:\d{2} [AP]M [A-Z]{2,4}$/);
  });

  test('row 3: older than usableForMs is degraded', () => {
    const s = derive({ direct: { ok: true, asOf: iso(200), asOfBasis: 'observed', completeness: 'complete' } });
    assert.equal(s.state, 'degraded');
    assert.match(s.detail ?? '', /Upstream has not updated since/);
  });

  test('row 4: partial data is degraded with the caller detail and partial completeness', () => {
    const s = derive({ direct: { ok: true, asOf: iso(1), asOfBasis: 'issued', completeness: 'partial', detail: 'Partial: 480 of 535 alerts loaded' } });
    assert.equal(s.state, 'degraded');
    assert.equal(s.completeness, 'partial');
    assert.equal(s.detail, 'Partial: 480 of 535 alerts loaded');
    assert.equal(s.asOf, iso(1));
  });

  test('row 4: partial without a caller detail still says so', () => {
    const s = derive({ direct: { ok: true, asOf: iso(1), asOfBasis: 'issued', completeness: 'partial' } });
    assert.match(s.detail ?? '', /^Partial/);
  });

  test('row 5: direct failed, snapshot available: state from the snapshot age, with the failure in the detail', () => {
    const s = derive({
      snapshot: { asOf: iso(10), asOfBasis: 'issued', carriedForward: false },
      direct: { ok: false, error: { kind: 'timeout', message: 'timed out after 12 s' } },
    });
    assert.equal(s.state, 'live');
    assert.equal(s.origin, 'snapshot');
    assert.equal(s.detail, 'Direct request failed (timed out after 12 s); showing the scheduled copy');
  });

  test('row 5: an old snapshot after a failed direct request is stale or degraded, never live', () => {
    const s = derive({ snapshot: { asOf: iso(90), asOfBasis: 'issued', carriedForward: false }, direct: { ok: false, error: { kind: 'network', message: 'network request failed' } } });
    assert.equal(s.state, 'stale');
  });

  test('row 6: device last-good after a failed direct request is cached with the original data time', () => {
    const s = derive({
      direct: { ok: false, error: { kind: 'offline', message: 'This device is offline' } },
      device: { asOf: iso(600), asOfBasis: 'valid' },
    });
    assert.equal(s.state, 'cached');
    assert.equal(s.asOf, iso(600));
    assert.equal(s.asOfBasis, 'valid');
    assert.equal(s.origin, 'device');
    assert.equal(s.detail, 'Saved on this device');
  });

  test('row 6: device copy with no direct fetch at all is also cached', () => {
    const s = derive({ device: { asOf: iso(30), asOfBasis: 'valid' } });
    assert.equal(s.state, 'cached');
  });

  test('row 7: nothing available is unavailable with no asOf and the reason as detail', () => {
    const s = derive({ direct: { ok: false, error: { kind: 'http', status: 500, message: 'HTTP 500' } }, unavailableReason: 'The National Weather Service could not be reached.' });
    assert.equal(s.state, 'unavailable');
    assert.equal(s.asOf, null);
    assert.equal(s.asOfBasis, null);
    assert.equal(s.detail, 'The National Weather Service could not be reached.');
  });

  test('row 7: unavailable has a default reason', () => {
    assert.match(derive({}).detail ?? '', /No data/);
  });

  test('a snapshot that has no asOf (rejected) does not count as available', () => {
    const s = derive({ snapshot: { asOf: null, asOfBasis: null, carriedForward: false }, direct: 'pending' });
    assert.equal(s.state, 'unavailable');
  });

  test('direct success without a source time is stamped retrieved at now', () => {
    const s = derive({ direct: { ok: true, asOf: null, asOfBasis: null, completeness: 'complete' } });
    assert.equal(s.state, 'live');
    assert.equal(s.asOfBasis, 'retrieved');
    assert.equal(s.asOf, NOW.toISOString());
  });

  test('a direct success carries its own detail when given', () => {
    const s = derive({ direct: { ok: true, asOf: iso(1), asOfBasis: 'issued', completeness: 'complete', detail: 'Two sources reporting' } });
    assert.equal(s.detail, 'Two sources reporting');
  });

  test('every derived snapshot validates and carries sourceIds and checkedAt', () => {
    const cases = [
      derive({ snapshot: { asOf: iso(5), asOfBasis: 'issued', carriedForward: false }, direct: 'pending' }),
      derive({ direct: { ok: true, asOf: iso(40), asOfBasis: 'observed', completeness: 'complete' } }),
      derive({ device: { asOf: iso(30), asOfBasis: 'valid' } }),
      derive({}),
    ];
    for (const s of cases) {
      assert.deepEqual(validateSnapshot(s), []);
      assert.deepEqual(s.sourceIds, IDS);
      assert.equal(s.checkedAt, NOW.toISOString());
    }
  });

  test('empty sourceIds is a programming error', () => {
    assert.throws(() => deriveStatus({ sourceIds: [], policy: POLICY, now: NOW }), /sourceIds/);
  });

  test('the returned sourceIds are a copy', () => {
    const ids = ['a'];
    const s = deriveStatus({ sourceIds: ids, policy: POLICY, now: NOW });
    ids.push('b');
    assert.deepEqual(s.sourceIds, ['a']);
  });
});

describe('validateSnapshot dashboard rules', () => {
  const ok = { state: 'live', asOf: '2026-10-04T22:00:00Z', asOfBasis: 'issued', sourceIds: ['x'], origin: 'direct', completeness: 'complete', checkedAt: '2026-10-04T22:01:00Z' };

  test('a complete snapshot is valid', () => {
    assert.deepEqual(validateSnapshot(/** @type {any} */ (ok)), []);
  });

  test('added rule 1: sourceIds must be non-empty', () => {
    assert.match(validateSnapshot(/** @type {any} */ ({ ...ok, sourceIds: [] })).join(';'), /sourceIds/);
    assert.match(validateSnapshot(/** @type {any} */ ({ ...ok, sourceIds: undefined })).join(';'), /sourceIds/);
  });

  test('added rule 2: asOfBasis is required whenever asOf is set', () => {
    assert.match(validateSnapshot(/** @type {any} */ ({ ...ok, asOfBasis: null })).join(';'), /asOfBasis/);
    assert.match(validateSnapshot(/** @type {any} */ ({ ...ok, asOfBasis: 'whenever' })).join(';'), /asOfBasis/);
  });

  test('an unavailable snapshot needs no asOf or basis, only sourceIds', () => {
    assert.deepEqual(validateSnapshot(/** @type {any} */ ({ ...ok, state: 'unavailable', asOf: null, asOfBasis: null })), []);
  });

  test('CAST rules still apply', () => {
    assert.match(validateSnapshot(/** @type {any} */ ({ ...ok, state: 'sideways' })).join(';'), /unknown state/);
    assert.match(validateSnapshot(/** @type {any} */ ({ ...ok, asOf: null })).join(';'), /requires an "asOf"/);
    assert.match(validateSnapshot(/** @type {any} */ ({ ...ok, asOf: 'yesterday-ish' })).join(';'), /ISO 8601/);
  });
});

describe('createStatusRegistry', () => {
  const live = /** @type {any} */ ({ state: 'live', asOf: '2026-10-04T22:00:00Z', asOfBasis: 'issued', sourceIds: ['x'], origin: 'direct', completeness: 'complete', checkedAt: '2026-10-04T22:01:00Z' });

  test('register defaults to an honest unavailable, "not yet loaded"', () => {
    const r = createStatusRegistry();
    r.register('panel');
    assert.equal(r.get('panel').state, 'unavailable');
    assert.equal(r.get('panel').asOf, null);
    assert.equal(r.get('panel').detail, 'not yet loaded');
    assert.deepEqual(r.ids(), ['panel']);
    assert.equal(r.has('panel'), true);
    assert.equal(r.has('ghost'), false);
  });

  test('duplicate registration, unknown report, and unknown get all throw', () => {
    const r = createStatusRegistry();
    r.register('panel');
    assert.throws(() => r.register('panel'), /already registered/);
    assert.throws(() => r.report('ghost', live), /not registered/);
    assert.throws(() => r.get('ghost'), /not registered/);
  });

  test('report rejects dishonest snapshots and accepts honest ones; subscribers hear every change', () => {
    const r = createStatusRegistry();
    r.register('panel');
    /** @type {string[]} */
    const seen = [];
    const off = r.subscribe((id, s) => seen.push(`${id}:${s.state}`));
    assert.throws(() => r.report('panel', { ...live, asOf: null }), /asOf/);
    assert.throws(() => r.report('panel', { ...live, sourceIds: [] }), /sourceIds/);
    r.report('panel', live);
    off();
    r.report('panel', { ...live, state: 'stale' });
    assert.deepEqual(seen, ['panel:live']);
  });

  test('an initial snapshot may be supplied', () => {
    const r = createStatusRegistry();
    r.register('panel', live);
    assert.equal(r.get('panel').state, 'live');
  });
});

describe('stateFromAge and STATUS_STATES', () => {
  test('the five states in CAST order', () => {
    assert.deepEqual([...STATUS_STATES], ['live', 'cached', 'stale', 'degraded', 'unavailable']);
  });

  test('edges are inclusive and bad input throws', () => {
    assert.equal(stateFromAge(iso(15), NOW, POLICY), 'live');
    assert.equal(stateFromAge(iso(15.01), NOW, POLICY), 'stale');
    assert.equal(stateFromAge(iso(120), NOW, POLICY), 'stale');
    assert.equal(stateFromAge(iso(120.01), NOW, POLICY), 'degraded');
    assert.throws(() => stateFromAge('nope', NOW, POLICY), /ISO 8601/);
    assert.throws(() => stateFromAge(iso(1), NOW, { freshForMs: 10, usableForMs: 5 }), /freshness policy/);
  });

  test('data stamped in the future counts as live', () => {
    assert.equal(stateFromAge(iso(-5), NOW, POLICY), 'live');
  });
});
