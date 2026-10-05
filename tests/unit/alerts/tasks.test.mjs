// @ts-check
/**
 * The three L3 snapshot tasks (blueprint 5.10, 6.4) on dated captures: schema-valid index, text, and
 * geometry envelopes; per-source carry-forward; hardened XML; BC candidate streams.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import alertsTask, { NWS_SNAPSHOT_URL, ECCC_SNAPSHOT_URL } from '../../../scripts/snapshot/tasks/alerts.mjs';
import tsunamiTask, { parseNtwcXml } from '../../../scripts/snapshot/tasks/tsunami.mjs';
import bcTask from '../../../scripts/snapshot/tasks/bc-hazards.mjs';
import { createFixtureHttp } from '../../../scripts/lib/http.mjs';
import { loadAjv } from '../../../scripts/check/lib/data-files.mjs';
import { envelopeErrors } from '../../../scripts/lib/live.mjs';
import { ROOT, UPSTREAM, fixture, testFootprintUgc } from './helpers.mjs';

const REGISTRY = path.join(ROOT, 'tests', 'fixtures', 'registry');
const index = JSON.parse(readFileSync(path.join(REGISTRY, 'nations-index.json'), 'utf8'));

/**
 * A snapshot context over the dated captures.
 * @param {{ previous?: Record<string, any>, http?: any, now?: string }} [o]
 * @returns {Promise<import('../../../site/static/js/types.js').SnapshotContext>}
 */
async function testCtx(o = {}) {
  const fpUgc = testFootprintUgc();
  return {
    now: new Date(o.now ?? '2026-10-05T06:30:00Z'),
    http: o.http ?? await createFixtureHttp(UPSTREAM),
    previous: async (f) => o.previous?.[f] ?? null,
    registry: { index, nation: async (id) => JSON.parse(readFileSync(path.join(REGISTRY, 'nations', `${id}.json`), 'utf8')) },
    reference: async (file) => {
      if (file === 'footprint-ugc.json') return fpUgc;
      const p = path.join(ROOT, 'site', 'data', 'ref', file);
      return JSON.parse(readFileSync(p, 'utf8'));
    },
    log: () => {},
  };
}

const ajv = await loadAjv();

test('alerts task writes schema-valid index, text, and geometry envelopes from the captures', async () => {
  assert.equal(NWS_SNAPSHOT_URL, fixture('nws-alerts-active', 'footprint-active.json').meta.url);
  assert.equal(ECCC_SNAPSHOT_URL, fixture('eccc-geomet-weather-alerts', 'bc-province-filter.json').meta.url);
  const out = await alertsTask.run(await testCtx());
  assert.deepEqual(Object.keys(out).sort(), [...alertsTask.outputs].sort());
  for (const [file, env] of Object.entries(out)) assert.deepEqual(envelopeErrors(ajv, file, env), [], file);
  const idx = /** @type {any} */ (out['alerts.json']);
  assert.equal(idx.completeness, 'complete');
  assert.equal(idx.perSource['nws-alerts-active'].asOf, '2026-10-05T06:23:38+00:00');
  assert.ok(idx.items.length > 0 && idx.items.length < 180, 'footprint filter applied');
  assert.ok(idx.items.every((/** @type {any} */ a) => !('sourceLanguage' in a) && !('geometry' in a)));
  const text = /** @type {any} */ (out['alerts-text.json']);
  assert.equal(text.items.length, idx.items.length);
  assert.ok(text.items.every((/** @type {any} */ t) => Object.keys(t.sourceLanguage).length > 0));
  // Lummi's marine waters are not in this fixture registry, but Washington zone alerts carry nationIds only when zones match.
  for (const a of idx.items) for (const n of a.nationIds) assert.ok(index.nations.some((/** @type {any} */ x) => x.id === n));
});

