// @ts-check
/**
 * Footprint filter (3.7.3), jurisdictions (3.7.8), Nation relevance (3.7.8), and zone geometry
 * resolution (3.7.5).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeNwsFeature, normalizeNwsCollection } from '../../../site/static/js/alerts/nws.js';
import { footprintIndex, inFootprint, jurisdictionsOf } from '../../../site/static/js/alerts/footprint.js';
import { groupForNation, nationIdsForAlert, nationIdsForGeometry } from '../../../site/static/js/alerts/relevance.js';
import { resolveZoneGeometry, zoneApiParams, zoneGeometryFromResponse } from '../../../site/static/js/alerts/zones.js';
import { ctxOf, fixture, fixtureNation } from './helpers.mjs';

const lummi = fixtureNation('us-wa-lummi-tribe-of-the-lummi-reservation');
const siletz = fixtureNation('us-or-confederated-tribes-of-siletz-indians-of-oregon');
const aqam = fixtureNation('ca-fn-602');

test('jurisdictions: UGC prefixes, PZZ and PKZ as MARINE plus the water\'s region', () => {
  assert.deepEqual(jurisdictionsOf(['forecast:WAZ558', 'county:ORC001', 'fire:CAZ503', 'forecast:AKZ318'], {}), ['WA', 'OR', 'CA-N', 'AK-SE']);
  assert.deepEqual(jurisdictionsOf(['marine:PZZ135'], { PZZ135: 'wa' }), ['WA', 'MARINE']);
  assert.deepEqual(jurisdictionsOf(['marine:PKZ671'], {}), ['MARINE']);
  assert.deepEqual(jurisdictionsOf(['forecast:MTZ001', 'forecast:NVZ030', 'forecast:IDZ007'], {}), ['ID', 'MT-W', 'NV-N']);
});

test('footprint filter by typed key: a fire zone never passes through a public zone with the same code', () => {
  const idx = footprintIndex({ zones: ['forecast:CAZ503', 'marine:PKZ671'] }, [-180, -90, 180, 90]);
  const pub = fixture('nws-alerts-active', 'public-zone-code-shared-with-fire-zone.json');
  const a = normalizeNwsFeature(pub.body, ctxOf(pub.meta));
  assert.equal(inFootprint(a, idx), true);
  const fireOnly = footprintIndex({ zones: ['fire:CAZ503'] }, [-180, -90, 180, 90]);
  assert.equal(inFootprint(a, fireOnly), false, 'forecast:CAZ503 does not match fire:CAZ503');
  const fp = fixture('nws-alerts-active', 'footprint-active.json');
  const all = normalizeNwsCollection(fp.body, ctxOf(fp.meta)).alerts;
  const kept = all.filter((x) => inFootprint(x, idx));
  assert.ok(kept.length > 0 && kept.length < all.length);
});

test('relevance: exact typed-zone membership for zone alerts', () => {
  const nws = /** @type {NonNullable<typeof lummi.nws>} */ (lummi.nws);
  const zone = /** @type {any} */ (nws.forecastZones[0]);
  const base = normalizeNwsFeature(fixture('nws-alerts-active', 'fire-zone-red-flag-warning.json').body, { fetchedAt: '2026-10-05T06:23:00Z', now: new Date('2026-10-05T06:23:00Z') });
  const hit = { ...base, zones: [zone] };
  assert.deepEqual(nationIdsForAlert(hit, [lummi, siletz, aqam]), [lummi.id]);
  const code = zone.split(':')[1];
  const otherType = { ...base, zones: [/** @type {any} */ (`fire:${code}`)] };
  if (!nws.fireZones.includes(otherType.zones[0])) assert.deepEqual(nationIdsForAlert(otherType, [lummi]), [], 'same code, other type, no match');
  assert.deepEqual(nationIdsForAlert(base, [lummi, siletz, aqam]), []);
});

