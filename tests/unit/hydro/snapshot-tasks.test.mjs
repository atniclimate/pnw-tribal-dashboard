// @ts-check
/** The gauges and wsc snapshot tasks against real captures, validated against the live schemas. Owner: lane L7. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import gauges from '../../../scripts/snapshot/tasks/gauges.mjs';
import wsc, { realtimeUrl } from '../../../scripts/snapshot/tasks/wsc.mjs';
import { loadAjv, SCHEMA_BASE } from '../../../scripts/check/lib/data-files.mjs';

const NOW = new Date('2026-10-05T07:00:00Z');
/** @param {string} dir @param {string} name */
const fixture = (dir, name) => JSON.parse(readFileSync(new URL(`../../fixtures/upstream/${dir}/2026-10-05-${name}.json`, import.meta.url), 'utf8'));
const ok = (/** @type {unknown} */ data) => ({ ok: true, data, status: 200, fetchedAt: NOW.toISOString(), lastModified: null, sourceId: 's' });
const fail = { ok: false, error: { kind: 'timeout', message: 'timed out' }, fetchedAt: NOW.toISOString(), sourceId: 's' };

/** @param {(url: string) => any} respond @param {Record<string, unknown>} [refs] */
function ctx(respond, refs = {}) {
  /** @type {string[]} */
  const urls = [];
  return {
    urls,
    ctx: /** @type {any} */ ({
      now: NOW,
      http: { getJson: async (/** @type {string} */ _id, /** @type {string} */ url) => { urls.push(url); return respond(url); } },
      reference: async (/** @type {string} */ f) => { if (f in refs) return refs[f]; throw new Error('no reference'); },
      previous: async () => null,
      log: () => {},
    }),
  };
}

test('gauges task: contract fields and a schema-valid envelope from real captures', async () => {
  assert.equal(gauges.id, 'gauges');
  assert.deepEqual(gauges.outputs, ['gauges-status.json']);
  assert.equal(gauges.cadenceMin, 15);
  const list = fixture('nwps-gauges', 'bbox-skagit-nooksack');
  const c = ctx(() => ok(list));
  const out = await gauges.run(c.ctx);
  const env = /** @type {any} */ (out['gauges-status.json']);
  assert.equal(env.id, 'gauges');
  assert.equal(c.urls.length, 4, 'one request per footprint tile');
  assert.equal(env.completeness, 'complete');
  assert.equal(env.carriedForward, false);
  assert.equal(env.items.length, 8, 'the same gauges from every tile are deduplicated');
  assert.equal(env.asOfBasis, 'valid');
  const validate = (await loadAjv()).getSchema(`${SCHEMA_BASE}live-gauges-status.schema.json`);
  assert.ok(validate);
  assert.ok(validate(env), JSON.stringify(validate.errors));
  assert.ok(env.diagnostics.outOfService >= 1);
  assert.ok(env.diagnostics.notDefined >= 1);
});

test('gauges task: asOf is the upstream valid time, never the fetch time', async () => {
  const list = fixture('nwps-gauges', 'bbox-skagit-nooksack');
  const env = /** @type {any} */ ((await gauges.run(ctx(() => ok(list)).ctx))['gauges-status.json']);
  const times = list.gauges.map((/** @type {any} */ g) => g.status.observed.validTime).filter((/** @type {string} */ t) => t > '2000').sort();
  assert.equal(env.asOf, times[times.length - 1]);
  assert.notEqual(env.asOf, env.generatedAt);
});

test('gauges task: the reference list slims the output', async () => {
  const list = fixture('nwps-gauges', 'bbox-skagit-nooksack');
  const c = ctx(() => ok(list), { 'gauges.json': { gauges: [{ id: 'nwps:MVEW1' }, { id: 'nwps:ZZZZ9' }] } });
  const env = /** @type {any} */ ((await gauges.run(c.ctx))['gauges-status.json']);
  assert.deepEqual(env.items.map((/** @type {any} */ i) => i.id), ['nwps:MVEW1']);
  assert.equal(env.diagnostics.missingFromReference, 1);
});

test('gauges task: every tile failing is rejected with no items, and never throws', async () => {
  const env = /** @type {any} */ ((await gauges.run(ctx(() => fail).ctx))['gauges-status.json']);
  assert.equal(env.completeness, 'rejected');
  assert.deepEqual(env.items, []);
  assert.equal(env.asOf, null);
  assert.equal(env.failure.code, 'upstream');
  const validate = (await loadAjv()).getSchema(`${SCHEMA_BASE}live-gauges-status.schema.json`);
  assert.ok(validate?.(env), JSON.stringify(validate?.errors));
});

