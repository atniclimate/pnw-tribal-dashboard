// @ts-check
/**
 * The May 2026 FLOOD_STAGES table (15 gauges) against NWPS thresholds captured 10/05/2026, with every
 * difference explained; CRNW1 carries the 50.7 ft action stage; every invalid or wrong LID is replaced.
 * Owner: lane L7 (blueprint 7.12).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { load } from 'js-yaml';
import { normalizeNwpsGauge } from '../../../site/static/js/hydro/nwps.js';

/** The May table as shipped in the legacy dashboard: [action, minor, moderate, major]. */
const MAY_TABLE = {
  SRPW1: [15, 16.5, 17.5, 18], HORW1: [null, null, null, null], QLTW1: [null, null, null, null], AUBW1: [null, null, null, null],
  SAKW1: [null, null, null, null], CRNZ1: [null, 54, 56, 58], TDAO3: [null, null, null, null], PRTO3: [17, 18, 24, 28],
  EKTO3: [25, 33, 40, 50], WHBI1: [30, 32, 33, 35], SPDI1: [17, 18, 19, 19.4], CTLI1: [42, 43, 46, 50],
  SNAI1: [9.5, 10.5, 11.5, 13], HEII1: [6.25, 8, 9.5, 11], BLFI1: [5.5, 5.8, null, null],
};

/**
 * Every difference between the table and NWPS today, with the reason. An empty list means identical values.
 * @type {Record<string, string>}
 */
const EXPLAINED_DIFFERENCES = {};

const FX = new URL('../../fixtures/upstream/nwps-gauges/', import.meta.url);
const ctx = { retrievedAt: '2026-10-05T07:00:00Z' };
/** @param {string} lid */
const gauge = (lid) => normalizeNwpsGauge(JSON.parse(readFileSync(new URL(`2026-10-05-gauge-${lid.toLowerCase()}.json`, FX), 'utf8')), ctx);
/** @param {ReturnType<typeof gauge>} g */
const stagesOf = (g) => [g.stages?.action ?? null, g.stages?.minor ?? null, g.stages?.moderate ?? null, g.stages?.major ?? null];

test('the May table has fifteen gauges and each one is captured', () => {
  assert.equal(Object.keys(MAY_TABLE).length, 15);
});

test('every difference between the May table and NWPS is explained', () => {
  /** @type {string[]} */
  const unexplained = [];
  for (const [lid, expected] of Object.entries(MAY_TABLE)) {
    const actual = stagesOf(gauge(lid));
    if (JSON.stringify(actual) !== JSON.stringify(expected) && !EXPLAINED_DIFFERENCES[lid]) {
      unexplained.push(`${lid}: table ${JSON.stringify(expected)} vs NWPS ${JSON.stringify(actual)}`);
    }
  }
  assert.deepEqual(unexplained, []);
  // Today the 15 rows agree with NWPS exactly, so no explained difference may linger as stale.
  for (const lid of Object.keys(EXPLAINED_DIFFERENCES)) {
    assert.notDeepEqual(stagesOf(gauge(lid)), MAY_TABLE[/** @type {keyof typeof MAY_TABLE} */ (lid)], `${lid} is listed as different but matches`);
  }
});

test('null May thresholds stay null in NWPS, which yields not_defined, never a threshold', () => {
  for (const lid of ['HORW1', 'QLTW1', 'AUBW1', 'SAKW1', 'TDAO3']) {
    assert.deepEqual(stagesOf(gauge(lid)), [null, null, null, null], lid);
  }
});

test('CRNW1 carries the 50.7 ft action stage that the May table omitted', () => {
  const crnw1 = gauge('CRNW1');
  assert.equal(crnw1.stages?.action, 50.7);
  assert.deepEqual(stagesOf(crnw1), [50.7, 54, 56, 58]);
  assert.equal(MAY_TABLE.CRNZ1[0], null, 'the table row for the same river had no action stage');
  assert.equal(gauge('CRNZ1').stages?.action, null);
  assert.equal(crnw1.usgsId, gauge('CRNZ1').usgsId, 'same USGS site: CRNZ1 is the discharge pseudo-point');
});

