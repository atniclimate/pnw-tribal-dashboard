// @ts-check
/**
 * Lane L5 wave 2: Nation boundaries (40-boundaries) and joins (70-joins) (blueprint 4.2, 5.2, 6.2, 12.3).
 * Pure-function tests run everywhere; corpus tests read the committed files in site/data and data/registry;
 * the rebuild test runs only with CTHD_REPRO=1 (it re-runs 40-boundaries and 70-joins from the pinned inputs).
 * Owner: lane L5.
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { ROOT } from '../../../scripts/check/lib/pages.mjs';
import { loadAjv } from '../../../scripts/check/lib/data-files.mjs';
import { feature as topoFeature } from 'topojson-client';
import { LIMITS, MAX_INTERIOR_SAMPLES, bboxOf, buildBoundaries, fillCollapsed, selectAreas } from '../../../scripts/reference/40-boundaries.mjs';
import { CANDIDATE_KM, SHARED_AREAS, areaCandidateTier, exactCensusRows, exactLarIds, isSharedCensusName, placeTokens, pointInGeometry, sharedLarAreas } from '../../../scripts/reference/50-registry.mjs';
import { POLICY, computeJoins, cwaByForecastZone, gaugeCandidates, gridInside, nearMarineZones, nearbyGauges, nearestCityPage, nearestRadar, overlappingZones, project, readGaugeOverrides, zonesFromTopo } from '../../../scripts/reference/70-joins.mjs';
import { boundaryGates } from '../../../scripts/reference/90-validate.mjs';

const SCHEMA = 'https://atniclimate.github.io/pnw-tribal-dashboard/schemas/';
/** @param {string} rel */
const readJson = (rel) => JSON.parse(readFileSync(path.join(ROOT, rel), 'utf8'));
const geoDir = path.join(ROOT, 'site', 'data', 'geo');
const detailDir = path.join(geoDir, 'boundaries');
const delivered = existsSync(path.join(geoDir, 'boundaries-overview.topo.json')) && existsSync(path.join(ROOT, 'data', 'registry', 'boundaries-build.json')) && existsSync(path.join(ROOT, 'data', 'registry', 'joins-build.json'));
const SKIP = delivered ? false : 'lane:L5 wave 2 boundaries not built yet';

/** @type {Record<string, any>[]} */
const records = readdirSync(path.join(ROOT, 'site', 'data', 'registry', 'nations')).filter((n) => n.endsWith('.json')).sort().map((n) => readJson(`site/data/registry/nations/${n}`));
/** @type {Map<string, any>} */
const detail = new Map();
if (delivered) for (const n of readdirSync(detailDir).filter((x) => x.endsWith('.json'))) detail.set(n.replace(/\.json$/, ''), JSON.parse(readFileSync(path.join(detailDir, n), 'utf8')));

const square = (/** @type {number} */ w, /** @type {number} */ s, /** @type {number} */ e, /** @type {number} */ n) => ({ type: 'Polygon', coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]] });

// ---------------------------------------------------------------------------------------------
// Place-phrase candidates (review M1) and shared areas (review N3)
// ---------------------------------------------------------------------------------------------

test('L5: place tokens drop generic words, accents, and apostrophes', () => {
  assert.deepEqual(placeTokens("Rocky Boy's Reservation"), ['rocky', 'boys']);
  assert.deepEqual(placeTokens('Confederated Tribes and Bands of the Yakama Nation'), ['yakama']);
  assert.deepEqual(placeTokens('Hoopa Valley Tribe, California'), ['hoopa', 'valley']);
  assert.deepEqual(placeTokens('Coquille of Oregon'), ['coquille']);
});

test('L5: tier one needs the whole place phrase, tier two only its first word of two or more', () => {
  const listing = placeTokens('Hoopa Valley Tribe, California');
  assert.equal(areaCandidateTier(listing, 'Hoopa Valley'), 1);
  assert.equal(areaCandidateTier(listing, 'Hoopa Extension'), 2);
  assert.equal(areaCandidateTier(listing, 'Center Valley'), 0, 'a later word alone is not a candidate');
  assert.equal(areaCandidateTier(listing, 'Hoopa'), 1);
  assert.equal(areaCandidateTier(placeTokens('Manchester Band of Pomo Indians of the Manchester Rancheria'), 'Manchester-Point Arena'), 2);
  assert.equal(areaCandidateTier(listing, 'Indian Reservation'), 0, 'a name of generic words only never matches');
  assert.equal(areaCandidateTier(placeTokens('Pit River Tribe, California (includes XL Ranch, Big Bend, Likely)'), 'XL Ranch'), 1);
  assert.ok(CANDIDATE_KM.tier2 < CANDIDATE_KM.tier1);
});

test('L5: the Columbia River shared areas are never assigned to a Nation', { skip: SKIP }, () => {
  assert.deepEqual(Object.keys(SHARED_AREAS.lar).sort(), ['LAR0055', 'LAR0089']);
  const us = readJson('data/registry/crosswalk-us.json').rows;
  for (const r of us) {
    assert.ok(!(r.sourceId === 'bia-lar' && (r.sourceKey === 'LAR0055' || r.sourceKey === 'LAR0089')), `${r.nationId} holds a shared LAR`);
    assert.notEqual(r.sourceKey, '0560T', `${r.nationId} holds the Celilo trust land`);
  }
  for (const [id, d] of detail) for (const f of d.features) assert.ok(!['LAR0055', 'LAR0089', '0560T'].includes(f.properties.sourceFeatureId), `${id} draws a shared area`);
  const report = readJson('data/registry/boundaries-build.json').report;
  assert.ok(report.shared.censusNames.includes('celilo'));
});