test('gauges task: one failed tile is partial, one malformed tile does not lose the others', async () => {
  const list = fixture('nwps-gauges', 'bbox-skagit-nooksack');
  let n = 0;
  const env = /** @type {any} */ ((await gauges.run(ctx(() => { n += 1; return n === 1 ? fail : n === 2 ? ok({ nope: true }) : ok(list); }).ctx))['gauges-status.json']);
  assert.equal(env.completeness, 'partial');
  assert.equal(env.items.length, 8);
  assert.equal(env.diagnostics.tilesOk, 2);
});

test('gauges task: gauges-status.json stays at most 80 KB gzip at footprint scale', async () => {
  // The real Washington, Oregon, and Idaho list holds 810 gauges. Measure bytes per gauge on a real capture and scale.
  const list = fixture('nwps-gauges', 'bbox-skagit-nooksack');
  const env = /** @type {any} */ ((await gauges.run(ctx(() => ok(list)).ctx))['gauges-status.json']);
  const perGauge = gzipSync(JSON.stringify(env)).length / env.items.length;
  assert.ok(perGauge * 1000 <= 80 * 1024, `${Math.round(perGauge)} B gzip per gauge exceeds the budget at 1,000 gauges`);
});

test('wsc task: windowed request, latest reading, a schema-valid envelope without categories', async () => {
  assert.equal(wsc.id, 'wsc');
  assert.deepEqual(wsc.outputs, ['wsc-status.json']);
  assert.equal(wsc.cadenceMin, 30);
  const raw = fixture('eccc-hydrometric-realtime', 'bc-window-40min');
  // The capture was limited to 60 of 282 rows; for the single-page case the test states that every row was returned.
  const body = { ...raw, numberMatched: raw.features.length };
  const c = ctx(() => ok(body));
  const env = /** @type {any} */ ((await wsc.run(c.ctx))['wsc-status.json']);
  assert.equal(env.id, 'wsc');
  assert.equal(c.urls.length, 1, 'one request per run when the window fits one page');
  assert.match(String(c.urls[0]), /PROV_TERR_STATE_LOC=BC/);
  assert.match(String(c.urls[0]), /datetime=2026-10-05T05:00:00Z\/\.\./);
  assert.equal(env.completeness, 'complete');
  assert.equal(env.asOfBasis, 'observed');
  assert.ok(env.items.length > 5);
  assert.ok(env.items.every((/** @type {any} */ i) => i.observed.category === null && i.forecast === null));
  const validate = (await loadAjv()).getSchema(`${SCHEMA_BASE}live-wsc-status.schema.json`);
  assert.ok(validate?.(env), JSON.stringify(validate?.errors));
});

test('wsc task: a window larger than the pages read is partial, and pages by offset', async () => {
  const body = fixture('eccc-hydrometric-realtime', 'bc-window-40min');
  const c = ctx(() => ok(body));
  const env = /** @type {any} */ ((await wsc.run(c.ctx))['wsc-status.json']);
  assert.equal(env.id, 'wsc');
  assert.equal(c.urls.length, 3);
  assert.match(String(c.urls[1]), /offset=10000/);
  assert.equal(env.completeness, 'partial');
});

test('wsc task: a reference station with no reading is "No current reading", not zero', async () => {
  const raw = fixture('eccc-hydrometric-realtime', 'station-08mf005-latest');
  const body = { ...raw, numberMatched: raw.features.length };
  const refs = { 'wsc-stations.json': { stations: [{ id: 'wsc:08MF005' }, { id: 'wsc:08MF999' }] } };
  const env = /** @type {any} */ ((await wsc.run(ctx(() => ok(body), refs).ctx))['wsc-status.json']);
  assert.deepEqual(env.items.map((/** @type {any} */ i) => i.id), ['wsc:08MF005', 'wsc:08MF999']);
  assert.equal(env.items[1].observed, null);
  assert.equal(env.diagnostics.noReading, 1);
});

test('wsc task: an upstream failure is a rejected envelope; the window URL is stable', async () => {
  const env = /** @type {any} */ ((await wsc.run(ctx(() => fail).ctx))['wsc-status.json']);
  assert.equal(env.completeness, 'rejected');
  assert.deepEqual(env.items, []);
  assert.equal(realtimeUrl(NOW, 0), 'https://api.weather.gc.ca/collections/hydrometric-realtime/items?f=json&limit=10000&offset=0&PROV_TERR_STATE_LOC=BC&datetime=2026-10-05T05:00:00Z/..');
});
