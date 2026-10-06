// @ts-check
/**
 * Early snapshot hand-off: the Dashboard starts alerts.json and tsunami.json before the alert modules load and
 * passes those requests to its first loadAllAlerts call only. The first call consumes them, later calls fetch
 * for themselves, and an aborted scope discards them. Status and parsing stay inside loadAllAlerts, so the
 * result is identical to a call that fetched for itself.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { loadAllAlerts, LIVE_FILES } from '../../../site/static/js/alerts/service.js';
import { normalizeNwsCollection } from '../../../site/static/js/alerts/nws.js';
import { toIndexEntry } from '../../../site/static/js/alerts/model.js';
import { footprintIndex } from '../../../site/static/js/alerts/footprint.js';
import { prepareAlerts } from '../../../site/static/js/alerts/relevance.js';
import { deriveStatus } from '../../../site/static/js/core/status.js';
import { ROOT, ctxOf, fixture, testFootprintUgc } from './helpers.mjs';

const fpIdx = footprintIndex(testFootprintUgc(), [-180, -90, 180, 90]);
const footprintCap = fixture('nws-alerts-active', 'footprint-active.json');
const NOW = new Date('2026-10-05T06:30:00Z');

function snapshotEnvelope() {
  const alerts = prepareAlerts(normalizeNwsCollection(footprintCap.body, ctxOf(footprintCap.meta)).alerts, { now: NOW, footprint: fpIdx }).alerts;
  const asOf = '2026-10-05T06:23:38+00:00';
  return {
    schema: 'cthd.live.alerts/1', id: 'alerts', sourceIds: ['nws-alerts-active', 'eccc-geomet-weather-alerts'],
    generatedAt: asOf, observedAt: asOf, asOf, asOfBasis: 'issued', completeness: 'complete', carriedForward: false, failure: null,
    perSource: { 'nws-alerts-active': { ok: true, count: alerts.length, asOf }, 'eccc-geomet-weather-alerts': { ok: true, count: 0, asOf } },
    diagnostics: {}, items: alerts.map(toIndexEntry),
  };
}

/** @param {any} data @returns {import('../../../site/static/js/types.js').NetResult} */
const ok = (data) => ({ ok: true, data, status: 200, fetchedAt: '2026-10-05T06:29:50Z', lastModified: null, sourceId: 'x' });
const tsunami = { schema: 'cthd.live.tsunami/1', id: 'tsunami', sourceIds: ['ntwc-atom'], generatedAt: '2026-10-05T06:23:38+00:00', observedAt: '2026-10-05T06:23:38+00:00', asOf: '2026-10-05T06:23:38+00:00', asOfBasis: 'issued', completeness: 'complete', carriedForward: false, failure: null, items: [] };

/** @param {string[]} log */
function deps(log) {
  return {
    now: () => NOW,
    isEnabled: () => true,
    deriveStatus,
    /** @param {string} p */
    fetchLocal: async (p) => { log.push(`local ${p}`); return ok(p === LIVE_FILES.index ? snapshotEnvelope() : p === LIVE_FILES.tsunami ? tsunami : null); },
    fetchAllPages: async () => { throw new Error('no direct request in this test'); },
  };
}

/** @param {string[]} log @param {Partial<Parameters<typeof loadAllAlerts>[0]>} [extra] */
const run = (log, extra = {}) => loadAllAlerts({ scope: { kind: 'footprint' }, registry: { index: null }, page: 'dashboard', direct: false, deps: /** @type {any} */ (deps(log)), ...extra });
/** @param {string[]} log */
const early = (log) => ({
  index: Promise.resolve(ok(snapshotEnvelope())).then((r) => { log.push('early index'); return r; }),
  tsunami: Promise.resolve(ok(tsunami)).then((r) => { log.push('early tsunami'); return r; }),
});

test('the first load consumes the early requests and makes no snapshot request of its own', async () => {
  const log = /** @type {string[]} */ ([]);
  const first = await run(log, { prefetch: early(log) });
  assert.deepEqual(log.filter((l) => l.startsWith('local')), []);
  const plain = await run([]);
  assert.deepEqual(first.alerts.map((a) => a.alertId), plain.alerts.map((a) => a.alertId));
  assert.deepEqual([...first.statuses].map(([id, s]) => [id, s.state, s.origin]), [...plain.statuses].map(([id, s]) => [id, s.state, s.origin]));
});

test('a later load without the hand-off fetches both snapshot files itself', async () => {
  const log = /** @type {string[]} */ ([]);
  await run(log, { prefetch: early(log) });
  await run(log);
  assert.deepEqual(log.filter((l) => l.startsWith('local')).sort(), [`local ${LIVE_FILES.index}`, `local ${LIVE_FILES.tsunami}`].sort());
});

test('an aborted scope discards the early requests', async () => {
  const log = /** @type {string[]} */ ([]);
  const ac = new AbortController();
  ac.abort();
  await run(log, { prefetch: early(log), signal: ac.signal });
  assert.deepEqual(log.filter((l) => l.startsWith('local')).sort(), [`local ${LIVE_FILES.index}`, `local ${LIVE_FILES.tsunami}`].sort());
});

test('a failed early request still yields an honest unavailable status', async () => {
  const log = /** @type {string[]} */ ([]);
  const bad = { ok: false, error: { kind: 'network', message: 'down' }, fetchedAt: '2026-10-05T06:29:50Z', sourceId: 'x' };
  const r = await run(log, { prefetch: { index: Promise.resolve(/** @type {any} */ (bad)), tsunami: Promise.resolve(/** @type {any} */ (bad)) } });
  assert.equal(r.statuses.get('nws-alerts-active')?.state, 'unavailable');
  assert.deepEqual(r.alerts, []);
});

test('the Dashboard starts the live paths in LIVE_FILES and hands them to its first location only', () => {
  const src = readFileSync(path.join(ROOT, 'site', 'static', 'js', 'pages', 'dashboard.js'), 'utf8');
  assert.ok(src.includes(`fetchLocal('${LIVE_FILES.index}'`), 'index path matches LIVE_FILES.index');
  assert.ok(src.includes(`fetchLocal('${LIVE_FILES.tsunami}'`), 'tsunami path matches LIVE_FILES.tsunami');
  assert.ok(src.includes('early && early.gen === mine ? early : null; early = null;'), 'one-shot, generation-bound hand-off');
});