test('L5: every name-reviewed land-area candidate is unreviewed, corroborated, and claimed once', { skip: SKIP }, () => {
  const rows = readJson('data/registry/crosswalk-us.json').rows.filter((/** @type {any} */ r) => r.matchMethod === 'name-reviewed');
  assert.ok(rows.length >= 20, `expected the M1 candidates, got ${rows.length}`);
  /** @type {Set<string>} */
  const lar = new Set();
  for (const r of rows) {
    assert.equal(r.reviewed, false);
    assert.match(r.notes, /Candidate for the maintainer to confirm/);
    assert.ok(['bia-lar', 'census-aiannh-2025'].includes(r.sourceId));
    if (r.sourceId === 'bia-lar') { assert.ok(!lar.has(r.sourceKey), `${r.sourceKey} claimed twice`); lar.add(r.sourceKey); }
  }
  // The recall gap of the Wave 1 review: Yakama, Umatilla, Fort Hall, Flathead, Hoopa Valley, Duck Valley, Annette Island, Port Madison, Rocky Boy's, Smith River.
  const byId = new Map(records.map((r) => [r.id, r]));
  for (const [id, lid] of [['us-wa-confederated-tribes-and-bands-of-the-yakama-nation', 'LAR0094'], ['us-or-confederated-tribes-of-the-umatilla-indian-reservation', 'LAR0091'],
    ['us-id-shoshone-bannock-tribes-of-the-fort-hall-reservation', 'LAR0061'], ['us-mt-confederated-salish-and-kootenai-tribes-of-the-flathead-reservation', 'LAR0060'],
    ['us-ca-hoopa-valley-tribe-california', 'LAR0134'], ['us-nv-shoshone-paiute-tribes-of-the-duck-valley-reservation-nevada', 'LAR0248'],
    ['us-ak-metlakatla-indian-community-annette-island-reserve', 'LAR0053'], ['us-wa-suquamish-indian-tribe-of-the-port-madison-reservation', 'LAR0077'],
    ['us-mt-chippewa-cree-indians-of-the-rocky-boys-reservation-montana', 'LAR0207'], ['us-ca-tolowa-dee-ni-nation', 'LAR0183']]) {
    assert.ok(byId.get(id)?.codes.biaLarIds.includes(lid), `${id} should carry ${lid}`);
  }
});

// ---------------------------------------------------------------------------------------------
// Area selection and geometry helpers (pure)
// ---------------------------------------------------------------------------------------------

test('L5: LAR comes first and Census is used only where LAR has no polygon; British Columbia uses NRCan', () => {
  const recs = [{ id: 'us-wa-a', country: 'US' }, { id: 'us-wa-b', country: 'US' }, { id: 'ca-fn-1', country: 'CA' }, { id: 'us-wa-c', country: 'US' }];
  const us = { rows: [
    { nationId: 'us-wa-a', sourceId: 'bia-lar', sourceKey: 'LAR0001', matchMethod: 'name-exact' },
    { nationId: 'us-wa-a', sourceId: 'census-aiannh-2025', sourceKey: '0001R', matchMethod: 'name-exact' },
    { nationId: 'us-wa-b', sourceId: 'census-aiannh-2025', sourceKey: '0002R', matchMethod: 'name-exact' },
    { nationId: 'us-wa-b', sourceId: 'census-aiannh-2025', sourceKey: '0002T', matchMethod: 'name-reviewed' },
    { nationId: 'us-wa-c', sourceId: 'bia-tld', sourceKey: 'OBJECTID 9', matchMethod: 'code' },
  ] };
  const bc = { rows: [{ nationId: 'ca-fn-1', sourceId: 'nrcan-aboriginal-lands-bc', sourceKey: 'ALCODE 00181', matchMethod: 'code' }, { nationId: 'ca-fn-1', sourceId: 'isc-first-nations', sourceKey: 'BAND_NUMBER 1', matchMethod: 'code' }] };
  const out = selectAreas(recs, us, bc);
  assert.deepEqual(out.map((x) => `${x.nationId} ${x.source} ${x.key}`), [
    'ca-fn-1 nrcan-aboriginal-lands-bc 00181', 'us-wa-a bia-lar LAR0001', 'us-wa-b census-aiannh-2025 0002R', 'us-wa-b census-aiannh-2025 0002T']);
});

test('L5: bounding box of features spans every position, rounded to five decimals', () => {
  assert.deepEqual(bboxOf([{ geometry: square(-122.5, 48, -122, 48.5) }, { geometry: { type: 'MultiPolygon', coordinates: [square(-121, 47, -120.99999, 47.00001).coordinates] } }]), [-122.5, 47, -120.99999, 48.5]);
});

test('L5: a land-area grid stays inside the polygon and carries the area it stands for', () => {
  const g = square(-122, 48, -121.9, 48.1);
  const pts = gridInside(g);
  assert.ok(pts.length >= 100);
  for (const p of pts) assert.ok(pointInGeometry(p.lon, p.lat, g));
  const km2 = pts.reduce((n, p) => n + p.w, 0);
  const trueKm2 = 0.1 * 110.57 * 0.1 * 111.32 * Math.cos((48.05 * Math.PI) / 180);
  assert.ok(Math.abs(km2 - trueKm2) / trueKm2 < 0.15, `${km2} against ${trueKm2}`);
  // A hole is honored.
  const donut = { type: 'Polygon', coordinates: [square(-122, 48, -121.9, 48.1).coordinates[0], [[-121.96, 48.04], [-121.96, 48.06], [-121.94, 48.06], [-121.94, 48.04], [-121.96, 48.04]]] };
  for (const p of gridInside(donut)) assert.ok(pointInGeometry(p.lon, p.lat, donut));
});

