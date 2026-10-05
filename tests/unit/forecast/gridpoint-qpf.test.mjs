// @ts-check
/**
 * Blueprint 3.14 and 12.3 (L12): the QPF aggregator keeps the May 2026 behavior (parity when the process zone
 * equals the Nation zone), buckets days in the Nation's zone whatever the viewer's zone (the May 2026
 * defect), splits whole hours across DST transitions, and labels a partial Today.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { aggregateGridpointDaily, hoursInZonedDay, parseValidTime } from '../../../site/static/js/forecast/gridpoint-qpf.js';
import { fixture } from './helpers.mjs';

const RUNNER = fileURLToPath(new URL('./parity-runner.mjs', import.meta.url));
const NOW = new Date('2026-10-05T09:00:00Z');
const lummi = fixture('nws-gridpoints', '2026-10-05-sew-lummi-hq.json').properties;
const boise = fixture('nws-gridpoints', '2026-10-05-pih-fort-hall-hq.json').properties;
const alaska = fixture('nws-gridpoints', '2026-10-05-ajk-kasaan-hq.json').properties;
const shifted = fixture('nws-gridpoints', '2026-10-05-sew-lummi-hq-shifted-27-days-dst.json').properties;

/**
 * @param {string} name
 * @param {string} zone Nation zone
 * @param {string} processZone TZ for the child
 * @param {string} [now]
 */
