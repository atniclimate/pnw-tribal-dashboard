// @ts-check
/** Water Survey of Canada normalizers against dated real captures. Owner: lane L7. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { WATEROFFICE_TEMPLATE } from '../../../scripts/reference/60-gauges.mjs';
import { bcTimeZone, normalizeWscRealtime, normalizeWscStations, WSC_THRESHOLD_NOTE } from '../../../site/static/js/hydro/wsc.js';

/** @param {any[]} a */
const first = (a) => a[0];
/** @param {string} dir @param {string} name */
const fixture = (dir, name) => JSON.parse(readFileSync(new URL(`../../fixtures/upstream/${dir}/2026-10-05-${name}.json`, import.meta.url), 'utf8'));

test('realtime: latest reading per station, level in metres, discharge in m3/s, never a category', () => {
  const items = normalizeWscRealtime(fixture('eccc-hydrometric-realtime', 'station-08mf005-latest'), { fetchedAt: '2026-10-05T07:45:56Z' });
  assert.equal(items.length, 1);
  const hope = first(items);
  assert.equal(hope.id, 'wsc:08MF005');
  assert.equal(hope.observed?.unit, 'm');
  assert.equal(hope.observed?.flowUnit, 'm3/s');
  assert.equal(hope.observed?.category, null);
  assert.equal(hope.forecast, null);
  const raw = fixture('eccc-hydrometric-realtime', 'station-08mf005-latest').features;
  const newest = raw.map((/** @type {any} */ f) => f.properties.DATETIME).sort().pop();
  assert.equal(hope.observed?.validTime, newest);
});

test('realtime: WSC stations carry no invented categories anywhere', () => {
  const items = normalizeWscRealtime(fixture('eccc-hydrometric-realtime', 'bc-window-40min'), { fetchedAt: '2026-10-05T07:45:55Z' });
  assert.ok(items.length > 5);
  for (const i of items) {
    assert.equal(i.observed?.category, null);
    assert.equal(i.forecast, null);
    assert.match(i.id, /^wsc:[0-9]{2}[A-Z]{2}[0-9]{3}$/);
  }
  assert.ok(!JSON.stringify(items).match(/minor|moderate|major|action|no_flooding|not_defined/));
});

test('realtime: a missing level or discharge is null, and zero stays zero', () => {
  const rows = [
    { properties: { STATION_NUMBER: '08MF005', DATETIME: '2026-10-05T07:00:00Z', LEVEL: null, DISCHARGE: 12.5 } },
    { properties: { STATION_NUMBER: '08MF006', DATETIME: '2026-10-05T07:00:00Z', LEVEL: 0, DISCHARGE: 0 } },
    { properties: { STATION_NUMBER: '08MF007', DATETIME: '2026-10-05T07:00:00Z', LEVEL: -999999, DISCHARGE: null } },
  ];
  const [a, b, c] = /** @type {any[]} */ (normalizeWscRealtime({ features: rows }, { fetchedAt: 'x' }));
  assert.equal(a.observed?.stage, null);
  assert.equal(a.observed?.unit, null);
  assert.equal(a.observed?.flow, 12.5);
  assert.equal(b.observed?.stage, 0);
  assert.equal(b.observed?.flow, 0);
  assert.equal(c.observed?.stage, null);
  assert.equal(c.observed?.flow, null);
});

test('realtime: a malformed body throws; bad station numbers are skipped', () => {
  assert.throws(() => normalizeWscRealtime({}, { fetchedAt: 'x' }), /features/);
  assert.deepEqual(normalizeWscRealtime({ features: [{ properties: { STATION_NUMBER: 'bad', DATETIME: '2026-10-05T00:00:00Z' } }] }, { fetchedAt: 'x' }), []);
});

test('stations: active real-time British Columbia only, stages null, a threshold note, no categories', () => {
  const st = normalizeWscStations(fixture('eccc-hydrometric-stations', 'bc-active-realtime'), { wateroffice: WATEROFFICE_TEMPLATE });
  assert.ok(st.length >= 30);
  for (const s of st) {
    assert.equal(s.stages, null);
    assert.equal(s.thresholdNote, WSC_THRESHOLD_NOTE);
    assert.equal(s.region, 'bc');
    assert.match(String(s.links.wateroffice), /^https:\/\/wateroffice\.ec\.gc\.ca\//);
    assert.ok(s.lat > 48 && s.lat < 61 && s.lon < -113 && s.lon > -140, `${s.id} is not in British Columbia`);
  }
  assert.ok(!JSON.stringify(st).match(/"(action|minor|moderate|major)"/));
  const ids = st.map((s) => s.id);
  assert.deepEqual(ids, [...ids].sort());
  assert.equal(new Set(ids).size, ids.length);
});

test('stations: discontinued or non-real-time stations are excluded', () => {
  const feature = (/** @type {any} */ over) => ({ properties: { STATION_NUMBER: '07EA001', STATION_NAME: 'X', PROV_TERR_STATE_LOC: 'BC', STATUS_EN: 'Active', REAL_TIME: 1, ...over }, geometry: { coordinates: [-125, 57] } });
  assert.equal(normalizeWscStations({ features: [feature({ STATUS_EN: 'Discontinued' })] }).length, 0);
  assert.equal(normalizeWscStations({ features: [feature({ REAL_TIME: 0 })] }).length, 0);
  assert.equal(normalizeWscStations({ features: [feature({ PROV_TERR_STATE_LOC: 'AB' })] }).length, 0);
  assert.equal(normalizeWscStations({ features: [feature({})] }).length, 1);
});

test('time zone heuristic gives Pacific on the coast and Mountain in the East Kootenay', () => {
  assert.equal(bcTimeZone(49.38, -121.45), 'America/Vancouver');
  assert.equal(bcTimeZone(49.5, -115.7), 'America/Edmonton');
});