test('L5: a zone is listed for the headquarters zone, an anchor, or at least two percent of the land; a shoreline headquarters snaps within five kilometres', () => {
  /** @type {any[]} */
  const zones = [
    { id: 'county:A', bbox: [-122, 48, -121.95, 48.1], geometry: square(-122, 48, -121.95, 48.1) },
    { id: 'county:B', bbox: [-121.95, 48, -121.9, 48.1], geometry: square(-121.95, 48, -121.9, 48.1) },
    { id: 'county:C', bbox: [-121.9, 48, -121.8, 48.1], geometry: square(-121.9, 48, -121.8, 48.1) },
  ];
  const land = gridInside(square(-121.99, 48.02, -121.92, 48.08));
  const hq = { lat: 48.05, lon: -121.97 };
  assert.deepEqual(overlappingZones(zones, [hq], land), ['county:A', 'county:B']);
  const inA = gridInside(square(-121.99, 48.02, -121.96, 48.08));
  assert.deepEqual(overlappingZones(zones, [hq], inA), ['county:A'], 'land wholly inside one zone lists only that zone');
  assert.deepEqual(overlappingZones(zones, [{ lat: 48.05, lon: -121.92 }], inA), ['county:B', 'county:A'], 'the headquarters zone comes first, then the land zone');
  const shore = { lat: 48.05, lon: -121.8 + 0.01 };
  const near = overlappingZones([{ id: 'forecast:X', bbox: [-122, 48, -121.82, 48.1], geometry: square(-122, 48, -121.82, 48.1) }], [shore], []);
  assert.deepEqual(near, ['forecast:X'], 'the nearest zone within five kilometres is the headquarters zone');
  assert.deepEqual(overlappingZones([{ id: 'forecast:Y', bbox: [-122, 48, -121.99, 48.1], geometry: square(-122, 48, -121.99, 48.1) }], [{ lat: 48.05, lon: -121.5 }], []), [], 'farther than five kilometres is no zone');
  assert.equal(POLICY.zoneLandShare, 0.02);
});

test('L5: marine zones are those within ten kilometres, nearest first', () => {
  /** @type {any[]} */
  const zones = [
    { id: 'marine:A', bbox: [-125, 48, -124.9, 48.5], geometry: square(-125, 48, -124.9, 48.5) },
    { id: 'marine:B', bbox: [-125, 48, -124.5, 48.5], geometry: square(-125, 48, -124.5, 48.5) },
    { id: 'marine:C', bbox: [-126, 48, -125.5, 48.5], geometry: square(-126, 48, -125.5, 48.5) },
  ];
  assert.deepEqual(nearMarineZones(zones, [{ lat: 48.2, lon: -124.85 }]), ['marine:B', 'marine:A']);
});

test('L5: radar is the nearest site within range, else none; gauges are nearest first and capped', () => {
  const sites = [{ id: 'KATX', lat: 48.19, lon: -122.49, ridge: true }, { id: 'PACG', lat: 56.85, lon: -135.53, ridge: true }, { id: 'KXXX', lat: 40, lon: -100, ridge: false }];
  assert.deepEqual(nearestRadar(sites, { lat: 47.6, lon: -122.3 }), { nexrad: 'KATX', ridgeLoop: 'KATX', eccc: null });
  assert.deepEqual(nearestRadar(sites, { lat: 40.1, lon: -100.1 }), { nexrad: 'KXXX', ridgeLoop: null, eccc: null });
  assert.deepEqual(nearestRadar(sites, { lat: 58, lon: -125 }), { nexrad: null, ridgeLoop: null, eccc: null }, 'beyond 460 km is no radar, not a far one');
  const gauges = Array.from({ length: 12 }, (_, i) => ({ id: `nwps:G${i}`, lat: 47 + i * 0.01, lon: -122 }));
  const near = nearbyGauges(gauges, [{ lat: 47, lon: -122 }]);
  assert.equal(POLICY.maxGauges, 6, 'blueprint 6.2: top six');
  assert.equal(near.length, POLICY.maxGauges);
  assert.equal(near[0], 'nwps:G0');
  assert.deepEqual(nearbyGauges([{ id: 'wsc:1', lat: 50, lon: -122 }], [{ lat: 47, lon: -122 }]), []);
  assert.deepEqual(nearestCityPage([{ id: 'bc-1', name: 'A', lat: 49, lon: -123 }, { id: 'bc-2', name: 'B', lat: 49.5, lon: -123 }], { lat: 49.4, lon: -123 }), { citypageId: 'bc-2', citypageName: 'B', distanceKm: 11.1 });
});

test('L5: gauges rank the Nation\'s own country first, then forecast points, then distance; overrides add and remove (review R4)', () => {
  const at = { lat: 49, lon: -122.3 };
  const gauges = [
    { id: 'wsc:NEAR', lat: 49.001, lon: -122.3, country: 'CA', isForecastPoint: false },
    { id: 'nwps:FAR', lat: 49.15, lon: -122.3, country: 'US', isForecastPoint: true },
    { id: 'nwps:MID', lat: 49.05, lon: -122.3, country: 'US', isForecastPoint: false },
    ...Array.from({ length: 6 }, (_, i) => ({ id: `nwps:N${i}`, lat: 49.01 + i * 0.001, lon: -122.3, country: 'US', isForecastPoint: false })),
  ];
  const us = nearbyGauges(gauges, [at], { country: 'US', nationId: 'us-wa-a' });
  assert.equal(us[0], 'nwps:FAR', 'a forecast point comes first even when farther');
  assert.equal(us.length, 6);
  assert.ok(!us.includes('wsc:NEAR'), 'the other country ranks after every own-country gauge, so the cap cuts it');
  const ca = nearbyGauges(gauges, [at], { country: 'CA', nationId: 'ca-fn-1' });
  assert.equal(ca[0], 'wsc:NEAR');
  const overrides = [
    { gaugeId: 'nwps:EXTRA', action: 'add', nationIds: ['us-wa-a'] },
    { gaugeId: 'nwps:FAR', action: 'remove', nationIds: ['us-wa-a'] },
    { gaugeId: 'nwps:OTHER', action: 'add', nationIds: ['us-wa-b'] },
    { gaugeId: 'nwps:MVEW1', action: 'replace' },
  ];
  const withOv = nearbyGauges(gauges, [at], { country: 'US', nationId: 'us-wa-a', overrides });
  assert.ok(withOv.includes('nwps:EXTRA') && !withOv.includes('nwps:FAR') && !withOv.includes('nwps:OTHER'));
  // The committed overrides carry no Nation entries today, so they are a tested no-op.
  assert.deepEqual(nearbyGauges(gauges, [at], { country: 'US', nationId: 'us-wa-a', overrides: overrides.slice(3) }), us);
});

