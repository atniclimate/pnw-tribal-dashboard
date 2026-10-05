// @ts-check
/**
 * Seam proof between the runner (L9) and the L7 gauges and wsc tasks: the real task modules run through the
 * runner over dated fixture captures, write schema-valid envelopes named for the task id, and a forced failure
 * carries the previous files forward. Also covers the binary-safe download helper. Owner: lane L9.
 */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { validateLive } from '../../../scripts/check/validate-live.mjs';
import { createFixtureHttp, downloadBytes } from '../../../scripts/lib/http.mjs';
import { runSnapshot } from '../../../scripts/snapshot/run.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const FIXTURES = path.join(ROOT, 'tests', 'fixtures', 'upstream');
const SHA = '0123456789abcdef0123456789abcdef01234567';
const T0 = new Date('2026-10-05T07:00:00Z');

/** @type {string} */
let tmp;
/** @type {string} */
let tasksDir;
before(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), 'cthd-l7-seam-'));
  tasksDir = path.join(tmp, 'tasks');
  await mkdir(tasksDir);
  for (const t of ['gauges', 'wsc']) {
    const href = pathToFileURL(path.join(ROOT, 'scripts', 'snapshot', 'tasks', `${t}.mjs`)).href;
    await writeFile(path.join(tasksDir, `${t}.mjs`), `export { default } from ${JSON.stringify(href)};\n`);
  }
});
after(async () => { await rm(tmp, { recursive: true, force: true }); });

/*
 * Real dated captures answer the footprint-tile and windowed-realtime URLs the tasks build (the captures were
 * taken for one tile and one window, so those two URL families are mapped onto them; no data is invented).
 */
const CAPTURED_LIST = 'https://api.water.noaa.gov/nwps/v1/gauges?bbox.xmin=-122.6&bbox.ymin=48.3&bbox.xmax=-121.9&bbox.ymax=48.9&srid=EPSG_4326';
const CAPTURED_REALTIME = 'https://api.weather.gc.ca/collections/hydrometric-realtime/items?f=json&limit=60&PROV_TERR_STATE_LOC=BC&datetime=2026-10-05T07:05:54Z/..';
/** @returns {Promise<() => import('../../../site/static/js/types.js').SnapshotHttp>} */
async function captureHttp() {
  const base = await createFixtureHttp(FIXTURES);
  /** @param {string} id @param {string} url */
  const map = (id, url) => (id === 'nwps-gauges' && url.includes('bbox.xmin') ? CAPTURED_LIST
    : id === 'eccc-hydrometric-realtime' && url.includes('PROV_TERR_STATE_LOC=BC') ? CAPTURED_REALTIME : url);
  return () => ({
    getJson: (id, url) => base.getJson(id, map(id, url)),
    getText: (id, url) => base.getText(id, map(id, url)),
    head: (id, url) => base.head(id, map(id, url)),
  });
}

/** @param {Partial<import('../../../scripts/snapshot/run.mjs').RunOptions> & { out: string }} o */
const run = async (o) => runSnapshot({ tasksDir, buildSha: SHA, now: T0, previous: null, log: () => {}, httpFor: await captureHttp(), ...o });
/** @param {string} d @param {string} f */
const readJson = async (d, f) => JSON.parse(await readFile(path.join(d, f), 'utf8'));

describe('L7 tasks through the runner', () => {
  test('fixture dry run writes both envelopes named for the task id, plus health and manifest', async () => {
    const out = path.join(tmp, 'first');
    const r = await run({ out });
    assert.equal(r.writeOrder.at(-1), 'manifest.json');
    for (const [file, id] of [['gauges-status.json', 'gauges'], ['wsc-status.json', 'wsc']]) {
      const env = await readJson(out, /** @type {string} */ (file));
      assert.equal(env.id, id);
      assert.equal(env.carriedForward, false);
      assert.notEqual(env.completeness, 'rejected');
      assert.ok(env.items.length > 0, `${file} carries items`);
    }
    const health = await readJson(out, 'health.json');
    assert.ok(health.items.some((/** @type {any} */ i) => i.id === 'gauges'), 'health names the gauges task');
    assert.deepEqual(await validateLive(out), []);
  });

  test('a forced failure carries both L7 files forward with their original observedAt', async () => {
    const first = path.join(tmp, 'carry-1');
    await run({ out: first });
    const out = path.join(tmp, 'carry-2');
    await run({ out, previous: first, failIds: ['gauges', 'wsc'], now: new Date('2026-10-05T07:30:00Z') });
    for (const f of ['gauges-status.json', 'wsc-status.json']) {
      const before = await readJson(first, f);
      const after = await readJson(out, f);
      assert.equal(after.carriedForward, true);
      assert.equal(after.observedAt, before.observedAt);
      assert.ok(after.failure, 'the failure is recorded');
    }
    assert.deepEqual(await validateLive(out), []);
  });
});

describe('downloadBytes', () => {
  test('returns exact bytes, including non-UTF-8 content', async () => {
    const bytes = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0xff, 0xfe, 0x00, 0x80]);
    const got = await downloadBytes('https://example.test/a.zip', { fetchImpl: async () => new Response(bytes, { status: 200 }) });
    assert.ok(got.equals(bytes));
  });
  test('throws on an HTTP error, a non-https URL, and an oversized body', async () => {
    await assert.rejects(downloadBytes('https://example.test/x', { fetchImpl: async () => new Response('no', { status: 404 }) }), /HTTP 404/);
    await assert.rejects(downloadBytes('http://example.test/x', { fetchImpl: async () => new Response('x') }), /https/);
    await assert.rejects(downloadBytes('https://example.test/x', { maxBytes: 2, fetchImpl: async () => new Response('abcdef') }), /larger than/);
  });
});