test('alerts task: NWS failure carries the previous NWS items forward with their original asOf', async () => {
  const first = await alertsTask.run(await testCtx());
  const base = await createFixtureHttp(UPSTREAM);
  const failingNws = { ...base, getJson: (/** @type {string} */ id, /** @type {string} */ url) => (id === 'nws-alerts-active'
    ? Promise.resolve({ ok: false, error: { kind: 'http', status: 503, message: 'HTTP 503' }, fetchedAt: '2026-10-05T06:40:00Z', sourceId: id })
    : base.getJson(id, url)) };
  const out = await alertsTask.run(await testCtx({ http: failingNws, previous: first, now: '2026-10-05T06:40:00Z' }));
  for (const [file, env] of Object.entries(out)) assert.deepEqual(envelopeErrors(ajv, file, env), [], file);
  const idx = /** @type {any} */ (out['alerts.json']);
  assert.equal(idx.completeness, 'partial');
  assert.equal(idx.perSource['nws-alerts-active'].ok, false);
  assert.equal(idx.perSource['nws-alerts-active'].asOf, '2026-10-05T06:23:38+00:00');
  assert.equal(idx.items.length, /** @type {any} */ (first['alerts.json']).items.length);
  assert.match(idx.failure.message, /HTTP 503/);
  // With no previous copy, the failed source contributes nothing and is marked partial for the client.
  const none = /** @type {any} */ ((await alertsTask.run(await testCtx({ http: failingNws })))['alerts.json']);
  assert.equal(none.items.filter((/** @type {any} */ a) => a.sourceId === 'nws-alerts-active').length, 0);
  assert.equal(none.diagnostics['partial:nws-alerts-active'], 1);
  assert.equal(none.perSource['nws-alerts-active'].asOf, null);
});

test('alerts task: both sources down with no previous copy is rejected, never an empty all-clear', async () => {
  const down = { getJson: async (/** @type {string} */ id) => ({ ok: false, error: { kind: 'timeout', message: 'timed out' }, fetchedAt: '2026-10-05T06:30:00Z', sourceId: id }), getText: async () => ({}), head: async () => ({}) };
  const out = await alertsTask.run(await testCtx({ http: down }));
  for (const [file, env] of Object.entries(out)) {
    assert.deepEqual(envelopeErrors(ajv, file, env), [], file);
    assert.equal(/** @type {any} */ (env).completeness, 'rejected');
    assert.equal(/** @type {any} */ (env).items.length, 0);
  }
});

test('tsunami task: schema-valid, hardened XML, retrieval time as asOf', async () => {
  const out = await tsunamiTask.run(await testCtx());
  assert.deepEqual(envelopeErrors(ajv, 'tsunami.json', out['tsunami.json']), []);
  const env = /** @type {any} */ (out['tsunami.json']);
  assert.equal(env.asOfBasis, 'retrieved');
  assert.equal(env.items.length, 0, 'the 09/29 Information Statement is not current on 10/05');
  assert.equal(env.diagnostics.notCurrent, 1);
  assert.throws(() => parseNtwcXml('<?xml version="1.0"?><!DOCTYPE feed [<!ENTITY x "y">]><feed>&x;</feed>'), /DOCTYPE/);
  const evil = { getText: async () => ({ ok: true, data: '<!DOCTYPE feed><feed/>', status: 200, fetchedAt: '2026-10-05T06:30:00Z', lastModified: null, sourceId: 'ntwc-atom' }) };
  const rejected = /** @type {any} */ ((await tsunamiTask.run(await testCtx({ http: evil })))['tsunami.json']);
  assert.equal(rejected.completeness, 'rejected');
  assert.deepEqual(envelopeErrors(ajv, 'tsunami.json', rejected), []);
});

test('bc-hazards task: schema-valid; active evacuation records only; quiet basins and zones counted', async () => {
  const out = await bcTask.run(await testCtx());
  assert.deepEqual(envelopeErrors(ajv, 'bc-hazards.json', out['bc-hazards.json']), []);
  const env = /** @type {any} */ (out['bc-hazards.json']);
  assert.equal(env.completeness, 'complete');
  assert.equal(env.items.length, 16);
  assert.ok(env.items.every((/** @type {any} */ i) => i.sourceId === 'bc-emcr-evacuations'));
  assert.deepEqual(new Set(env.items.map((/** @type {any} */ i) => i.kind)), new Set(['evacuation-order', 'evacuation-alert']));
  assert.equal(env.perSource['bc-rfc-flood-advisories'].count, 0);
  assert.equal(env.perSource['bc-embc-tsunami'].count, 0);
  assert.equal(env.diagnostics['noNotification:bc-embc-tsunami'], 5);
});