test('L5: shared land areas are derived from the LAR classification and blocked at every stage (review R2)', () => {
  const lar = [
    { LARID: 'LAR0001', LARNAME: 'Yakama', CLASSIFICATION: '1' },
    { LARID: 'LAR0055', LARNAME: 'Celilo', CLASSIFICATION: '3' },
    { LARID: 'LAR0089', LARNAME: 'The Dalles Unit', CLASSIFICATION: '3' },
    { LARID: 'LAR0999', LARNAME: 'New Shared Area', CLASSIFICATION: '3' },
  ];
  const shared = sharedLarAreas(lar);
  assert.deepEqual([...shared.keys()].sort(), ['LAR0055', 'LAR0089', 'LAR0999'], 'a new classified area joins the named list');
  // A synthetic Tribe whose Directory alias is "Celilo": the exact-name stage assigns nothing.
  const larBy = new Map(lar.map((l) => [l.LARNAME.toLowerCase(), l]));
  const owners = new Map([['celilo', new Set(['us-or-synthetic'])], ['yakama', new Set(['us-wa-yakama'])]]);
  assert.deepEqual(exactLarIds(['celilo'], larBy, owners, shared), []);
  assert.deepEqual(exactLarIds(['yakama'], larBy, owners, shared), ['LAR0001']);
  assert.deepEqual(exactCensusRows(['celilo'], new Map([['celilo', [{ geoid: '0560T', name: 'Celilo' }]]])), []);
  assert.equal(isSharedCensusName('Celilo'), true);
  // Even a crosswalk row that names a shared area draws no part, and the skip is reported.
  /** @type {{ nationId: string, source: string, key: string }[]} */
  const skipped = [];
  const out = selectAreas([{ id: 'us-or-synthetic', country: 'US' }], { rows: [
    { nationId: 'us-or-synthetic', sourceId: 'bia-lar', sourceKey: 'LAR0055', matchMethod: 'name-exact' },
    { nationId: 'us-or-synthetic', sourceId: 'census-aiannh-2025', sourceKey: '0560T', matchMethod: 'name-exact' },
  ] }, { rows: [] }, { lar: new Set(shared.keys()), census: new Set(['0560T']) }, skipped);
  assert.deepEqual(out, []);
  assert.deepEqual(skipped.map((s) => s.key), ['LAR0055', '0560T']);
});

test('L5: every land-area part anchors its own zone, with the five kilometre fallback per part (review R3)', () => {
  /** @type {any[]} */
  const zones = [
    { id: 'Z1', bbox: [-123, 49, -122.5, 49.5], geometry: square(-123, 49, -122.5, 49.5) },
    { id: 'Z2', bbox: [-124, 49, -123.5, 49.5], geometry: square(-124, 49, -123.5, 49.5) },
    { id: 'Z3', bbox: [-125, 49, -124.6, 49.5], geometry: square(-125, 49, -124.6, 49.5) },
  ];
  const hq = { lat: 49.2, lon: -122.7 };
  const land = gridInside(square(-122.9, 49.1, -122.6, 49.4));
  assert.deepEqual(overlappingZones(zones, [hq], land), ['Z1'], 'without part points the outlying reserves bring no zone');
  // A tiny reserve inside Z2, and an islet 2 km off Z3 (outside every zone).
  const parts = [{ lat: 49.2, lon: -123.7 }, { lat: 49.2, lon: -124.6 + 2 / (111.32 * Math.cos((49.2 * Math.PI) / 180)) }];
  assert.deepEqual(overlappingZones(zones, [hq], land, parts), ['Z1', 'Z2', 'Z3']);
  assert.deepEqual(overlappingZones(zones, [hq], land, [{ lat: 49.2, lon: -124.3 }]), ['Z1'], 'a part farther than five kilometres from every zone adds none');
});

test('L5: an overview feature collapsed to null geometry is restored from its detail geometry (review R1)', () => {
  const props = (/** @type {string} */ id) => ({ nationId: 'ca-fn-1', source: 'nrcan-aboriginal-lands-bc', sourceFeatureId: id, vintage: '2026-09-14', kind: 'indian-reserve', sourceName: id });
  const topo = {
    type: 'Topology', transform: { scale: [0.001, 0.001], translate: [-123, 49] },
    arcs: [[[0, 0], [100, 0], [0, 100], [-100, 0], [0, -100]]],
    objects: { boundaries: { type: 'GeometryCollection', geometries: [{ arcs: [[0]], type: 'Polygon', properties: props('A') }, { type: null, properties: props('B') }, { type: null, properties: props('C') }] } },
  };
  const detail = [
    { properties: props('A'), geometry: square(-123, 49, -122.9, 49.1) },
    { properties: props('B'), geometry: square(-122.5, 49.5, -122.49, 49.51) },
    { properties: props('C'), geometry: { type: 'Polygon', coordinates: [[[-122.0, 49.0], [-122.00001, 49.00001], [-122.00002, 49.0], [-122.0, 49.0]]] } },
  ];
  const restored = fillCollapsed(topo, detail);
  assert.deepEqual(restored.map((r) => [r.sourceFeatureId, r.squares]), [['B', 0], ['C', 1]]);
  const fc = /** @type {any} */ (topoFeature(/** @type {any} */ (topo), /** @type {any} */ (topo.objects.boundaries)));
  for (const f of fc.features) assert.ok(f.geometry && f.geometry.type === 'Polygon', `${f.properties.sourceFeatureId} has geometry`);
  const b = fc.features[1].geometry.coordinates[0];
  assert.ok(Math.abs(b[0][0] - -122.5) < 1e-9 && Math.abs(b[2][1] - 49.51) < 1e-9, 'a ring that survives quantization keeps its shape');
  assert.equal(fc.features[2].geometry.coordinates[0].length, 5, 'a ring too small for the grid becomes one quantum square');
  assert.throws(() => fillCollapsed({ ...topo, objects: { boundaries: { geometries: [{ type: null, properties: props('Z') }] } } }, detail), /does not line up/);
});

