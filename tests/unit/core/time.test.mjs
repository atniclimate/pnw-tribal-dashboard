// @ts-check
/**
 * core/time.js: house-style stamps, zone abbreviations, zoned day keys across both DST transitions in seven
 * zones, interval splitting, durations. The process zone is forced to America/New_York to prove that nothing
 * depends on the viewer's zone (blueprint 3.14).
 */
process.env.TZ = 'America/New_York';

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { checkTimeZoneData, formatAsOf, formatDate, formatTime, parseIsoDuration, relativeAge, splitByZonedDay, timeZoneOffsetMinutes, zoneAbbreviation, zonedDayKey } from '../../../site/static/js/core/time.js';

const HOUR = 3_600_000;

describe('time zone data self-check', () => {
  test('accepts confirmed winter offsets without depending on browser abbreviations', () => {
    /** @type {string[]} */
    const probed = [];
    const issues = checkTimeZoneData((date, zone) => {
      assert.equal(date.toISOString(), '2026-11-02T12:00:00.000Z');
      probed.push(zone);
      return zone === 'America/Vancouver' ? -420 : -360;
    });
    assert.deepEqual(issues, []);
    assert.deepEqual(probed, ['America/Vancouver', 'America/Edmonton']);
  });

  test('reports old seasonal rules and preserves the offsets the browser returned', () => {
    const issues = checkTimeZoneData((_date, zone) => zone === 'America/Vancouver' ? -480 : -420);
    assert.deepEqual(issues.map(({ timeZone, expectedMinutes, actualMinutes }) => ({ timeZone, expectedMinutes, actualMinutes })), [
      { timeZone: 'America/Vancouver', expectedMinutes: -420, actualMinutes: -480 },
      { timeZone: 'America/Edmonton', expectedMinutes: -360, actualMinutes: -420 },
    ]);
  });

  test('reports only the stale region when a device has the British Columbia update alone', () => {
    const issues = checkTimeZoneData(() => -420);
    assert.equal(issues.length, 1);
    assert.equal(issues[0]?.region, 'Alberta');
  });

  test('missing, throwing, and non-finite offset readers remain unavailable rather than passing', () => {
    for (const reader of [() => null, () => { throw new RangeError('unsupported zone'); }, () => NaN]) {
      const issues = checkTimeZoneData(reader);
      assert.equal(issues.length, 2);
      assert.ok(issues.every((issue) => issue.actualMinutes === null));
    }
  });

  test('reads actual device offsets and leaves existing formatting unchanged after a failed check', () => {
    const before = formatAsOf('2026-12-01T12:00:00Z', 'America/Vancouver');
    checkTimeZoneData(() => -999);
    assert.equal(formatAsOf('2026-12-01T12:00:00Z', 'America/Vancouver'), before);
    assert.equal(timeZoneOffsetMinutes(new Date('2026-12-01T12:00:00Z'), 'UTC'), 0);
    assert.equal(timeZoneOffsetMinutes(new Date('2026-12-01T12:00:00Z'), 'America/Los_Angeles'), -480);
    assert.equal(timeZoneOffsetMinutes(new Date('2026-07-01T12:00:00Z'), 'America/Los_Angeles'), -420);
    assert.equal(timeZoneOffsetMinutes(new Date('2026-12-01T12:00:00Z'), 'Asia/Kathmandu'), 345);
    assert.equal(timeZoneOffsetMinutes(new Date(), 'Not/A_Zone'), null);
    assert.equal(timeZoneOffsetMinutes(new Date(NaN), 'UTC'), null);
  });
});

describe('formatAsOf', () => {
  test('returns "10/04/2026 3:15 PM PDT" for 22:15 UTC in Los Angeles', () => {
    assert.equal(formatAsOf('2026-10-04T22:15:00Z', 'America/Los_Angeles'), '10/04/2026 3:15 PM PDT');
  });

  test('uses MM/DD/YYYY, 12-hour time with no leading zero on the hour, and the zone abbreviation', () => {
    assert.equal(formatAsOf('2026-01-05T08:05:00Z', 'America/Los_Angeles'), '01/05/2026 12:05 AM PST');
    assert.equal(formatAsOf('2026-01-05T20:00:00Z', 'America/Los_Angeles'), '01/05/2026 12:00 PM PST');
  });

  test('the seven Nation zones print their own abbreviations', () => {
    const t = '2026-07-15T19:30:00Z';
    assert.equal(formatAsOf(t, 'America/Los_Angeles'), '07/15/2026 12:30 PM PDT');
    assert.equal(formatAsOf(t, 'America/Boise'), '07/15/2026 1:30 PM MDT');
    assert.equal(formatAsOf(t, 'America/Denver'), '07/15/2026 1:30 PM MDT');
    assert.equal(formatAsOf(t, 'America/Vancouver'), '07/15/2026 12:30 PM PDT');
    assert.equal(formatAsOf(t, 'America/Edmonton'), '07/15/2026 1:30 PM MDT');
    assert.equal(formatAsOf(t, 'America/Juneau'), '07/15/2026 11:30 AM AKDT');
    assert.equal(formatAsOf(t, 'America/Creston'), '07/15/2026 12:30 PM MST');
  });

  test('the viewer zone is used when none is given (here forced to America/New_York)', () => {
    assert.equal(formatAsOf('2026-10-04T22:15:00Z'), '10/04/2026 6:15 PM EDT');
  });

  test('an unparseable value is stated, never rendered as a date', () => {
    assert.equal(formatAsOf('not a time'), 'Time unavailable');
    assert.equal(formatDate('nope'), 'Time unavailable');
    assert.equal(formatTime('nope'), 'Time unavailable');
    assert.equal(relativeAge('nope', new Date()), 'Time unavailable');
  });

  test('formatDate and formatTime are the two halves', () => {
    assert.equal(formatDate('2026-10-04T22:15:00Z', 'America/Los_Angeles'), '10/04/2026');
    assert.equal(formatTime('2026-10-04T22:15:00Z', 'America/Los_Angeles'), '3:15 PM PDT');
  });

  test('the date follows the zone across midnight', () => {
    assert.equal(formatDate('2026-10-05T03:00:00Z', 'America/Los_Angeles'), '10/04/2026');
    assert.equal(formatDate('2026-10-05T03:00:00Z', 'America/New_York'), '10/04/2026');
    assert.equal(formatDate('2026-10-05T05:00:00Z', 'America/New_York'), '10/05/2026');
  });
});

