// @ts-check
/** NWPS normalizers against dated real captures (blueprint 5.5). Owner: lane L7. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { load } from 'js-yaml';
import {
  cleanNumber, cleanTime, hydrographImageUrl, hydrographText, ianaTimeZone, normalizeNwpsGauge, normalizeNwpsGaugeList, riverFromName,
} from '../../../site/static/js/hydro/nwps.js';
import { registerSources } from '../../../site/static/js/core/sources.js';
import { FOOTPRINT_TILES, nwpsBboxUrl, nwpsDetailUrl } from '../../../scripts/snapshot/tasks/gauges.mjs';
import { LINK_TEMPLATES } from '../../../scripts/reference/60-gauges.mjs';

const FX = new URL('../../fixtures/upstream/nwps-gauges/', import.meta.url);
/** @param {string} name */
const fixture = (name) => JSON.parse(readFileSync(new URL(`2026-10-05-${name}.json`, FX), 'utf8'));
/** @param {any[]} a */
const first = (a) => a[0];
const CTX = { fetchedAt: '2026-10-05T06:25:18.736Z', now: new Date('2026-10-05T06:25:18.736Z') };

test('list: sentinels become null, categories are the NWS words, ids are prefixed', () => {
  const items = normalizeNwpsGaugeList(fixture('bbox-skagit-nooksack'), CTX);
  assert.equal(items.length, fixture('bbox-skagit-nooksack').gauges.length);
  assert.equal(items.length, 8);
  const hut = items.find((i) => i.id === 'nwps:HUTW1');
  assert.ok(hut?.observed);
  assert.equal(hut.observed.stage, 0.97);
  assert.equal(hut.observed.unit, 'ft');
  assert.equal(hut.observed.flow, null, 'secondary -999 is no flow, not a number');
  assert.equal(hut.observed.category, 'not_defined');
  assert.equal(hut.forecast, null, 'a forecast of -999 and fcst_not_current is no forecast');
  for (const i of items) {
    for (const v of [i.observed?.stage, i.observed?.flow, i.forecast?.stage]) assert.ok(v === null || v === undefined || v > -990, `${i.id} leaks a sentinel`);
    assert.ok(!JSON.stringify(i).includes('-999'));
  }
});

test('list: out_of_service is kept and not-current markers become no category', () => {
  const raw = fixture('bbox-skagit-nooksack');
  const items = normalizeNwpsGaugeList(raw, CTX);
  const rawOos = raw.gauges.filter((/** @type {any} */ g) => g.status.observed.floodCategory === 'out_of_service').length;
  assert.ok(rawOos >= 1);
  assert.equal(items.filter((i) => i.observed?.category === 'out_of_service').length, rawOos);
  assert.ok(items.every((i) => i.observed?.category !== /** @type {any} */ ('obs_not_current')));
  assert.ok(items.every((i) => i.forecast === null || i.forecast.category !== /** @type {any} */ ('fcst_not_current')));
});

test('list: a real 0 ft reading is a reading, not missing', () => {
  const json = { gauges: [{ lid: 'TESTW', status: { observed: { primary: 0, primaryUnit: 'ft', secondary: 0, secondaryUnit: 'kcfs', floodCategory: 'no_flooding', validTime: '2026-10-05T03:15:00Z' }, forecast: null } }] };
  const item = first(normalizeNwpsGaugeList(json, CTX));
  assert.equal(item.observed?.stage, 0);
  assert.equal(item.observed?.flow, 0);
  assert.equal(cleanNumber(0), 0);
  assert.equal(cleanNumber(-999), null);
  assert.equal(cleanNumber(-9999), null);
  assert.equal(cleanNumber(Number.NaN), null);
  assert.equal(cleanNumber('3'), null);
  assert.equal(cleanNumber(-1.5), -1.5, 'a real negative stage is a reading');
});

test('list: a discharge-primary gauge puts the flow in flow and the stage in stage', () => {
  const j = JSON.parse(readFileSync(new URL('2026-10-05-gauge-crnz1.json', FX), 'utf8'));
  const item = first(normalizeNwpsGaugeList({ gauges: [j] }, CTX));
  assert.equal(item.observed?.flow, 0.831);
  assert.equal(item.observed?.flowUnit, 'kcfs');
  assert.equal(item.observed?.stage, 45.1);
  assert.equal(item.observed?.unit, 'ft');
});

test('list: the empty-reading time 0001-01-01 is no time', () => {
  assert.equal(cleanTime('0001-01-01T00:00:00Z'), null);
  assert.equal(cleanTime('2026-10-05T03:15:00Z'), '2026-10-05T03:15:00Z');
  assert.equal(cleanTime(''), null);
  const j = JSON.parse(readFileSync(new URL('2026-10-05-gauge-blfi1.json', FX), 'utf8'));
  const item = first(normalizeNwpsGaugeList({ gauges: [j] }, CTX));
  assert.equal(item.observed?.validTime, null);
  assert.equal(item.observed?.category, null);
});

test('list: a malformed body throws a clear error; bad lids are skipped', () => {
  assert.throws(() => normalizeNwpsGaugeList({}, CTX), /gauges/);
  assert.deepEqual(normalizeNwpsGaugeList({ gauges: [{ lid: 'bad' }, null] }, CTX), []);
});

