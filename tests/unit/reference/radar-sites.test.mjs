// @ts-check
/**
 * Lane L4 acceptance: site/data/ref/radar-sites.json (blueprint 4.4, 7.3). Every site carries coordinates and
 * a source URL, and a haversine nearest-site lookup over those coordinates picks the right RIDGE station
 * (the legacy raw-degree lookup was wrong).
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, test } from 'node:test';
import { SCHEMA_BASE, loadAjv, parseDataFile } from '../../../scripts/check/lib/data-files.mjs';
import { RADAR_RANGE_KM, haversineKm } from '../../../scripts/reference/30-zones.mjs';

const root = new URL('../../../', import.meta.url);
const radar = JSON.parse(await readFile(new URL('site/data/ref/radar-sites.json', root), 'utf8'));
/** @type {{ id: string, lat: number, lon: number }[]} */
const sites = radar.sites;

/** @param {number} lat @param {number} lon */
function nearest(lat, lon) {
  const ranked = sites.map((s) => ({ id: s.id, km: haversineKm(lat, lon, s.lat, s.lon) })).sort((a, b) => a.km - b.km);
  return /** @type {{ id: string, km: number }} */ (ranked[0]);
}

describe('radar-sites.json', () => {
  test('validates against its schema', async () => {
    const ajv = await loadAjv();
    const v = ajv.getSchema(`${SCHEMA_BASE}radar-sites.schema.json`);
    assert.ok(v);
    assert.equal(v(radar), true, JSON.stringify(v.errors));
  });

  test('every site carries finite coordinates and an https source URL', () => {
    assert.ok(sites.length >= 15);
    assert.equal(new Set(sites.map((s) => s.id)).size, sites.length);
    for (const s of /** @type {any[]} */ (sites)) {
      assert.ok(Number.isFinite(s.lat) && Number.isFinite(s.lon), s.id);
      assert.ok(s.lat > 30 && s.lat < 65 && s.lon > -150 && s.lon < -100, `${s.id} outside the northwest window`);
      assert.match(s.sourceUrl, /^https:\/\/api\.weather\.gov\/radar\/stations\/[A-Z0-9]{3,5}$/);
      assert.ok(s.sourceUrl.endsWith(`/${s.id}`));
      assert.equal(s.agency, 'NWS');
      assert.equal(s.ridge, true);
    }
    assert.deepEqual(sites.map((s) => s.id), sites.map((s) => s.id).sort());
  });

  test('coordinates match the pinned NWS station list', async () => {
    const inputs = /** @type {{ inputs: { id: string, file: string }[] }} */ (await parseDataFile('data/pipeline/inputs.yaml')).inputs;
    const file = inputs.find((i) => i.id === 'nws-radar-stations')?.file;
    assert.ok(file);
    let list;
    try { list = JSON.parse(await readFile(new URL(`.cache/inputs/${file}`, root), 'utf8')); } catch { return; /* inputs cache absent: schema and lookup tests still run */ }
    for (const s of sites) {
      const hit = list.stations.find((/** @type {any} */ x) => x.id === s.id);
      assert.ok(hit, s.id);
      assert.ok(Math.abs(hit.lat - s.lat) < 1e-5 && Math.abs(hit.lon - s.lon) < 1e-5, s.id);
    }
  });

  test('covers the footprint: western Montana, the north California coast, and Southeast Alaska sites are present', () => {
    const ids = sites.map((s) => s.id);
    for (const id of ['KATX', 'KLGX', 'KRTX', 'KOTX', 'KCBX', 'KMSX', 'KBHX', 'KMAX', 'KLRX', 'PACG']) assert.ok(ids.includes(id), id);
  });

  test('haversine nearest site picks the right station for known places', () => {
    assert.equal(nearest(46.8721, -113.994).id, 'KMSX'); // Missoula
    assert.equal(nearest(40.8021, -124.1637).id, 'KBHX'); // Eureka
    assert.equal(nearest(57.0531, -135.33).id, 'PACG'); // Sitka
    assert.equal(nearest(43.615, -116.2023).id, 'KCBX'); // Boise
    assert.equal(nearest(47.6062, -122.3321).id, 'KATX'); // Seattle
  });

  test('haversineKm matches known distances', () => {
    assert.ok(Math.abs(haversineKm(0, 0, 0, 1) - 111.195) < 0.05);
    assert.equal(haversineKm(47, -122, 47, -122), 0);
    assert.ok(RADAR_RANGE_KM > 200);
  });

  test('the stamp comes from the pinned input vintage', async () => {
    const inputs = /** @type {{ inputs: { id: string, vintage: string }[] }} */ (await parseDataFile('data/pipeline/inputs.yaml')).inputs;
    assert.equal(radar.generatedAt, `${inputs.find((i) => i.id === 'nws-radar-stations')?.vintage}T00:00:00Z`);
  });
});
