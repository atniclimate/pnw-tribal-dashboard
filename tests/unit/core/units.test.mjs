// @ts-check
/**
 * core/units.js (blueprint 3.10): zero is a reading; null, NaN, and agency sentinels are "No current reading".
 * Precision rules per quantity; unit systems follow the Nation unless overridden.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  formatFlow, formatPrecipitation, formatStage, formatTemperature, isMissingReading, normalizeUnit, NO_READING, toNumberOrNull, unitSystemFor,
} from '../../../site/static/js/core/units.js';

describe('zero versus sentinel', () => {
  test('a real zero is a reading in every quantity', () => {
    assert.equal(isMissingReading(0, 'ft'), false);
    assert.equal(formatStage(0, 'ft', 'us'), '0.0 ft');
    assert.equal(formatPrecipitation(0, 'in', 'us'), '0.00 in');
    assert.equal(formatPrecipitation(0, 'mm', 'metric'), '0 mm');
    assert.equal(formatFlow(0, 'cfs', 'us'), '0 cfs');
    assert.equal(formatTemperature(0, 'C', 'metric'), '0°C');
    assert.equal(formatTemperature(0, 'F', 'us'), '0°F');
  });

  test('null, undefined, NaN, and infinities are missing', () => {
    for (const v of [null, undefined, Number.NaN, Infinity, -Infinity]) assert.equal(isMissingReading(v), true);
    assert.equal(isMissingReading(/** @type {any} */ ('3')), true, 'a string is not a reading');
  });

  test('USGS -999999, NWPS -999 and -9999 never display, in any unit', () => {
    for (const s of [-999999, -999, -9999]) {
      assert.equal(isMissingReading(s), true);
      assert.equal(isMissingReading(s, 'ft'), true);
      assert.equal(formatStage(s, 'ft', 'us'), NO_READING);
      assert.equal(formatFlow(s, 'cfs', 'us'), NO_READING);
      assert.equal(formatPrecipitation(s, 'in', 'us'), NO_READING);
      assert.equal(formatTemperature(s, 'F', 'us'), NO_READING);
    }
  });

  test('per-unit out-of-range values are missing, boundaries are not', () => {
    assert.equal(isMissingReading(2000, 'ft'), true);
    assert.equal(isMissingReading(1000, 'ft'), false);
    assert.equal(isMissingReading(-101, 'ft'), true);
    assert.equal(isMissingReading(-1, 'cfs'), true);
    assert.equal(isMissingReading(200, 'C'), true);
    assert.equal(isMissingReading(-40, 'C'), false);
    assert.equal(isMissingReading(-40, 'F'), false);
    assert.equal(isMissingReading(500, 'in'), true);
    assert.equal(isMissingReading(-1, 'mm'), true);
    assert.equal(isMissingReading(500, 'unknown-unit'), false);
  });

  test('WMO unit spellings are normalized before the range check', () => {
    assert.equal(normalizeUnit('wmoUnit:degC'), 'C');
    assert.equal(normalizeUnit('wmoUnit:mm'), 'mm');
    assert.equal(normalizeUnit('degF'), 'F');
    assert.equal(normalizeUnit('m³3/s'.replace('3/s', '/s')), 'm3/s');
    assert.equal(normalizeUnit(undefined), '');
    assert.equal(isMissingReading(500, 'wmoUnit:degC'), true);
    assert.equal(isMissingReading(20, 'wmoUnit:degC'), false);
  });
});

describe('toNumberOrNull', () => {
  test('keeps zero, parses numeric strings, and nulls the rest', () => {
    assert.equal(toNumberOrNull(0), 0);
    assert.equal(toNumberOrNull('0'), 0);
    assert.equal(toNumberOrNull('0.0'), 0);
    assert.equal(toNumberOrNull(' 12.5 '), 12.5);
    assert.equal(toNumberOrNull(-3), -3);
    for (const bad of ['', '  ', 'abc', '1,2', null, undefined, Number.NaN, Infinity, {}, [], true, '12 ft']) assert.equal(toNumberOrNull(bad), null);
  });
});

describe('unitSystemFor', () => {
  test('override beats Nation, Nation beats native', () => {
    assert.equal(unitSystemFor('us', null), 'us');
    assert.equal(unitSystemFor('metric', null), 'metric');
    assert.equal(unitSystemFor('us', 'metric'), 'metric');
    assert.equal(unitSystemFor(null, 'us'), 'us');
    assert.equal(unitSystemFor(null, null), 'native');
  });
});