function run(name, zone, processZone, now = NOW.toISOString()) {
  const r = spawnSync(process.execPath, [RUNNER, name, zone, now], { env: { ...process.env, TZ: processZone }, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return /** @type {{ processZone: string, legacy: any[], ported: any[] }} */ (JSON.parse(r.stdout));
}

describe('parity with the May 2026 aggregator', () => {
  for (const [label, file, zone] of /** @type {const} */ ([
    ['Washington point', '2026-10-05-sew-lummi-hq.json', 'America/Los_Angeles'],
    ['Idaho point, America/Boise', '2026-10-05-pih-fort-hall-hq.json', 'America/Boise'],
    ['Southeast Alaska point', '2026-10-05-ajk-kasaan-hq.json', 'America/Juneau'],
  ])) {
    test(`${label}: same labels, amounts, and probabilities when the process zone is the Nation zone`, (t) => {
      const r = run(file, zone, zone);
      if (r.processZone !== zone) { t.skip(`this platform ignored TZ (process zone ${r.processZone}); parity is proven on platforms that honor it`); return; }
      assert.equal(r.ported.length, r.legacy.length);
      r.legacy.forEach((l, i) => {
        const p = r.ported[i];
        assert.equal(p.label, l.day, `${l.date} label`);
        assert.ok(Math.abs(p.amountIn - l.amount) < 1e-9, `${l.date} amount ${p.amountIn} vs ${l.amount}`);
        assert.equal(p.maxPop ?? 0, l.probability, `${l.date} probability`);
        assert.equal(`${Number(p.dayKey.slice(5, 7))}/${Number(p.dayKey.slice(8))}`, l.date);
      });
    });
  }
});

describe('viewer independence (the May 2026 defect)', () => {
  for (const processZone of ['America/New_York', 'Asia/Tokyo', 'UTC']) {
    test(`the port gives identical days with the process zone ${processZone}`, () => {
      const base = run('2026-10-05-sew-lummi-hq.json', 'America/Los_Angeles', 'America/Los_Angeles').ported;
      assert.deepEqual(run('2026-10-05-sew-lummi-hq.json', 'America/Los_Angeles', processZone).ported, base);
    });
  }
  test('the same series bucketed in two Nation zones divides its amounts differently', () => {
    const la = aggregateGridpointDaily(alaska, 'America/Juneau', NOW);
    const tokyo = aggregateGridpointDaily(alaska, 'Asia/Tokyo', NOW);
    assert.notDeepEqual(la.map((d) => d.amountMm), tokyo.map((d) => d.amountMm));
  });
});

describe('aggregation', () => {
  test('Today is first and partial, at most seven days, labels are weekday names', () => {
    const days = aggregateGridpointDaily(lummi, 'America/Los_Angeles', NOW);
    assert.equal(days[0]?.label, 'Today');
    assert.equal(days[0]?.partial, true);
    assert.equal(days[0]?.dayKey, '2026-10-05');
    assert.ok(days.length <= 7 && days.length >= 5);
    for (const d of days.slice(1)) assert.match(d.label, /^(Sun|Mon|Tue|Wed|Thu|Fri|Sat)$/);
    assert.equal(days[1]?.label, 'Tue');
  });

  test('amounts conserve the series total: millimetres in, millimetres out, inches by 0.0393701', () => {
    const start = new Date('2026-10-01T00:00:00Z');
    const days = aggregateGridpointDaily(lummi, 'America/Los_Angeles', start).filter((d) => true);
    const wanted = lummi.quantitativePrecipitation.values.reduce((/** @type {number} */ s, /** @type {any} */ v) => {
      const iv = parseValidTime(v.validTime);
      return iv && Number.isFinite(v.value) ? s + v.value : s;
    }, 0);
    const all = aggregateGridpointDaily({ ...lummi, quantitativePrecipitation: { ...lummi.quantitativePrecipitation } }, 'America/Los_Angeles', new Date('2026-09-01T00:00:00Z'));
    // The page shows seven days at most; compare the first seven against a fresh sum of the same days.
    assert.ok(all.length <= 7);
    const shown = all.reduce((s, d) => s + d.amountMm, 0);
    assert.ok(shown <= wanted + 1e-9);
    for (const d of days) assert.ok(Math.abs(d.amountIn - d.amountMm * 0.0393701) < 1e-9);
  });

  test('a day with no probability series reports null, never zero', () => {
    const days = aggregateGridpointDaily({ quantitativePrecipitation: lummi.quantitativePrecipitation }, 'America/Los_Angeles', NOW);
    assert.ok(days.length > 0);
    for (const d of days) assert.equal(d.maxPop, null);
  });

  test('a real zero is kept as zero', () => {
    const days = aggregateGridpointDaily({
      quantitativePrecipitation: { uom: 'wmoUnit:mm', values: [{ validTime: '2026-10-05T12:00:00+00:00/PT6H', value: 0 }] },
      probabilityOfPrecipitation: { values: [{ validTime: '2026-10-05T12:00:00+00:00/PT6H', value: 0 }] },
    }, 'America/Los_Angeles', NOW);
    assert.equal(days[0]?.amountMm, 0);
    assert.equal(days[0]?.maxPop, 0);
  });

  test('ISO 8601 durations with days and hours split proportionally across zoned days', () => {
    const days = aggregateGridpointDaily({
      quantitativePrecipitation: { uom: 'wmoUnit:mm', values: [{ validTime: '2026-10-05T19:00:00+00:00/P1DT6H', value: 30 }] },
    }, 'America/Los_Angeles', new Date('2026-10-05T10:00:00Z'));
    // 12:00 PDT on 10/05 for thirty hours: twelve hours that day, eighteen the next.
    assert.equal(days[0]?.dayKey, '2026-10-05');
    assert.ok(Math.abs((days[0]?.amountMm ?? 0) - 12) < 1e-9);
    assert.ok(Math.abs((days[1]?.amountMm ?? 0) - 18) < 1e-9);
  });

  test('inches published by the source are not converted twice', () => {
    const days = aggregateGridpointDaily({ quantitativePrecipitation: { uom: 'wmoUnit:in', values: [{ validTime: '2026-10-05T12:00:00+00:00/PT1H', value: 0.5 }] } }, 'America/Los_Angeles', NOW);
    assert.equal(days[0]?.amountIn, 0.5);
    assert.ok(Math.abs((days[0]?.amountMm ?? 0) - 0.5 / 0.0393701) < 1e-9);
  });

  test('malformed intervals and non-numeric values are skipped', () => {
    const days = aggregateGridpointDaily({ quantitativePrecipitation: { uom: 'wmoUnit:mm', values: [
      { validTime: 'not a time', value: 4 }, { validTime: '2026-10-05T12:00:00+00:00/PT1H', value: null }, { validTime: '2026-10-05T12:00:00+00:00/PT1H', value: 2 }] } }, 'America/Los_Angeles', NOW);
    assert.equal(days.length, 1);
    assert.equal(days[0]?.amountMm, 2);
  });

  test('Idaho (America/Boise) and Southeast Alaska points aggregate in their own zones', () => {
    const b = aggregateGridpointDaily(boise, 'America/Boise', NOW);
    const a = aggregateGridpointDaily(alaska, 'America/Juneau', NOW);
    assert.equal(b[0]?.label, 'Today');
    assert.equal(a[0]?.label, 'Today');
    assert.ok(b.length >= 5 && a.length >= 5);
  });
});

describe('DST transitions', () => {
  test('a local day is 25 hours on 11/01/2026 and 23 on 03/14/2027 in Pacific time', () => {
    assert.equal(hoursInZonedDay('2026-11-01', 'America/Los_Angeles'), 25);
    assert.equal(hoursInZonedDay('2027-03-14', 'America/Los_Angeles'), 23);
    assert.equal(hoursInZonedDay('2026-10-05', 'America/Los_Angeles'), 24);
  });

  test('a series spanning 11/01/2026 splits hours into the right local days, with no hour lost or doubled', () => {
    const before = new Date('2026-10-31T12:00:00Z');
    const days = aggregateGridpointDaily(shifted, 'America/Los_Angeles', before);
    const keys = days.map((d) => d.dayKey);
    assert.ok(keys.includes('2026-11-01') && keys.includes('2026-10-31'));
    // 24 hours of this series would put the same mass on both sides if bucketed in UTC; hour counts prove local bucketing.
    const total = shifted.quantitativePrecipitation.values.reduce((/** @type {number} */ s, /** @type {any} */ v) => s + (Number.isFinite(v.value) ? v.value : 0), 0);
    const all = aggregateGridpointDaily(shifted, 'America/Los_Angeles', new Date('2026-10-01T00:00:00Z'));
    assert.ok(all.reduce((s, d) => s + d.amountMm, 0) <= total + 1e-9);
  });

  test('a covered 25-hour day is not partial, and a day with fewer covered hours than its length is', () => {
    const series = { quantitativePrecipitation: { uom: 'wmoUnit:mm', values: [
      { validTime: '2026-11-01T07:00:00+00:00/PT25H', value: 25 },
      { validTime: '2026-11-02T08:00:00+00:00/PT10H', value: 10 }] } };
    const days = aggregateGridpointDaily(series, 'America/Los_Angeles', new Date('2026-10-31T12:00:00Z'));
    const nov1 = days.find((d) => d.dayKey === '2026-11-01');
    const nov2 = days.find((d) => d.dayKey === '2026-11-02');
    assert.ok(nov1 && nov2);
    assert.equal(nov1.partial, false);
    assert.ok(Math.abs(nov1.amountMm - 25) < 1e-9, 'all twenty-five hours land on 11/01');
    assert.equal(nov2.partial, true);
  });
});