describe('zoneAbbreviation', () => {
  test('names, not offsets', () => {
    assert.equal(zoneAbbreviation(new Date('2026-12-01T12:00:00Z'), 'America/Juneau'), 'AKST');
    assert.equal(zoneAbbreviation(new Date('2026-12-01T12:00:00Z'), 'America/Boise'), 'MST');
    assert.equal(zoneAbbreviation(new Date('2026-07-01T12:00:00Z'), 'America/Vancouver'), 'PDT');
  });
});

describe('zonedDayKey across both DST transitions in seven zones', () => {
  // Fall back 11/01/2026 (25-hour day where observed); spring forward 03/14/2027 (23-hour day where observed).
  // Pacific-time British Columbia (03/08/2026) and Alberta (2026) moved to permanent time; tzdata records those
  // changes at different versions, so whether a zone transitions depends on the runtime's zone database. The
  // module reads that database and hard-codes nothing, so the expected day length is derived from the same
  // database: 24 hours minus the change in UTC offset across the day.
  const ZONES = ['America/Los_Angeles', 'America/Boise', 'America/Denver', 'America/Vancouver', 'America/Edmonton',
    'America/Juneau', 'America/Creston'];

  /**
   * UTC offset in minutes of `zone` at instant `ms`, read from the runtime zone database.
   * @param {string} zone
   * @param {number} ms
   */
  function offsetMinutes(zone, ms) {
    const name = new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'longOffset' })
      .formatToParts(new Date(ms)).find((p) => p.type === 'timeZoneName')?.value ?? 'GMT';
    const m = /GMT([+-])(\d{2}):(\d{2})/.exec(name);
    return m ? (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3])) : 0;
  }

  /**
   * Expected length in hours of the local day `day`: noon UTC the day before versus noon UTC the day after.
   * @param {string} zone
   * @param {string} day YYYY-MM-DD
   */
  function expectedHours(zone, day) {
    const mid = Date.parse(`${day}T12:00:00Z`);
    return 24 - (offsetMinutes(zone, mid + 24 * HOUR) - offsetMinutes(zone, mid - 24 * HOUR)) / 60;
  }

  /**
   * Walk 72 real hours starting 30 hours before local midnight of the transition day and count hours per day.
   * @param {string} zone
   * @param {string} day YYYY-MM-DD, the transition date
   */
  function hoursPerDay(zone, day) {
    // Local midnight of `day`: search the UTC hour whose key first equals `day`.
    const [y, m, d] = day.split('-').map(Number);
    let t = Date.UTC(/** @type {number} */ (y), /** @type {number} */ (m) - 1, /** @type {number} */ (d)) - 20 * HOUR;
    while (zonedDayKey(new Date(t), zone) !== day) t += HOUR;
    const start = t;
    /** @type {Map<string, number>} */
    const counts = new Map();
    let prev = '';
    for (let i = -30; i < 42; i += 1) {
      const key = zonedDayKey(new Date(start + i * HOUR), zone);
      assert.ok(key >= prev, `keys never go backward (${zone}, ${key} after ${prev})`);
      prev = key;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return counts;
  }

  for (const zone of ZONES) {
    test(`${zone}: fall-back day 11/01/2026 has the length the zone database gives`, () => {
      assert.equal(hoursPerDay(zone, '2026-11-01').get('2026-11-01'), expectedHours(zone, '2026-11-01'));
    });
    test(`${zone}: spring-forward day 03/14/2027 has the length the zone database gives`, () => {
      assert.equal(hoursPerDay(zone, '2027-03-14').get('2027-03-14'), expectedHours(zone, '2027-03-14'));
    });
  }

  test('Los Angeles still observes both transitions (guards the derivation itself)', () => {
    assert.equal(expectedHours('America/Los_Angeles', '2026-11-01'), 25);
    assert.equal(expectedHours('America/Los_Angeles', '2027-03-14'), 23);
  });

  test('the same instant is a different day in different zones, and never the process zone (New York)', () => {
    const t = new Date('2026-11-01T06:30:00Z'); // 11:30 PM 10/31 PDT; 2:30 AM 11/01 EDT
    assert.equal(zonedDayKey(t, 'America/Los_Angeles'), '2026-10-31');
    assert.equal(zonedDayKey(t, 'America/New_York'), '2026-11-01');
    assert.equal(zonedDayKey(t, 'America/Juneau'), '2026-10-31');
  });

  test('keys are zero-padded YYYY-MM-DD', () => {
    assert.equal(zonedDayKey(new Date('2026-03-05T20:00:00Z'), 'America/Boise'), '2026-03-05');
  });
});

