// @ts-check
/**
 * Blueprint 3.14 and 7.3 (L12): the NWS and ECCC loaders. Requests go through the source registry (URLs and
 * headers asserted), payloads are the dated captures, and "Current Conditions" comes only from an observation.
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { loadLatestAfd } from '../../../site/static/js/forecast/afd.js';
import { cityForecastLabel, findNearestCityPage, loadCityPage, normalizeCityPage } from '../../../site/static/js/forecast/eccc-citypage.js';
import { FORECAST_LABEL, loadPointForecast, normalizeForecastPeriods, parsePoint } from '../../../site/static/js/forecast/nws-forecast.js';
import { loadCurrentObservation, normalizeObservation, stationIds } from '../../../site/static/js/forecast/observation.js';
import { loadQpf } from '../../../site/static/js/forecast/gridpoint-qpf.js';
import { fixture, installFetch, loadRegistry, urlHas } from './helpers.mjs';

const lummiHq = /** @type {[number, number]} */ ([48.79202, -122.6262]);
const points = fixture('nws-points', '2026-10-05-lummi-hq.json');
const forecast = fixture('nws-forecast', '2026-10-05-sew-lummi-hq.json');
const gridpoints = fixture('nws-gridpoints', '2026-10-05-sew-lummi-hq.json');
const stations = fixture('nws-stations', '2026-10-05-sew-lummi-hq-stations.json');
const observation = fixture('nws-observations', '2026-10-05-kbli-latest.json');
const afd = fixture('nws-afd', '2026-10-05-sew-latest.json');
const NOW = new Date('2026-10-05T09:30:00Z');

/** @type {ReturnType<typeof installFetch> | null} */
let net = null;
beforeEach(() => { loadRegistry(); });
afterEach(() => { net?.restore(); net = null; });

describe('point forecast', () => {
  test('14 periods, labeled 7-Day Forecast, normalized as published', () => {
    const periods = normalizeForecastPeriods(forecast);
    assert.equal(periods.length, 14);
    assert.equal(FORECAST_LABEL, '7-Day Forecast');
    assert.equal(periods[0]?.name, 'Tonight');
    assert.equal(periods[0]?.probabilityOfPrecipitation, 1);
    assert.equal(periods[0]?.temperature, 49);
    assert.equal(normalizeForecastPeriods({ properties: { periods: [{ name: 'x' }, ...forecast.properties.periods.slice(0, 2)] } }).length, 2, 'a malformed period is skipped, not repaired');
    assert.deepEqual(normalizeForecastPeriods(null), []);
  });

  test('/points then forecast: registry URLs, geo+json, no User-Agent, issued time as the as-of', async () => {
    net = installFetch([[urlHas('/points/'), { body: points }], [urlHas('/forecast'), { body: forecast }]]);
    const r = await loadPointForecast(lummiHq);
    assert.equal(r.periods.length, 14);
    assert.equal(r.office, 'SEW');
    assert.deepEqual(net.calls.map((c) => c.url), ['https://api.weather.gov/points/48.792,-122.6262', 'https://api.weather.gov/gridpoints/SEW/127,126/forecast']);
    for (const c of net.calls) {
      assert.equal(c.headers.Accept, 'application/geo+json');
      assert.ok(!Object.keys(c.headers).some((k) => k.toLowerCase() === 'user-agent'), 'browsers cannot set User-Agent');
    }
    assert.equal(r.status.asOf, new Date(forecast.properties.updateTime).toISOString());
    assert.equal(r.status.asOfBasis, 'issued');
    assert.equal(r.status.completeness, 'complete');
  });

  test('a point outside NWS coverage is unavailable with a reason, not an empty forecast', async () => {
    net = installFetch([[urlHas('/points/'), { status: 404, body: { title: 'Data Unavailable For Requested Point' } }]]);
    const r = await loadPointForecast([55.02, -127.33]);
    assert.equal(r.periods.length, 0);
    assert.equal(r.status.state, 'unavailable');
    assert.ok(r.status.detail);
  });

  test('parsePoint reads the grid and zone; a response without a grid is null', () => {
    assert.deepEqual(parsePoint(points), { wfo: 'SEW', x: 127, y: 126, timeZone: 'America/Los_Angeles', radarStation: 'KATX', city: 'Marietta-Alderwood', state: 'WA' });
    assert.equal(parsePoint({ properties: {} }), null);
  });
});