test('the Willamette, Umpqua, Snake, and Blackfoot rivers resolve to the right gauges', () => {
  assert.equal(gauge('EKTO3').river, 'Umpqua River');
  assert.equal(gauge('EKTO3').usgsId, '14321000');
  assert.equal(gauge('ELKO3').name, 'Elk Creek near Trail', 'ELKO3 is not the Umpqua');
  assert.equal(gauge('SNAI1').name, 'Snake River at Blackfoot');
  assert.equal(gauge('SNAI1').usgsId, '13062500');
  assert.match(gauge('BLFI1').name, /^Blackfoot River/);
});

/** Legacy LID to the gauge that replaces it (inventory audit and link audit, 10/04/2026). */
const REPLACEMENTS = {
  SKGW1: 'MVEW1', SNOQ1: 'SQUW1', SNHW1: 'SNAW1', CEHW1: 'CENW1', ARWW1: 'ARLW1', GOLW1: 'GLBW1', GPSO3: 'GRAO3',
  GLNI1: 'BIGI1', SALI1: 'SMNI1', ELKO3: 'EKTO3', BLFI1: 'SNAI1', CRNZ1: 'CRNW1',
};

test('every invalid or wrong LID is replaced as listed, in the reviewed overrides', () => {
  const overrides = /** @type {{ gaugeId: string, action: string, replaces: string, note: string, sourceUrl: string }[]} */ (
    load(readFileSync(new URL('../../../data/registry/gauges-overrides.yaml', import.meta.url), 'utf8')));
  const byOld = new Map(overrides.map((o) => [o.replaces, o]));
  assert.equal(overrides.length, Object.keys(REPLACEMENTS).length);
  for (const [oldLid, newLid] of Object.entries(REPLACEMENTS)) {
    const o = byOld.get(`nwps:${oldLid}`);
    assert.ok(o, `${oldLid} has no override`);
    assert.equal(o.gaugeId, `nwps:${newLid}`);
    assert.equal(o.action, 'replace');
    assert.ok(o.note.length > 20);
    assert.ok(o.sourceUrl.endsWith(`/gauges/${newLid}`));
  }
});

test('every replacement gauge exists in the dated captures with the right river and in-footprint state', () => {
  const expected = {
    MVEW1: 'Skagit River', SQUW1: 'Snoqualmie River', SNAW1: 'Snohomish River', CENW1: 'Chehalis River', ARLW1: 'Stillaguamish River',
    GLBW1: 'Skykomish River', GRAO3: 'Rogue River', BIGI1: 'Boise River', SMNI1: 'Salmon River', EKTO3: 'Umpqua River',
    SNAI1: 'Snake River', CRNW1: 'Snoqualmie River',
  };
  for (const [lid, river] of Object.entries(expected)) {
    const g = gauge(lid);
    assert.equal(g.river, river, lid);
    assert.equal(g.lid, lid);
    assert.ok(g.usgsId, `${lid} has a USGS id`);
  }
});

test('the invalid legacy LIDs are no longer referenced by any shipped code or data', () => {
  const sources = [
    '../../../site/static/js/hydro/nwps.js', '../../../site/static/js/hydro/gauges-service.js',
    '../../../scripts/reference/60-gauges.mjs', '../../../scripts/snapshot/tasks/gauges.mjs',
  ];
  const text = sources.map((p) => readFileSync(new URL(p, import.meta.url), 'utf8')).join('\n');
  for (const bad of ['SKGW1', 'SNOQ1', 'SNHW1', 'CEHW1', 'ARWW1', 'GOLW1', 'GPSO3', 'GLNI1', 'SALI1']) {
    assert.ok(!text.includes(bad), `${bad} appears in shipped code`);
  }
});
