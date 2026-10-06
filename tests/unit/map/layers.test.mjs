// @ts-check
/**
 * Lane L8 unit tests for the DOM-free parts of the layers: feature building, categories, and radar helpers.
 * Alerts come from the 10/05/2026 captures through lane L3's normalizer; reference files are the committed
 * ones. Objects marked TEST INPUT exist only to exercise a function's branches and are never displayed.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { load } from 'js-yaml';
import { alertPolygons, hasOwnPolygon } from '../../../site/static/js/map/layers/alerts.js';
import { BASEMAP_DEGRADED_TEXT, BASEMAP_OFF_TEXT, basemapConfigured, basemapShouldDegrade, basemapTileUrl } from '../../../site/static/js/map/layers/basemap.js';
import { buildBcFeatures } from '../../../site/static/js/map/layers/bc.js';
import { datasetsOf } from '../../../site/static/js/map/layers/boundaries.js';
import { bandRank, centerOf } from '../../../site/static/js/map/topo.js';
import { CATEGORY_TEXT, buildGaugeFeatures, drawnCategory } from '../../../site/static/js/map/layers/gauges.js';
import { joinHq } from '../../../site/static/js/map/layers/hq.js';
import { ECCC_LAYERS, fiveMinuteBucket, iemTileUrl, parseGeometLatestTime, parseIemValidTime, wmsTileUrl } from '../../../site/static/js/map/layers/radar.js';
import { buildZoneFeatures, zoneFilesNeeded, zoneKeysOf } from '../../../site/static/js/map/layers/zones.js';
import { decodeTopo } from '../../../site/static/js/map/topo.js';
import { ROOT, realAlerts, topojson } from './helpers.mjs';

const readJson = (/** @type {string} */ rel) => JSON.parse(readFileSync(path.join(ROOT, rel), 'utf8'));
const source = (/** @type {string} */ id) => /** @type {any} */ (load(readFileSync(path.join(ROOT, 'data', 'sources', `${id}.yaml`), 'utf8')));

test('L8: only an alert with its own polygon reaches the alerts layer; zone-basis alerts do not', () => {
  const { zoneAlerts, polygonAlert } = realAlerts();
  assert.equal(hasOwnPolygon(polygonAlert), true);
  assert.equal(zoneAlerts.some(hasOwnPolygon), false);
  const fc = alertPolygons([polygonAlert, ...zoneAlerts.slice(0, 5)]);
  assert.equal(fc.features.length, 1);
  const p = /** @type {any} */ (fc.features[0]).properties;
  assert.equal(p.alertId, polygonAlert.alertId);
  assert.equal(p.band, polygonAlert.band);
  assert.ok(p.name.startsWith(polygonAlert.event));
  assert.ok(centerOf(polygonAlert.geometry));
});

test('L8: zone coverage keeps fire and public zones apart, takes the most severe band, and reports keys with no geometry', () => {
  const { zoneAlerts } = realAlerts();
  const nws = decodeTopo(readJson('site/data/geo/nws-zones.topo.json'), 'zones', topojson);
  const inFile = new Set(nws.features.map((f) => String(/** @type {any} */ (f.properties).key)));
  const some = zoneAlerts.filter((a) => zoneKeysOf(a).some((k) => inFile.has(k))).slice(0, 25);
  assert.ok(some.length > 0, 'the captures have alerts on zones inside the footprint');
  const built = buildZoneFeatures(some, { nws, eccc: null });
  assert.ok(built.collection.features.length > 0);
  for (const f of built.collection.features) {
    const p = /** @type {any} */ (f.properties);
    assert.equal(String(/** @type {any} */ (f).id), p.key);
    assert.ok(['extreme', 'severe', 'moderate', 'minor', 'unstated'].includes(p.band));
  }
  // The most severe band wins for a zone covered by two alerts.
  const key = zoneKeysOf(some[0]).find((k) => inFile.has(k));
  assert.ok(key);
  const low = { ...some[0], alertId: 'low', band: 'minor', zones: [key] };
  const high = { ...some[0], alertId: 'high', band: 'severe', zones: [key] };
  const merged = buildZoneFeatures([low, high], { nws, eccc: null });
  assert.equal(/** @type {any} */ (merged.collection.features[0]).properties.band, 'severe');
  assert.equal(/** @type {any} */ (merged.collection.features[0]).properties.alertId, 'high');
  // A fire zone and a public zone that share a code are separate features.
  const code = String(key).split(':')[1];
  const both = ['forecast', 'fire', 'county', 'marine'].map((t) => `${t}:${code}`).filter((k) => inFile.has(k));
  if (both.length > 1) {
    const two = buildZoneFeatures([{ ...some[0], alertId: 'both', zones: both }], { nws, eccc: null });
    assert.equal(two.collection.features.length, both.length);
  }
  // Keys with no geometry are reported, not dropped silently.
  const gone = buildZoneFeatures([{ ...some[0], alertId: 'gone', zones: ['forecast:ZZZ999'] }], { nws, eccc: null });
  assert.deepEqual(gone.missing, ['forecast:ZZZ999']);
  assert.equal(gone.collection.features.length, 0);
  assert.deepEqual(zoneFilesNeeded([]), { nws: false, eccc: false });
  assert.deepEqual(zoneFilesNeeded(some), { nws: true, eccc: false });
});