test('L5: projection adds polygons, interior samples after the headquarters, bbox, and joins, and keeps hasBoundary in the index only', () => {
  const draft = { generatedAt: '2026-10-04T00:00:00Z', records: [
    { id: 'us-wa-a', hq: { lat: 48.5, lon: -122.5 }, boundary: { status: 'point-only', detailRef: null, parts: [] }, preferredName: null, aliases: [], jurisdictions: ['WA'], region: 'wa', kind: 'us-federally-recognized-tribe', name: 'A', timeZone: 'America/Los_Angeles', nws: null, eccc: null, radar: { nexrad: null, ridgeLoop: null, eccc: null }, gauges: [] },
    { id: 'us-wa-b', hq: { lat: 47, lon: -121 }, boundary: { status: 'point-only', detailRef: null, parts: [] }, preferredName: null, aliases: [], jurisdictions: ['WA'], region: 'wa', kind: 'us-federally-recognized-tribe', name: 'B', timeZone: 'America/Los_Angeles', nws: null, eccc: null, radar: { nexrad: null, ridgeLoop: null, eccc: null }, gauges: [] },
  ] };
  const parts = [{ sourceId: 'bia-lar', featureId: 'LAR0001', kind: 'land-area-representation', vintage: '2026-10-04' }];
  const out = project(draft, { redirects: {} }, { boundaries: { nations: { 'us-wa-a': { parts, bbox: [-122.6, 48.4, -122.4, 48.6], interiorSamples: [[48.51, -122.51]] } } }, joins: { nations: { 'us-wa-a': { nws: { wfo: ['SEW'] }, eccc: null, radar: { nexrad: 'KATX', ridgeLoop: 'KATX', eccc: null }, gauges: ['nwps:X1'] } } } });
  const a = out.records[0];
  assert.deepEqual(a?.samples, [[48.5, -122.5], [48.51, -122.51]]);
  assert.deepEqual(a?.bbox, [-122.6, 48.4, -122.4, 48.6]);
  assert.deepEqual(a?.boundary, { status: 'polygon', detailRef: 'geo/boundaries/us-wa-a.json', parts });
  assert.deepEqual(a?.gauges, ['nwps:X1']);
  assert.equal(out.records[1]?.boundary.status, 'point-only');
  assert.deepEqual(out.records[1]?.samples, [[47, -121]]);
  assert.deepEqual(out.index.nations.map((n) => n.hasBoundary), [true, false]);
  for (const f of out.hqPoints.features) assert.deepEqual(Object.keys(f.properties), ['nationId']);
});

// ---------------------------------------------------------------------------------------------
// Validator gates seeded with violations
// ---------------------------------------------------------------------------------------------

/** A minimal consistent corpus for boundaryGates. */
function corpus() {
  const feat = { type: 'Feature', properties: { nationId: 'us-wa-a', name: 'A', source: 'bia-lar', sourceFeatureId: 'LAR0001', vintage: '2026-10-04', kind: 'land-area-representation', sourceName: 'A' }, geometry: square(-122, 48, -121.9, 48.1) };
  const rec = { id: 'us-wa-a', name: 'A', country: 'US', samples: [[48.5, -122.5], [48.05, -121.95]], bbox: [-122, 48, -121.9, 48.1],
    boundary: { status: 'polygon', detailRef: 'geo/boundaries/us-wa-a.json', parts: [{ sourceId: 'bia-lar', featureId: 'LAR0001', kind: 'land-area-representation', vintage: '2026-10-04' }] },
    nws: { wfo: ['SEW'], point: [48.5, -122.5], forecastZones: ['forecast:WAZ001'], countyZones: ['county:WAC001'], fireZones: [], marineZones: [] }, eccc: null, radar: { nexrad: 'KATX', ridgeLoop: 'KATX', eccc: null }, gauges: ['nwps:X1'] };
  return {
    records: [rec], detail: new Map([['us-wa-a', { json: { type: 'FeatureCollection', features: [feat] }, bytes: 1000 }]]),
    overview: { objects: { boundaries: { geometries: [{ type: 'Polygon', arcs: [[0]], properties: { nationId: 'us-wa-a', source: 'bia-lar', sourceFeatureId: 'LAR0001', vintage: '2026-10-04', kind: 'land-area-representation', sourceName: 'A' } }] } } },
    overviewBytes: 1000, nwsKeys: new Set(['forecast:WAZ001', 'county:WAC001']), ecccIds: new Set(), radarIds: new Set(['KATX']), gaugeIds: new Set(['nwps:X1']), bcPolygons: 0,
  };
}