test('relevance: a polygon matches a Nation through its headquarters sample or its bounding box', () => {
  const [lat, lon] = /** @type {[number, number]} */ (lummi.samples[0]);
  const square = (/** @type {number} */ d, /** @type {number} */ x = lon, /** @type {number} */ y = lat) => /** @type {any} */ ({
    type: 'Polygon', coordinates: [[[x - d, y - d], [x + d, y - d], [x + d, y + d], [x - d, y + d], [x - d, y - d]]],
  });
  const base = normalizeNwsFeature(fixture('nws-alerts-active', 'fire-zone-red-flag-warning.json').body, { fetchedAt: '2026-10-05T06:23:00Z', now: new Date('2026-10-05T06:23:00Z') });
  assert.deepEqual(nationIdsForAlert({ ...base, geometry: square(0.05) }, [lummi, siletz, aqam]), [lummi.id]);
  assert.deepEqual(nationIdsForAlert({ ...base, geometry: square(0.05, lon + 3, lat + 3) }, [lummi]), []);
  // The bounding-box rule errs toward showing: a polygon whose hole holds the headquarters still matches
  // when its box overlaps the Nation's box (the documented over-inclusion), and never when it does not.
  const ring = (/** @type {number} */ d) => [[lon - d, lat - d], [lon + d, lat - d], [lon + d, lat + d], [lon - d, lat + d], [lon - d, lat - d]];
  const donut = /** @type {any} */ ({ type: 'Polygon', coordinates: [ring(2), ring(1.5)] });
  assert.deepEqual(nationIdsForGeometry(donut, [lummi]), [lummi.id]);
  assert.deepEqual(nationIdsForGeometry(donut, [{ ...lummi, bbox: [lon + 5, lat + 5, lon + 6, lat + 6] }]), []);
  assert.deepEqual(nationIdsForGeometry(null, [lummi]), []);
});

test('groupForNation splits for-Nation, nearby (same jurisdiction), and elsewhere', () => {
  const mk = (/** @type {string} */ id, /** @type {any} */ o) => /** @type {any} */ ({ alertId: id, nationIds: [], jurisdictions: [], zones: [], ...o });
  const g = groupForNation([mk('a', { nationIds: [lummi.id] }), mk('b', { jurisdictions: ['WA'] }), mk('c', { jurisdictions: ['OR'] })], lummi);
  assert.deepEqual([g.forNation.map((x) => x.alertId), g.nearby.map((x) => x.alertId), g.elsewhere.map((x) => x.alertId)], [['a'], ['b'], ['c']]);
});

test('zone geometry: local index first, API fallback capped, missing listed; fire and public CAZ503 differ', async () => {
  const fire = zoneGeometryFromResponse(fixture('nws-zones-api', 'fire-caz503.json').body);
  const pub = zoneGeometryFromResponse(fixture('nws-zones-api', 'forecast-caz503.json').body);
  assert.ok(fire && pub);
  assert.notDeepEqual(fire, pub);
  assert.deepEqual(zoneApiParams('marine:PZZ135'), { type: 'forecast', id: 'PZZ135' });
  assert.deepEqual(zoneApiParams('fire:CAZ503'), { type: 'fire', id: 'CAZ503' });
  /** @type {string[]} */
  const asked = [];
  const out = await resolveZoneGeometry(['forecast:CAZ503', 'fire:CAZ503', 'fire:MTZ123', 'forecast:WAZ001', 'forecast:WAZ002'], {
    zonesIndex: { 'forecast:CAZ503': /** @type {any} */ (pub) },
    fetchZone: async (k) => { asked.push(k); return k === 'fire:CAZ503' ? /** @type {any} */ (fire) : null; },
    maxFetches: 2,
  });
  assert.deepEqual(out.features.map((f) => [f.id, /** @type {any} */ (f.properties).origin]), [['forecast:CAZ503', 'local'], ['fire:CAZ503', 'api']]);
  assert.deepEqual(asked, ['fire:CAZ503', 'fire:MTZ123']);
  assert.deepEqual(out.missing, ['fire:MTZ123', 'forecast:WAZ001', 'forecast:WAZ002']);
  assert.equal(out.fetched, 2);
});