test('detail: thresholds are copied verbatim and null thresholds stay null', () => {
  const g = normalizeNwpsGauge(fixture('gauge-hutw1-null-thresholds'), { retrievedAt: '2026-10-05T07:00:00Z' });
  assert.deepEqual(g.stages, { unit: 'ft', basis: 'stage', action: null, minor: null, moderate: null, major: null, sourceId: 'nwps-gauges', retrievedAt: '2026-10-05' });
  assert.equal(g.usgsId, null, 'an empty usgsId is null');
  assert.equal(g.id, 'nwps:HUTW1');
  assert.equal(g.region, 'wa');
  assert.equal(g.timeZone, 'America/Los_Angeles');
  assert.equal(g.isForecastPoint, false);
  assert.equal(g.hydrographImage, null, 'no template given, so no image URL is invented');
  assert.deepEqual(g.links, {});
  assert.equal(g.selection, 'auto');
  assert.deepEqual(g.nationIds, []);
});

test('detail: MVEW1 carries the published thresholds, links, and image', () => {
  const g = normalizeNwpsGauge(fixture('gauge-mvew1'), { retrievedAt: '2026-10-05T07:00:00Z', templates: LINK_TEMPLATES });
  assert.equal(g.name, 'Skagit River near Mt Vernon');
  assert.equal(g.river, 'Skagit River');
  assert.equal(g.usgsId, '12200500');
  assert.equal(g.stages?.minor, 28);
  assert.equal(g.stages?.major, 32);
  assert.equal(g.isForecastPoint, true);
  assert.equal(g.hydrographImage, 'https://water.noaa.gov/resources/hydrographs/mvew1_hg.png');
  assert.equal(g.links.nwps, 'https://water.noaa.gov/gauges/mvew1');
  assert.equal(g.links.usgs, 'https://waterdata.usgs.gov/monitoring-location/USGS-12200500/');
  assert.equal(g.wfo, 'SEW');
  assert.equal(g.rfc, 'NWRFC');
});

test('detail: outside the footprint or without coordinates is an error, not a guess', () => {
  const j = fixture('gauge-mvew1');
  assert.throws(() => normalizeNwpsGauge({ ...j, state: { abbreviation: 'MT' } }, { retrievedAt: '2026-10-05' }), /outside the footprint/);
  assert.throws(() => normalizeNwpsGauge({ ...j, latitude: -999 }, { retrievedAt: '2026-10-05' }), /coordinates/);
  assert.throws(() => normalizeNwpsGauge({}, { retrievedAt: '2026-10-05' }), /lid/);
});

test('hydrograph URL comes from the registry template and rejects invalid lids', () => {
  const record = load(readFileSync(new URL('../../../data/sources/nwps-hydrograph-images.yaml', import.meta.url), 'utf8'));
  registerSources([/** @type {any} */ (record)]);
  assert.equal(hydrographImageUrl('MVEW1'), 'https://water.noaa.gov/resources/hydrographs/mvew1_hg.png');
  assert.equal(hydrographImageUrl('MVEW1', LINK_TEMPLATES.hydrograph), hydrographImageUrl('MVEW1'), 'the build template equals the registry urlTemplate');
  assert.throws(() => hydrographImageUrl('SKGW1/../x'), /invalid/);
  assert.throws(() => hydrographImageUrl(''), /invalid/);
});

test('hydrograph image has alt text with latest and crest values and a text table', () => {
  const g = normalizeNwpsGauge(fixture('gauge-mvew1'), { retrievedAt: '2026-10-05T07:00:00Z' });
  const status = {
    id: g.id,
    observed: { stage: 11.15, unit: 'ft', flow: 7.67, flowUnit: 'kcfs', category: /** @type {const} */ ('no_flooding'), validTime: '2026-10-05T06:15:00Z' },
    forecast: { stage: 10.87, unit: 'ft', category: /** @type {const} */ ('no_flooding'), validTime: '2026-10-05T12:00:00Z', crestStage: 12.4, crestTime: '2026-10-06T00:00:00Z' },
  };
  const t = hydrographText(g, status);
  assert.match(t.alt, /Skagit River near Mt Vernon/);
  assert.match(t.alt, /latest observed stage 11\.15 ft at 2026-10-05 06:15 UTC/);
  assert.match(t.alt, /forecast crest 12\.4 ft at 2026-10-06 00:00 UTC/);
  assert.equal(t.rows.length, 2);
  assert.deepEqual(t.rows.map((r) => r.value), ['11.15 ft', '12.4 ft']);
  const none = hydrographText(g, null);
  assert.match(none.alt, /no current observed stage/);
  assert.match(none.alt, /no forecast crest published/);
  assert.equal(none.rows[1]?.value, 'No forecast crest published');
});

test('helpers: time zones, river names, URLs, and tiles', () => {
  assert.equal(ianaTimeZone('PST8PDT', 'WA'), 'America/Los_Angeles');
  assert.equal(ianaTimeZone('MST7MDT', 'ID'), 'America/Boise');
  assert.equal(riverFromName('Hutchinson Creek near Acme'), 'Hutchinson Creek');
  assert.equal(riverFromName('Lake Chelan'), null);
  assert.equal(nwpsDetailUrl('mvew1'), 'https://api.water.noaa.gov/nwps/v1/gauges/MVEW1');
  assert.throws(() => nwpsDetailUrl('../x'), /invalid/);
  assert.match(nwpsBboxUrl(/** @type {any} */ (FOOTPRINT_TILES[0])), /^https:\/\/api\.water\.noaa\.gov\/nwps\/v1\/gauges\?bbox\.xmin=-125/);
  // The tiles cover -125..-111 by 42..49.2 with no gaps.
  const xs = new Set(FOOTPRINT_TILES.flatMap((t) => [t.xmin, t.xmax]));
  assert.deepEqual([...xs].sort((a, b) => a - b), [-125, -118, -111]);
});