test('L5: boundaryGates pass a consistent corpus and fail each seeded violation', () => {
  assert.deepEqual(boundaryGates(corpus()).problems, []);
  /** @param {(c: any) => void} mutate @param {RegExp} re @param {string} [why] */
  const fails = (mutate, re, why = '') => { const c = corpus(); mutate(c); const f = boundaryGates(c); assert.ok(f.problems.some((p) => re.test(p)), `${why} ${re}: ${JSON.stringify(f.problems)}`); };
  fails((c) => { c.detail.get('us-wa-a').json.features[0].properties.vintage = ''; }, /no vintage/);
  fails((c) => { c.detail.get('us-wa-a').json.features[0].properties.source = ''; }, /no source/);
  fails((c) => { c.detail.get('us-wa-a').json.features[0].properties.sourceFeatureId = ''; }, /no sourceFeatureId/);
  fails((c) => { c.detail.get('us-wa-a').json.features[0].properties.name = 'Other'; }, /not the registry formal name/);
  fails((c) => { c.records[0].samples.push([10, 10]); }, /outside every land area/);
  fails((c) => { c.overviewBytes = LIMITS.overviewRawBytes + 1; }, /overview|boundaries-overview/);
  fails((c) => { c.detail.get('us-wa-a').bytes = LIMITS.detailTotalBytes + 1; }, /detail files total/);
  fails((c) => { c.records[0].nws = null; }, /no NWS zone join/);
  fails((c) => { c.records[0].nws.forecastZones = ['forecast:ZZZ999']; }, /not in nws-zones/);
  fails((c) => { c.records[0].gauges = ['nwps:NOPE']; }, /not in gauges/);
  fails((c) => { c.records[0].boundary.parts = []; }, /parts does not equal/);
  fails((c) => { c.overview.objects.boundaries.geometries[0].properties.vintage = ''; }, /overview feature has no vintage/);
  fails((c) => { c.records[0].bbox = [0, 0, 1, 1]; }, /bbox/);
  fails((c) => { c.records[0].bbox = [-122, 47, -121.9, 48.1]; }, /bbox/, 'south is checked as well as west and east');
  fails((c) => { c.records[0].bbox = [-122, 48, -121.9, 49]; }, /bbox/, 'north is checked as well');
  // Review R1: an overview feature that simplification or quantization collapsed to null geometry fails.
  fails((c) => { c.overview.objects.boundaries.geometries[0].type = null; delete c.overview.objects.boundaries.geometries[0].arcs; }, /null geometry/);
  // Review R2: a shared land area drawn for one Nation fails.
  fails((c) => { c.sharedKeys = new Set(['bia-lar:LAR0001']); }, /shared land area/);
  fails((c) => { c.records.push({ ...c.records[0], id: 'ca-fn-9', country: 'CA', nws: null, eccc: null, boundary: { status: 'point-only', detailRef: null, parts: [] }, samples: [[50, -123]] }); }, /no ECCC city page linkage/);
  // BC polygon gate: fewer than 95 percent of the reserve polygons drawn fails.
  const c = corpus();
  c.bcPolygons = 100;
  assert.ok(boundaryGates(c).problems.some((p) => /BC reserve polygons drawn/.test(p)));
});

// ---------------------------------------------------------------------------------------------
// The committed files
// ---------------------------------------------------------------------------------------------

test('L5: every boundary feature carries source, id, and vintage, the registry name, and passes the detail schema', { skip: SKIP }, async () => {
  const ajv = await loadAjv();
  const v = ajv.getSchema(`${SCHEMA}boundary-detail.schema.json`);
  assert.ok(v);
  const byId = new Map(records.map((r) => [r.id, r]));
  let n = 0;
  for (const [id, d] of detail) {
    assert.ok(v(d), `${id}: ${JSON.stringify(v.errors?.slice(0, 2))}`);
    for (const f of /** @type {any[]} */ (d.features)) {
      n += 1;
      /** @type {any} */
      const p = f.properties;
      assert.equal(p.nationId, id);
      assert.equal(p.name, byId.get(id)?.name, 'feature name is the registry full formal name');
      for (const k of ['source', 'sourceFeatureId', 'vintage', 'kind', 'sourceName']) assert.ok(p[k], `${id} ${k}`);
      assert.match(p.vintage, /^\d{4}-\d{2}-\d{2}$/);
    }
  }
  const overview = readJson('site/data/geo/boundaries-overview.topo.json');
  const geoms = overview.objects.boundaries.geometries;
  assert.equal(geoms.length, n, 'the overview holds every detail feature');
  for (const g of geoms) for (const k of ['nationId', 'source', 'sourceFeatureId', 'vintage', 'kind', 'sourceName']) assert.ok(g.properties[k], `overview ${k}`);
  assert.equal(overview.transform.scale.length, 2);
});

test('L5: overview is at most 600 KB raw and detail files total at most 15 MB; the headquarters layer keeps its 40 KB budget', { skip: SKIP }, () => {
  assert.ok(readFileSync(path.join(geoDir, 'boundaries-overview.topo.json')).length <= 600 * 1024);
  let total = 0;
  for (const n of readdirSync(detailDir)) total += readFileSync(path.join(detailDir, n)).length;
  assert.ok(total <= 15 * 1024 * 1024, `${total} bytes`);
  assert.ok(readFileSync(path.join(geoDir, 'hq-points.json')).length <= 40960);
  assert.equal(LIMITS.overviewRawBytes, 614400);
});

test('L5: samples fall inside land areas, the headquarters comes first, and there are at most nine', { skip: SKIP }, () => {
  let interior = 0;
  for (const r of records) {
    assert.ok(r.samples.length >= 1 && r.samples.length <= 1 + MAX_INTERIOR_SAMPLES, r.id);
    assert.deepEqual(r.samples[0], [r.hq.lat, r.hq.lon]);
    const d = detail.get(r.id);
    if (!d) { assert.equal(r.samples.length, 1, `${r.id} is point-only`); continue; }
    assert.ok(r.samples.length >= 2, `${r.id} has polygons, so it has at least one interior sample`);
    for (const [lat, lon] of r.samples.slice(1)) {
      interior += 1;
      assert.ok(d.features.some((/** @type {any} */ f) => pointInGeometry(lon, lat, f.geometry)), `${r.id}: ${lat}, ${lon} is outside every land area`);
    }
  }
  assert.ok(interior > 300);
});