describe('formatPrecipitation', () => {
  test('two decimals under one inch, one at or above', () => {
    assert.equal(formatPrecipitation(0.256, 'in', 'us'), '0.26 in');
    assert.equal(formatPrecipitation(0.99, 'in', 'us'), '0.99 in');
    assert.equal(formatPrecipitation(1, 'in', 'us'), '1.0 in');
    assert.equal(formatPrecipitation(2.46, 'in', 'us'), '2.5 in');
  });

  test('above zero and below 0.005 in prints "less than 0.01 in"', () => {
    assert.equal(formatPrecipitation(0.004, 'in', 'us'), 'less than 0.01 in');
    assert.equal(formatPrecipitation(0.005, 'in', 'us'), '0.01 in');
    assert.equal(formatPrecipitation(0.1, 'mm', 'us'), 'less than 0.01 in');
  });

  test('metric is whole millimetres, with a floor message under half a millimetre', () => {
    assert.equal(formatPrecipitation(12.6, 'mm', 'metric'), '13 mm');
    assert.equal(formatPrecipitation(0.3, 'mm', 'metric'), 'less than 1 mm');
    assert.equal(formatPrecipitation(0.5, 'mm', 'metric'), '1 mm');
  });

  test('conversion follows the system; native keeps the payload unit', () => {
    assert.equal(formatPrecipitation(25.4, 'mm', 'us'), '1.0 in');
    assert.equal(formatPrecipitation(1, 'in', 'metric'), '25 mm');
    assert.equal(formatPrecipitation(25.4, 'mm', 'native'), '25 mm');
    assert.equal(formatPrecipitation(0.5, 'in', 'native'), '0.50 in');
  });

  test('null reads No current reading', () => {
    assert.equal(formatPrecipitation(null, 'in', 'us'), 'No current reading');
  });
});

describe('formatStage', () => {
  test('one decimal in feet, two in metres', () => {
    assert.equal(formatStage(28, 'ft', 'us'), '28.0 ft');
    assert.equal(formatStage(50.74, 'ft', 'native'), '50.7 ft');
    assert.equal(formatStage(3.456, 'm', 'metric'), '3.46 m');
  });

  test('converts between systems', () => {
    assert.equal(formatStage(10, 'm', 'us'), '32.8 ft');
    assert.equal(formatStage(28, 'ft', 'metric'), '8.53 m');
  });

  test('negative stages print their sign; negative zero never prints', () => {
    assert.equal(formatStage(-1.234, 'ft', 'us'), '-1.2 ft');
    assert.equal(formatStage(-0.001, 'ft', 'us'), '0.0 ft');
  });
});

describe('formatFlow', () => {
  test('three significant figures', () => {
    assert.equal(formatFlow(1234, 'cfs', 'us'), '1,230 cfs');
    assert.equal(formatFlow(45.678, 'cfs', 'us'), '45.7 cfs');
    assert.equal(formatFlow(5.5, 'cfs', 'us'), '5.50 cfs');
    assert.equal(formatFlow(0.0234, 'cfs', 'us'), '0.0234 cfs');
    assert.equal(formatFlow(999, 'cfs', 'us'), '999 cfs');
  });

  test('kcfs above 10,000 cfs', () => {
    assert.equal(formatFlow(10_000, 'cfs', 'us'), '10,000 cfs');
    assert.equal(formatFlow(12_345, 'cfs', 'us'), '12.3 kcfs');
    assert.equal(formatFlow(123_456, 'cfs', 'us'), '123 kcfs');
    assert.equal(formatFlow(15, 'kcfs', 'us'), '15.0 kcfs');
  });

  test('metric prints cubic metres per second', () => {
    assert.equal(formatFlow(1000, 'cfs', 'metric'), '28.3 m³/s');
    assert.equal(formatFlow(120, 'm3/s', 'metric'), '120 m³/s');
    assert.equal(formatFlow(120, 'm3/s', 'native'), '120 m³/s');
    assert.equal(formatFlow(100, 'm3/s', 'us'), '3.53 kcfs'.replace('3.53 kcfs', '3,530 cfs'));
  });
});

describe('formatTemperature', () => {
  test('integers, in the requested system', () => {
    assert.equal(formatTemperature(54.4, 'F', 'us'), '54°F');
    assert.equal(formatTemperature(12.5, 'C', 'metric'), '13°C');
    assert.equal(formatTemperature(0, 'C', 'us'), '32°F');
    assert.equal(formatTemperature(32, 'F', 'metric'), '0°C');
    assert.equal(formatTemperature(20, 'C', 'native'), '20°C');
  });

  test('null reads No current reading', () => {
    assert.equal(formatTemperature(null, 'F', 'us'), NO_READING);
  });
});