describe('splitByZonedDay', () => {
  test('splits an interval across zoned days by hour and conserves the total', () => {
    // 6 mm over the 6 hours ending 11:00 PM... 9 PM to 3 AM PDT on 10/04 to 10/05 (04:00Z to 10:00Z on 10/05).
    const out = splitByZonedDay(new Date('2026-10-05T04:00:00Z'), new Date('2026-10-05T10:00:00Z'), 6, 'America/Los_Angeles');
    assert.deepEqual([...out.keys()], ['2026-10-04', '2026-10-05']);
    assert.equal(out.get('2026-10-04'), 3);
    assert.equal(out.get('2026-10-05'), 3);
  });

  test('across the 25-hour fall-back day each real hour is counted once', () => {
    const start = new Date('2026-11-01T07:00:00Z'); // local midnight 11/01 PDT
    const out = splitByZonedDay(start, new Date(start.getTime() + 48 * HOUR), 48, 'America/Los_Angeles');
    assert.equal(out.get('2026-11-01'), 25);
    assert.equal(out.get('2026-11-02'), 23);
    assert.equal([...out.values()].reduce((a, b) => a + b, 0), 48);
  });

  test('across the 23-hour spring-forward day', () => {
    const start = new Date('2027-03-14T08:00:00Z'); // local midnight 03/14 PST
    const out = splitByZonedDay(start, new Date(start.getTime() + 48 * HOUR), 48, 'America/Los_Angeles');
    assert.equal(out.get('2027-03-14'), 23);
    assert.equal(out.get('2027-03-15'), 24);
    assert.equal(out.get('2027-03-16'), 1);
    assert.equal([...out.values()].reduce((a, b) => a + b, 0), 48);
  });

  test('a zero-length or sub-hour interval counts as one hour', () => {
    const t = new Date('2026-10-05T12:00:00Z');
    assert.deepEqual([...splitByZonedDay(t, t, 2, 'America/Boise').entries()], [['2026-10-05', 2]]);
  });
});

describe('relativeAge', () => {
  const now = new Date('2026-10-04T23:00:00Z');
  test('steps from just now to minutes, hours, and days', () => {
    assert.equal(relativeAge('2026-10-04T22:59:30Z', now), 'just now');
    assert.equal(relativeAge('2026-10-04T22:59:00Z', now), '1 min ago');
    assert.equal(relativeAge('2026-10-04T22:00:00Z', now), '1 hr ago');
    assert.equal(relativeAge('2026-10-04T22:15:00Z', now), '45 min ago');
    assert.equal(relativeAge('2026-10-04T09:00:00Z', now), '14 hr ago');
    assert.equal(relativeAge('2026-10-01T23:00:00Z', now), '3 days ago');
  });

  test('a time in the future reads just now', () => {
    assert.equal(relativeAge('2026-10-05T00:00:00Z', now), 'just now');
  });
});

describe('parseIsoDuration', () => {
  test('hours, days, minutes, seconds, weeks, and fractions', () => {
    assert.equal(parseIsoDuration('PT6H'), 6 * HOUR);
    assert.equal(parseIsoDuration('PT1H'), HOUR);
    assert.equal(parseIsoDuration('P1DT6H'), 30 * HOUR);
    assert.equal(parseIsoDuration('P2D'), 48 * HOUR);
    assert.equal(parseIsoDuration('PT30M'), 1_800_000);
    assert.equal(parseIsoDuration('PT45S'), 45_000);
    assert.equal(parseIsoDuration('PT1.5H'), 5_400_000);
    assert.equal(parseIsoDuration('P1W'), 7 * 24 * HOUR);
    assert.equal(parseIsoDuration('PT0S'), 0);
  });

  test('years, months, and malformed text throw', () => {
    for (const bad of ['P1Y', 'P1M', 'P1Y2M', '6H', 'PT', 'P', '', 'PTH', 'P1DT']) {
      assert.throws(() => parseIsoDuration(bad), /duration/i, bad);
    }
  });
});