test('L8: ECCC regions match by the published code, including hyphen-joined codes', () => {
  const eccc = decodeTopo(readJson('site/data/geo/eccc-regions.topo.json'), 'regions', topojson);
  const joined = eccc.features.find((f) => String(/** @type {any} */ (f.properties).id).includes('-'));
  const plain = eccc.features[0];
  const one = String(/** @type {any} */ (plain).properties.id);
  // TEST INPUT: an ECCC-shaped alert on the first real region code.
  const alert = /** @type {any} */ ({ alertId: 'eccc-test-input', band: 'moderate', agency: 'eccc', event: 'Test Input', zones: [], provenance: { coverage: { geometryBasis: 'zone', geocodes: [one] } } });
  assert.deepEqual(zoneKeysOf(alert), [`eccc:${one}`]);
  const built = buildZoneFeatures([alert], { nws: null, eccc });
  assert.equal(built.collection.features.length, 1);
  if (joined) {
    const part = String(/** @type {any} */ (joined).properties.id).split('-')[0];
    const viaPart = buildZoneFeatures([{ ...alert, provenance: { coverage: { geometryBasis: 'zone', geocodes: [part] } } }], { nws: null, eccc });
    assert.equal(viaPart.collection.features.length, 1);
  }
});

test('L8: gauge features say "no current reading" without a status and never imply no flooding', () => {
  const gauges = readJson('site/data/ref/gauges.json');
  const wsc = readJson('site/data/ref/wsc-stations.json');
  const none = buildGaugeFeatures(gauges, wsc, []);
  assert.equal(none.collection.features.length, none.items.length);
  assert.ok(none.collection.features.length >= gauges.gauges.length);
  assert.ok(none.items.every((i) => i.name.endsWith(CATEGORY_TEXT['no-reading'])));
  assert.ok(none.collection.features.every((f) => /** @type {any} */ (f.properties).flood === 'no-reading'));
  const g = gauges.gauges[0];
  // TEST INPUT: a status shaped like GaugeStatus, to exercise each category.
  /** @param {any} category @param {string | null} [validTime] */
  const status = (category, validTime = '2026-10-05T10:00:00Z') => ({ id: g.id, observed: { stage: 1, unit: 'ft', flow: null, flowUnit: null, category, validTime }, forecast: null });
  const now = new Date('2026-10-05T12:00:00Z');
  assert.equal(drawnCategory(status('major'), now), 'major');
  assert.equal(drawnCategory(status('no_flooding'), now), 'none');
  assert.equal(drawnCategory(status('not_defined'), now), 'not-defined');
  assert.equal(drawnCategory(status('out_of_service'), now), 'no-reading');
  assert.equal(drawnCategory(undefined), 'no-reading');
  const joined = buildGaugeFeatures(gauges, wsc, [/** @type {any} */ (status('minor'))], now);
  const item = joined.items.find((i) => i.id === g.id);
  assert.match(String(item?.name), /minor flooding, observed \d\d\/\d\d\/2026 \d{1,2}:\d\d [AP]M [A-Z]{3,4}$/);
  const agency = new Set(joined.collection.features.map((f) => /** @type {any} */ (f.properties).agency));
  assert.deepEqual([...agency].sort(), ['NWS', 'WSC']);
});

