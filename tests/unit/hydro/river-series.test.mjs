// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeRiverHistory, riverValue } from '../../../site/static/js/hydro/nwps-series.js';
import { aggregateGridpointDaily } from '../../../site/static/js/forecast/gridpoint-qpf.js';
import { normalizeWscHistory } from '../../../site/static/js/hydro/wsc-series.js';

test('river samples retain source values, zeroes, negative stage, metadata, and chronology', () => {
  const history = normalizeRiverHistory({ observed: { primaryName: 'Stage', primaryUnits: 'ft', secondaryName: 'Flow', secondaryUnits: 'kcfs', issuedTime: '2026-10-06T02:15:00Z', data: [
    { validTime: '2026-10-06T02:00:00Z', primary: 0, secondary: 0 },
    { validTime: '2026-10-06T01:45:00Z', primary: -0.2, secondary: null },
    { validTime: '2026-10-06T01:30:00Z', primary: -999, secondary: -9999 },
    { validTime: 'bad', primary: 4, secondary: 8 },
  ] }, forecast: { primaryName: 'Stage', primaryUnits: 'ft', data: [{ validTime: '2026-10-06T06:00:00Z', primary: 1.3 }] } });
  assert.deepEqual(history.observed.samples.map((p) => p.primary), [-0.2, 0]);
  assert.equal(history.observed.samples[1]?.secondary, 0);
  assert.equal(history.observed.primaryUnit, 'ft');
  assert.equal(history.forecast.samples[0]?.primary, 1.3);
  assert.equal(history.forecast.samples[0]?.secondary, null);
});

test('missing history stays absent instead of being manufactured from a latest reading', () => {
  const history = normalizeRiverHistory({ observed: { primary: 4, validTime: '2026-10-06T02:00:00Z' } });
  assert.deepEqual(history.observed.samples, []);
  assert.deepEqual(history.forecast.samples, []);
  assert.equal(history.forecast.issuedTime, null);
});

test('river unit conversion recognizes feet, cfs, and kcfs, retaining unsupported source units', () => {
  assert.deepEqual(riverValue(10, 'ft', 'metric'), { value: 3.048, unit: 'm' });
  assert.deepEqual(riverValue(1, 'kcfs', 'metric'), { value: 28.316846592, unit: 'm³/s' });
  assert.deepEqual(riverValue(1000, 'cfs', 'metric'), { value: 28.316846592, unit: 'm³/s' });
  assert.deepEqual(riverValue(2, 'unknown', 'metric'), { value: 2, unit: 'unknown' });
});

test('a probability-only day never becomes a zero-precipitation forecast', () => {
  const props = { quantitativePrecipitation: { uom: 'wmoUnit:mm', values: [{ validTime: '2026-10-06T00:00:00Z/PT24H', value: 0 }] }, probabilityOfPrecipitation: { values: [{ validTime: '2026-10-06T00:00:00Z/PT48H', value: 50 }] } };
  const days = aggregateGridpointDaily(props, 'UTC', new Date('2026-10-06T00:00:00Z'));
  assert.equal(days.length, 1);
  assert.equal(days[0]?.amountMm, 0);
  assert.deepEqual(aggregateGridpointDaily({ ...props, quantitativePrecipitation: { uom: 'unknown', values: props.quantitativePrecipitation.values } }, 'UTC', new Date('2026-10-06T00:00:00Z')), []);
});

test('WSC history filters to the selected station and reports truncated source responses', () => {
  const result = normalizeWscHistory({ numberMatched: 3, features: [
    { properties: { STATION_NUMBER: '07EA004', DATETIME: '2026-10-06T02:00:00Z', LEVEL: 2.608, DISCHARGE: 38.3 } },
    { properties: { STATION_NUMBER: '07EA005', DATETIME: '2026-10-06T02:00:00Z', LEVEL: 5, DISCHARGE: 100 } },
  ] }, '07EA004');
  assert.equal(result.history.observed.samples.length, 1);
  assert.equal(result.history.observed.samples[0]?.primary, 2.608);
  assert.equal(result.history.observed.primaryUnit, 'm');
  assert.deepEqual(result.history.forecast.samples, []);
  assert.equal(result.truncated, true);
});