test('L5: boundary parts, detailRef, bbox, and hasBoundary agree with the detail files and the index', { skip: SKIP }, () => {
  const index = readJson('site/data/registry/nations-index.json');
  const byIndex = new Map(index.nations.map((/** @type {any} */ n) => [n.id, n]));
  for (const r of records) {
    const d = detail.get(r.id);
    assert.equal(byIndex.get(r.id)?.hasBoundary, Boolean(d), `${r.id} index hasBoundary`);
    if (!d) { assert.equal(r.boundary.status, 'point-only'); assert.equal(r.boundary.detailRef, null); continue; }
    assert.equal(r.boundary.status, 'polygon');
    assert.equal(r.boundary.detailRef, `geo/boundaries/${r.id}.json`);
    assert.deepEqual(r.boundary.parts, d.features.map((/** @type {any} */ f) => ({ sourceId: f.properties.source, featureId: f.properties.sourceFeatureId, kind: f.properties.kind, vintage: f.properties.vintage })));
    assert.deepEqual(r.bbox, bboxOf(d.features), `${r.id} bbox is the bbox of all land areas`);
  }
  const hq = readJson('site/data/geo/hq-points.json');
  for (const f of hq.features) assert.equal('hasBoundary' in f.properties, false, 'hasBoundary lives in the index; absent means false everywhere');
});

test('L5: at least 95 percent of the British Columbia reserve polygons are joined and drawn, and the rest are listed', { skip: SKIP }, () => {
  const draft = readJson('data/registry/draft-registry.json');
  assert.ok(draft.bc.nrcanJoined / draft.bc.nrcanPolygons >= 0.95);
  const drawn = new Set();
  for (const d of detail.values()) for (const f of d.features) if (f.properties.source === 'nrcan-aboriginal-lands-bc') drawn.add(f.properties.sourceFeatureId);
  assert.equal(drawn.size, draft.bc.nrcanJoined);
  assert.equal(draft.bc.nrcanUnjoined.length, draft.bc.nrcanPolygons - draft.bc.nrcanJoined, 'the unjoined polygons are listed');
});

test('L5: every Nation carries a typed NWS zone list (U.S.) or an ECCC linkage (British Columbia), with keys that exist', { skip: SKIP }, () => {
  const nwsKeys = new Set(zonesFromTopo(readJson('site/data/geo/nws-zones.topo.json'), 'zones').map((z) => z.id));
  const ecccIds = new Set(zonesFromTopo(readJson('site/data/geo/eccc-regions.topo.json'), 'regions').map((z) => z.id));
  const sites = new Set(readJson('data/registry/eccc-citypage-sites.json').sites.map((/** @type {any} */ s) => s.id));
  let bcNoZone = 0;
  for (const r of records) {
    if (r.country === 'US') {
      assert.ok(r.nws, r.id);
      assert.equal(r.eccc, null);
      assert.ok(r.nws.wfo.length >= 1 && r.nws.forecastZones.length >= 1, `${r.id} has a forecast office and a forecast zone`);
      for (const k of [...r.nws.forecastZones, ...r.nws.countyZones, ...r.nws.fireZones, ...r.nws.marineZones]) assert.ok(nwsKeys.has(k), `${r.id} ${k}`);
      assert.deepEqual(r.nws.point, [Math.round(r.hq.lat * 1e4) / 1e4, Math.round(r.hq.lon * 1e4) / 1e4]);
      assert.ok(r.nws.countyZones.length >= 1, `${r.id} lies in a county zone`);
    } else {
      assert.equal(r.nws, null);
      assert.ok(r.eccc && sites.has(r.eccc.citypageId), `${r.id} city page`);
      assert.ok(r.eccc.distanceKm >= 0);
      for (const z of r.eccc.forecastZones) assert.ok(ecccIds.has(z), `${r.id} ${z}`);
      if (!r.eccc.forecastZones.length) bcNoZone += 1;
    }
  }
  assert.ok(bcNoZone <= 5, `${bcNoZone} British Columbia Nations have no forecast zone; each is reported as a warning`);
});

test('L5: spot checks of real joins (Makah, Sitka, Colville, Duck Valley, Cranbrook-area First Nation)', { skip: SKIP }, () => {
  const by = new Map(records.map((r) => [r.id, r]));
  const makah = by.get('us-wa-makah-indian-tribe-of-the-makah-indian-reservation');
  assert.deepEqual(makah?.nws.wfo, ['SEW']);
  assert.ok(makah?.nws.marineZones.length >= 1, 'a coastal Nation has marine zones');
  assert.equal(makah?.radar.nexrad, 'KLGX');
  const sitka = by.get('us-ak-sitka-tribe-of-alaska');
  assert.deepEqual(sitka?.nws.wfo, ['AJK']);
  assert.ok(sitka?.nws.forecastZones.includes('forecast:AKZ323'));
  const colville = by.get('us-wa-confederated-tribes-of-the-colville-reservation');
  assert.deepEqual(colville?.nws.wfo, ['OTX']);
  assert.ok(colville?.nws.countyZones.length >= 2, 'the reservation spans Okanogan and Ferry counties');
  const duck = by.get('us-nv-shoshone-paiute-tribes-of-the-duck-valley-reservation-nevada');
  assert.ok(duck?.nws.countyZones.some((/** @type {string} */ k) => k === 'county:NVC007' || k === 'county:IDC073'), 'Duck Valley spans Elko County, Nevada, and Owyhee County, Idaho');
  const cranbrook = by.get('ca-fn-602');
  assert.equal(cranbrook?.eccc.citypageId, 'bc-77', 'the nearest city page to the East Kootenay is Cranbrook');
  assert.equal(cranbrook?.nws, null);
});

test('L5: outlying reserves bring their zones (Squamish on the Sunshine Coast, ca-fn-676 on the north coast; review R3)', { skip: SKIP }, () => {
  const by = new Map(records.map((r) => [r.id, r]));
  assert.ok(by.get('ca-fn-555')?.eccc.forecastZones.includes('082300'), 'Squamish reserves KAIKALAHUN 25, CHEKWELP 26, and 26A lie in 082300');
  assert.ok(by.get('ca-fn-676')?.eccc.forecastZones.includes('089100'), 'GILTOYEES 13, MISGATLEE 14, and CRAB RIVER 18 lie in 089100');
  const build = readJson('data/registry/boundaries-build.json');
  for (const [id, n] of Object.entries(build.nations)) assert.equal(/** @type {any} */ (n).partPoints.length > 0, true, `${id} has part points`);
});