test('L8: headquarters join the registry names and boundary availability; a point with no Nation is dropped', () => {
  const points = readJson('site/data/geo/hq-points.json');
  const index = readJson('site/data/registry/nations-index.json');
  const joined = joinHq(points, index);
  assert.ok(joined.features.length > 0);
  const byId = new Map(index.nations.map((/** @type {any} */ n) => [n.id, n]));
  for (const f of joined.features) {
    const n = /** @type {any} */ (byId.get(f.properties.nationId));
    assert.equal(f.properties.name, n.name);
    assert.equal(f.properties.hasBoundary, n.hasBoundary === true);
  }
  const orphan = joinHq({ features: [{ type: 'Feature', properties: { nationId: 'zz-none' }, geometry: { type: 'Point', coordinates: [0, 0] } }] }, index);
  assert.equal(orphan.features.length, 0);
});

test('L8: boundary datasets name each registry title once with its vintage', () => {
  const record = { boundary: { parts: [{ sourceId: 'bia-lar', vintage: '10/03/2026' }, { sourceId: 'bia-lar', vintage: '10/03/2026' }, { sourceId: 'unregistered-id', vintage: '2026-01-01' }] } };
  const rows = datasetsOf(record);
  assert.equal(rows.length, 2);
  assert.ok(rows.every((r) => r.vintage.startsWith('retrieved ')));
});

test('L8: the basemap gives up when more than half its tiles fail, or offline, and uses @2x only on dense screens', () => {
  assert.equal(basemapShouldDegrade({ failed: 0, loaded: 0, offline: false }), false);
  assert.equal(basemapShouldDegrade({ failed: 1, loaded: 0, offline: false }), false, 'a single failure is not enough');
  assert.equal(basemapShouldDegrade({ failed: 3, loaded: 2, offline: false }), true);
  assert.equal(basemapShouldDegrade({ failed: 3, loaded: 6, offline: false }), false);
  assert.equal(basemapShouldDegrade({ failed: 0, loaded: 4, offline: true }), true);
  assert.equal(BASEMAP_DEGRADED_TEXT, 'Base map tiles unavailable; outlines shown.');
  const carto = source('carto-dark-matter');
  assert.equal(carto.status, 'active-pending-terms');
  // Q10 (10/05/2026): keyless tiles are a watermark, so the basemap draws only from an active record.
  assert.equal(basemapConfigured(carto), false);
  assert.equal(basemapConfigured({ ...carto, status: 'active' }), true);
  assert.equal(basemapConfigured({ status: 'active', urlTemplate: null }), false);
  assert.equal(BASEMAP_OFF_TEXT, 'Base map not enabled; outlines shown.');
  assert.ok(carto.urlTemplate.includes('basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png'));
  assert.ok(!/a\.|b\.|c\.|d\./.test(new URL(carto.urlTemplate.replace('{z}/{x}/{y}', '0/0/0')).hostname.slice(0, 2)), 'one host, no a to d subdomains');
  // The tile URL carries the ATNI key as a query parameter; the placeholder stays until the key is issued.
  assert.ok(carto.urlTemplate.endsWith('?key=<ATNI_BASEMAP_KEY>'));
  assert.ok(basemapTileUrl(carto.urlTemplate, { highDensity: true, lowData: false }).includes('{y}@2x.png?key='));
  assert.ok(basemapTileUrl(carto.urlTemplate, { highDensity: true, lowData: true }).includes('{y}.png?key='));
  assert.ok(basemapTileUrl(carto.urlTemplate, { highDensity: false, lowData: false }).includes('{y}.png?key='));
});