describe('Current Conditions come only from an observation', () => {
  test('the nearest station with a recent temperature supplies it, with its distance', () => {
    const o = normalizeObservation(observation, { now: NOW, hq: lummiHq });
    assert.ok(o);
    assert.equal(o.stationId, 'KBLI');
    assert.equal(o.temperatureC, 9);
    assert.ok(o.distanceKm !== null && o.distanceKm > 5 && o.distanceKm < 40);
    assert.equal(o.observedAt, '2026-10-05T09:20:00.000Z');
  });

  test('an observation older than three hours, or without a temperature, is not current', () => {
    assert.equal(normalizeObservation(observation, { now: new Date('2026-10-05T13:00:00Z') }), null);
    const noTemp = JSON.parse(JSON.stringify(observation));
    noTemp.properties.temperature.value = null;
    assert.equal(normalizeObservation(noTemp, { now: NOW }), null);
  });

  test('a temperature in another unit is never converted by guess', () => {
    const odd = JSON.parse(JSON.stringify(observation));
    odd.properties.temperature.unitCode = 'wmoUnit:degF';
    assert.equal(normalizeObservation(odd, { now: NOW }), null);
  });

  test('stations are tried in the published order, three at most; none current gives no observation', async () => {
    assert.deepEqual(stationIds(stations), ['KBLI', 'C3375', 'E1976', 'KORS', 'C2882']);
    const dead = JSON.parse(JSON.stringify(observation));
    dead.properties.temperature.value = null;
    net = installFetch([[urlHas('/stations?limit') , { body: stations }], [urlHas('/gridpoints/SEW/127,126/stations'), { body: stations }], [urlHas('/observations/latest'), { body: dead }]]);
    const r = await loadCurrentObservation({ wfo: 'SEW', x: 127, y: 126 }, lummiHq, { now: NOW });
    assert.equal(r.observation, null);
    assert.equal(net.calls.filter((c) => c.url.includes('/observations/latest')).length, 3);
  });

  test('the first current station wins and later stations are not requested', async () => {
    net = installFetch([[urlHas('/gridpoints/SEW/127,126/stations'), { body: stations }], [urlHas('/stations/KBLI/observations/latest'), { body: observation }]]);
    const r = await loadCurrentObservation({ wfo: 'SEW', x: 127, y: 126 }, lummiHq, { now: NOW });
    assert.equal(r.observation?.stationId, 'KBLI');
    assert.equal(r.status.asOfBasis, 'observed');
    assert.equal(net.calls.filter((c) => c.url.includes('/observations/latest')).length, 1);
  });
});

describe('gridpoint QPF and the Forecaster\'s Discussion', () => {
  test('loadQpf returns the ready state in the Nation zone with the issued time', async () => {
    net = installFetch([[urlHas('/gridpoints/SEW/127,126'), { body: gridpoints }]]);
    const r = await loadQpf({ wfo: 'SEW', x: 127, y: 126 }, 'America/Los_Angeles', { now: new Date('2026-10-05T09:00:00Z') });
    assert.equal(r.state.state, 'ready');
    if (r.state.state === 'ready') {
      assert.equal(r.state.timeZone, 'America/Los_Angeles');
      assert.equal(r.state.days[0]?.label, 'Today');
    }
    assert.equal(r.status.asOfBasis, 'issued');
  });

  test('a failed gridpoint request is the error state, not an invented series', async () => {
    net = installFetch([[urlHas('/gridpoints/'), { status: 503, body: {} }]]);
    const r = await loadQpf({ wfo: 'SEW', x: 127, y: 126 }, 'America/Los_Angeles', { now: NOW });
    assert.equal(r.state.state, 'error');
    assert.equal(r.status.state, 'unavailable');
  });

  test('the latest AFD is one request, text verbatim, issued time as the as-of', async () => {
    net = installFetch([[urlHas('/products/types/AFD/locations/SEW/latest'), { body: afd }]]);
    const r = await loadLatestAfd('SEW', { now: NOW });
    assert.equal(r.text, afd.productText);
    assert.equal(r.issuedAt, '2026-10-05T09:31:00.000Z');
    assert.equal(r.office, 'KSEW');
    assert.equal(net.calls.length, 1);
    assert.equal(net.calls[0]?.headers.Accept, 'application/ld+json');
    await assert.rejects(() => loadLatestAfd('../x'), /office code/);
  });
});

describe('British Columbia city page', () => {
  const cranbrook = fixture('eccc-citypage-realtime', '2026-10-05-bc-cranbrook.json');
  const hq = fixture('../registry/nations', 'ca-fn-602.json').hq;

  test('text exactly as published, twelve periods, last-updated as ISO', () => {
    const c = normalizeCityPage(cranbrook);
    assert.equal(c.siteId, 'bc-77');
    assert.equal(c.name, 'Cranbrook');
    assert.equal(c.lastUpdated, '2026-10-05T06:02:12.000Z');
    assert.equal(c.periods.length, 12);
    assert.deepEqual(c.periods[0], { name: 'Tonight', summary: 'Clear. Fog patches developing overnight. Low plus 5.' });
  });

  test('the nearest city page is chosen by distance and labeled with kilometers from headquarters', async () => {
    net = installFetch([[urlHas('citypageweather-realtime/items'), { body: cranbrook }]]);
    const r = await findNearestCityPage([hq.lat, hq.lon]);
    assert.ok(r.feature);
    assert.ok(r.distanceKm !== null && r.distanceKm > 0 && r.distanceKm < 60);
    const call = /** @type {string} */ (net.calls[0]?.url);
    assert.match(call, /f=json/);
    assert.match(call, /bbox=/);
    assert.match(cityForecastLabel('Cranbrook', 12.4, 'Example Nation'), /^Forecast for Cranbrook, 12 km from Example Nation headquarters\.$/);
  });

  test('a city page by identifier, and no site in range is unavailable with a reason', async () => {
    net = installFetch([[urlHas('identifier=bc-77'), { body: cranbrook }]]);
    const r = await loadCityPage('bc-77');
    assert.equal(r.status.asOfBasis, 'issued');
    assert.equal(normalizeCityPage(r.data).name, 'Cranbrook');
    net.restore();
    net = installFetch([[urlHas('citypageweather-realtime'), { body: { type: 'FeatureCollection', features: [] } }]]);
    const none = await findNearestCityPage([60, -130]);
    assert.equal(none.feature, null);
    assert.equal(none.status.state, 'unavailable');
    await assert.rejects(() => loadCityPage('x; drop'), /city page id/);
  });
});
