// @ts-check
/**
 * Live envelope helpers and validate-live (blueprint 5.10, 6.6). Owner: lane L9.
 */
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { validateLive } from '../../../scripts/check/validate-live.mjs';
import { loadAjv } from '../../../scripts/check/lib/data-files.mjs';
import {
  carriedEnvelope, envelopeErrors, failure, healthEnvelope, rejectedEnvelope, sanityErrors,
} from '../../../scripts/lib/live.mjs';
import { runSnapshot } from '../../../scripts/snapshot/run.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..', '..');
const NOW = new Date('2026-10-05T07:00:00Z');

/** @type {string} */
let tmp;
before(async () => { tmp = await mkdtemp(path.join(os.tmpdir(), 'cthd-live-')); });
after(async () => { await rm(tmp, { recursive: true, force: true }); });

/** @param {object} over */
const env = (over = {}) => /** @type {any} */ ({
  schema: 'cthd.live.gauges-status/1', id: 'gauges', sourceIds: ['nwps-gauges'], generatedAt: NOW.toISOString(),
  observedAt: NOW.toISOString(), asOf: null, asOfBasis: null, completeness: 'complete', carriedForward: false, failure: null,
  perSource: {}, diagnostics: {}, items: [], ...over,
});

describe('sanity bounds', () => {
  test('alerts above 2,000 and declarations above 500 fail', () => {
    assert.equal(sanityErrors('alerts.json', env({ items: new Array(2001).fill({}) })).length, 1);
    assert.equal(sanityErrors('alerts.json', env({ items: new Array(2000).fill({}) })).length, 0);
    assert.equal(sanityErrors('declarations-fema.json', env({ items: new Array(501).fill({}) })).length, 1);
  });

  test('stage bounds allow high-elevation datums while rejecting corruption and sentinels', () => {
    assert.equal(sanityErrors('gauges-status.json', env({ items: [{ observed: { stage: 12.3, unit: 'ft' } }] })).length, 0);
    assert.equal(sanityErrors('gauges-status.json', env({ items: [{ observed: { stage: 20001, unit: 'ft' } }] })).length, 1);
    assert.equal(sanityErrors('gauges-status.json', env({ items: [{ observed: { stage: 4309.33, unit: 'ft' } }] })).length, 0);
    assert.equal(sanityErrors('gauges-status.json', env({ items: [{ forecast: { stage: 1, crestStage: -60, unit: 'ft' } }] })).length, 1);
    assert.equal(sanityErrors('wsc-status.json', env({ items: [{ stage: 750.955, unit: 'm' }] })).length, 0);
    assert.equal(sanityErrors('wsc-status.json', env({ items: [{ stage: 7000, unit: 'm' }] })).length, 1);
    assert.ok(sanityErrors('gauges-status.json', env({ items: [{ observed: { stage: -999, unit: 'ft' } }] })).some((e) => /sentinel/.test(e)));
    assert.ok(sanityErrors('gauges-status.json', env({ items: [{ flow: -9999 }] })).some((e) => /sentinel/.test(e)));
  });

  test('every asOf must parse', () => {
    assert.equal(sanityErrors('news.json', env({ asOf: 'yesterday' })).length, 1);
    assert.equal(sanityErrors('news.json', env({ perSource: { 'news-opb': { ok: true, count: 0, asOf: 'nope' } } })).length, 1);
  });
});

describe('envelopes', () => {
  test('rejected, carried, and health envelopes validate against their schemas', async () => {
    const ajv = await loadAjv();
    const task = { id: 'news', sourceIds: ['news-opb'] };
    const fail = failure('http', 'HTTP 503', NOW);
    const rejected = rejectedEnvelope(task, 'news.json', fail, NOW);
    assert.deepEqual(envelopeErrors(ajv, 'news.json', rejected), []);
    const carried = carriedEnvelope({ ...rejected, completeness: 'complete', failure: null, observedAt: '2026-10-05T06:00:00Z' }, fail, NOW);
    assert.equal(carried.observedAt, '2026-10-05T06:00:00Z');
    assert.equal(carried.carriedForward, true);
    const health = healthEnvelope([
      { id: 'news', result: 'failed', envelopes: { 'news.json': rejected }, failure: fail },
      { id: 'gauges', result: 'ran', envelopes: {}, failure: null },
    ], NOW);
    assert.deepEqual(envelopeErrors(ajv, 'health.json', health), []);
    assert.equal(envelopeErrors(ajv, 'manifest.json', {}).length, 1);
    assert.equal(envelopeErrors(ajv, 'no-such-file.json', {}).length, 1);
  });
});

describe('validate-live', () => {
  test('detects a tampered file, an unlisted file, and a missing directory', async () => {
    const out = path.join(tmp, 'v');
    await runSnapshot({ out, tasksDir: path.join(HERE, 'fixture-tasks'), fixtures: path.join(ROOT, 'tests', 'fixtures', 'upstream'),
      previous: null, now: NOW, buildSha: '0123456789abcdef0123456789abcdef01234567', log: () => {} });
    assert.deepEqual(await validateLive(out), []);
    const news = path.join(out, 'news.json');
    const original = await readFile(news, 'utf8');
    await writeFile(news, original.replace('"carriedForward":false', '"carriedForward":true'));
    const errs = await validateLive(out);
    assert.ok(errs.some((e) => /SHA-256 differs/.test(e)), errs.join('\n'));
    assert.ok(errs.some((e) => /carriedForward differs/.test(e)), errs.join('\n'));
    await writeFile(news, original);
    await writeFile(path.join(out, 'extra.json'), '{}');
    assert.ok((await validateLive(out)).some((e) => /extra.json is not listed/.test(e)));
    assert.deepEqual(await validateLive(path.join(tmp, 'absent')), [`${path.join(tmp, 'absent')} does not exist`]);
  });
});