test('L5: no overview feature is null geometry, and the restored ones are listed (review R1)', { skip: SKIP }, () => {
  const topo = readJson('site/data/geo/boundaries-overview.topo.json');
  for (const g of topo.objects.boundaries.geometries) assert.ok(g.type, `${g.properties.nationId} ${g.properties.sourceFeatureId} has null geometry`);
  const restored = readJson('data/registry/boundaries-build.json').report.overviewRestored.map((/** @type {any} */ r) => r.sourceFeatureId).sort();
  assert.deepEqual(restored, ['07351', '07402', '07904', '10236']);
});

test('L5: every record stays draft and no crosswalk row is reviewed after the wave 2 build', { skip: SKIP }, () => {
  for (const r of records) { assert.equal(r.review.status, 'draft'); assert.equal(r.hq.reviewed, false); }
  for (const f of ['crosswalk-us', 'crosswalk-bc']) for (const row of readJson(`data/registry/${f}.json`).rows) assert.equal(row.reviewed, false);
});

test('L5: the ECCC city page capture is a dated real capture with a response hash and no forecast text', { skip: SKIP }, () => {
  const c = readJson('data/registry/eccc-citypage-sites.json');
  assert.equal(c.sourceId, 'eccc-citypage-realtime');
  assert.equal(c.capturedAt, '2026-10-05');
  assert.match(c.responseSha256, /^[0-9a-f]{64}$/);
  assert.equal(c.sites.length, 98);
  for (const s of c.sites) { assert.match(s.id, /^bc-[0-9]+$/); assert.deepEqual(Object.keys(s).sort(), ['id', 'lat', 'lon', 'name', 'region']); assert.ok(s.lat > 48 && s.lat < 61 && s.lon < -113 && s.lon > -140); }
});

test('L5: detail geometry keeps the source area within a fraction of a percent (Yakama and Colville against the pinned LAR)', { skip: SKIP }, async () => {
  const lar = path.join(ROOT, '.cache', 'inputs', 'bia_lar.geojson');
  if (!existsSync(lar)) return;
  const src = JSON.parse(readFileSync(lar, 'utf8')).features;
  /** @param {any} g */
  const area = (g) => {
    const polys = g.type === 'Polygon' ? [g.coordinates] : g.coordinates;
    let a = 0;
    for (const p of polys) p.forEach((/** @type {number[][]} */ ring, /** @type {number} */ i) => {
      /** @param {number} k */
      const xy = (k) => { const pt = /** @type {number[]} */ (ring[k]); const lat = /** @type {number} */ (pt[1]); return [/** @type {number} */ (pt[0]) * Math.cos((lat * Math.PI) / 180), lat]; };
      let s = 0;
      for (let k = 1; k < ring.length; k += 1) { const [x1, y1] = /** @type {number[]} */ (xy(k - 1)); const [x2, y2] = /** @type {number[]} */ (xy(k)); s += /** @type {number} */ (x1) * /** @type {number} */ (y2) - /** @type {number} */ (x2) * /** @type {number} */ (y1); }
      a += (i === 0 ? 1 : -1) * Math.abs(s) / 2;
    });
    return a;
  };
  for (const [id = '', lid] of [['us-wa-confederated-tribes-and-bands-of-the-yakama-nation', 'LAR0094'], ['us-wa-confederated-tribes-of-the-colville-reservation', 'LAR0057']]) {
    const s = src.find((/** @type {any} */ f) => f.properties.LARID === lid);
    const d = /** @type {any} */ (detail.get(id)).features.find((/** @type {any} */ f) => f.properties.sourceFeatureId === lid);
    const change = Math.abs(area(d.geometry) - area(s.geometry)) / area(s.geometry);
    assert.ok(change < 0.005, `${id}: area changed by ${(100 * change).toFixed(3)} percent`);
  }
});

// ---------------------------------------------------------------------------------------------
// Rebuild from the pinned inputs (CTHD_REPRO=1)
// ---------------------------------------------------------------------------------------------

test('L5: 40-boundaries and 70-joins rebuild to the committed bytes', { skip: process.env.CTHD_REPRO === '1' && delivered ? false : 'set CTHD_REPRO=1 (needs .cache/inputs)' }, async () => {
  const draft = readJson('data/registry/draft-registry.json');
  const out = await buildBoundaries({ rawDirs: [path.join(ROOT, '.cache', 'inputs')], records: draft.records, crossUs: readJson('data/registry/crosswalk-us.json'), crossBc: readJson('data/registry/crosswalk-bc.json'), footprint: readJson('site/data/geo/footprint.json') });
  assert.equal(readFileSync(path.join(geoDir, 'boundaries-overview.topo.json'), 'utf8'), out.overviewText);
  for (const [id, text] of out.files) assert.equal(readFileSync(path.join(detailDir, `${id}.json`), 'utf8'), text, id);
  assert.equal(out.files.size, detail.size);
  const cwa = await cwaByForecastZone(readFileSync(path.join(ROOT, '.cache', 'inputs', 'z_16ap26.zip')));
  assert.equal(cwa.get('forecast:WAZ330'), 'SEW');
  const j = computeJoins({
    records: draft.records, boundaries: { nations: out.nations }, detail: (id) => (out.files.has(id) ? JSON.parse(/** @type {string} */ (out.files.get(id))) : null),
    nwsZones: zonesFromTopo(readJson('site/data/geo/nws-zones.topo.json'), 'zones'), ecccZones: zonesFromTopo(readJson('site/data/geo/eccc-regions.topo.json'), 'regions'),
    cwa, citypages: readJson('data/registry/eccc-citypage-sites.json').sites, radar: readJson('site/data/ref/radar-sites.json').sites,
    gauges: gaugeCandidates(readJson('site/data/ref/gauges.json'), readJson('site/data/ref/wsc-stations.json')),
    gaugeOverrides: await readGaugeOverrides(),
  });
  assert.deepEqual(j.nations, readJson('data/registry/joins-build.json').nations);
});