test('L8: radar valid times parse from the two published shapes and fall back to null', () => {
  // TEST INPUTS in the shapes the registry records document (iem n0q_0.json meta.valid; GeoMet time dimension).
  assert.equal(parseIemValidTime({ meta: { valid: '2026-10-05T08:50:00Z' } }), '2026-10-05T08:50:00.000Z');
  assert.equal(parseIemValidTime({}), null);
  assert.equal(parseIemValidTime({ meta: { valid: 'not a time' } }), null);
  const caps = (/** @type {string} */ dim) => `<Layer><Name>RADAR_1KM_RRAI</Name><Dimension name="time" units="ISO8601">${dim}</Dimension></Layer>`;
  assert.equal(parseGeometLatestTime(caps('2026-10-05T07:48:00Z/2026-10-05T08:48:00Z/PT6M'), 'RADAR_1KM_RRAI'), '2026-10-05T08:48:00.000Z');
  assert.equal(parseGeometLatestTime(caps('2026-10-05T08:36:00Z,2026-10-05T08:42:00Z,2026-10-05T08:48:00Z'), 'RADAR_1KM_RRAI'), '2026-10-05T08:48:00.000Z');
  assert.equal(parseGeometLatestTime(caps('2026-10-05T08:48:00Z'), 'RADAR_1KM_RRAI'), '2026-10-05T08:48:00.000Z');
  assert.equal(parseGeometLatestTime(caps('2026-10-05T08:48:00Z'), 'RADAR_1KM_RSNO'), null);
  assert.equal(parseGeometLatestTime('<Capabilities/>', 'RADAR_1KM_RRAI'), null);
});

test('L8: radar tile URLs come from the registry templates; the U.S. URL carries a five-minute bucket; WMS time is optional', () => {
  assert.equal(fiveMinuteBucket(new Date('2026-10-05T08:52:59Z')), '202610050850');
  assert.equal(fiveMinuteBucket(new Date('2026-10-05T08:55:00Z')), '202610050855');
  const iem = source('iem-nexrad-n0q');
  assert.equal(iemTileUrl(iem.urlTemplate, new Date('2026-10-05T08:52:00Z')), `${iem.urlTemplate}?t=202610050850`);
  const geomet = source('eccc-geomet-radar');
  const withTime = wmsTileUrl(geomet.urlTemplate, ECCC_LAYERS.rain, '2026-10-05T08:48:00.000Z');
  assert.ok(withTime.includes('layers=RADAR_1KM_RRAI') && withTime.includes('crs=EPSG:3857') && withTime.includes('bbox={bbox-epsg-3857}') && withTime.includes('width=256') && withTime.includes('time=2026-10-05T08:48:00.000Z'));
  assert.ok(withTime.includes('service=WMS') && withTime.includes('version=1.3.0') && withTime.includes('transparent=true'));
  const noTime = wmsTileUrl(geomet.urlTemplate, ECCC_LAYERS.snow, null);
  assert.ok(noTime.includes('layers=RADAR_1KM_RSNO') && !noTime.includes('time='));
  // The two valid-time records exist, are direct, and are used by the page that shows radar.
  assert.equal(source('iem-nexrad-n0q-valid-time').access.mode, 'direct');
  assert.equal(source('eccc-geomet-radar-times').access.mode, 'direct');
});

test('L8: BC features keep posture as a word and drop records with no geometry or name', () => {
  // TEST INPUT: the BC feeds are candidate sources with no mapped geometry yet.
  const geometry = { type: 'Polygon', coordinates: [[[-123, 49], [-122, 49], [-122, 50], [-123, 49]]] };
  const built = buildBcFeatures({ features: [
    { geometry, properties: { bcId: 'a', name: 'Evacuation Order Area', posture: 'act-now', band: 'extreme', designation: 'emergency' } },
    { geometry: null, properties: { bcId: 'b', name: 'No Geometry' } },
    { geometry, properties: { name: 'No Id' } },
  ] });
  assert.equal(built.collection.features.length, 1);
  assert.equal(built.items[0]?.name, 'Evacuation Order Area, act now');
  assert.equal(built.items[0]?.kind, 'bc-hazard');
  assert.equal(bandRank('extreme'), 0);
  assert.equal(bandRank('nonsense'), 4);
});
