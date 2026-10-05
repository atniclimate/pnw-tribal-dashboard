// @ts-check
/**
 * Lane L4 acceptance: NWS zones, the footprint UGC index, and ECCC forecast regions (blueprint 3.7.5, 6.2).
 * Reads the committed outputs under site/data/geo; the reproducibility check re-runs steps 20 and 30 when
 * CTHD_REPRO=1 (it needs the pinned inputs in .cache/inputs and takes about two minutes).
 */
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { readFile, readdir } from 'node:fs/promises';
import { describe, test } from 'node:test';
import { feature as featureTyped } from 'topojson-client';
import mapshaper from 'mapshaper';
import { SCHEMA_BASE, loadAjv, parseDataFile } from '../../../scripts/check/lib/data-files.mjs';
import { MIN_OVERLAP_KM2, regionForMarine, typedKeyFromUrl } from '../../../scripts/reference/30-zones.mjs';

const feature = /** @type {(topology: any, object: any) => any} */ (featureTyped);
const root = new URL('../../../', import.meta.url);
/** @param {string} rel */
const readJson = async (rel) => JSON.parse(await readFile(new URL(rel, root), 'utf8'));
/** @param {string} rel */
const readRaw = (rel) => readFile(new URL(rel, root));

const budgets = await readJson('budgets.json');
const ugc = await readJson('site/data/geo/footprint-ugc.json');
const zonesTopo = await readJson('site/data/geo/nws-zones.topo.json');
const ecccTopo = await readJson('site/data/geo/eccc-regions.topo.json');
const def = /** @type {Record<string, any>} */ (await parseDataFile('data/pipeline/footprint.yaml'));
const zoneFc = feature(zonesTopo, zonesTopo.objects.zones);
/** @type {Map<string, any>} */
const zoneByKey = new Map(zoneFc.features.map((/** @type {any} */ f) => [f.id, f]));

/**
 * @param {number} lon @param {number} lat @param {any} geom
 */
function inGeometry(lon, lat, geom) {
  const polys = geom.type === 'Polygon' ? [geom.coordinates] : geom.type === 'MultiPolygon' ? geom.coordinates : [];
  return polys.some((/** @type {any} */ rings) => {
    let inside = false;
    for (const ring of rings) {
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const [xi, yi] = ring[i];
        const [xj, yj] = ring[j];
        if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
      }
    }
    return inside;
  });
}

/**
 * @param {any} geom
 * @returns {string[]}
 */
function ringProblems(geom) {
  /** @type {string[]} */
  const out = [];
  const polys = geom.type === 'Polygon' ? [geom.coordinates] : geom.type === 'MultiPolygon' ? geom.coordinates : [];
  for (const rings of polys) {
    for (const ring of rings) {
      if (ring.length < 4) out.push('ring shorter than four positions');
      const a = ring[0];
      const b = ring[ring.length - 1];
      if (a[0] !== b[0] || a[1] !== b[1]) out.push('ring not closed');
      for (const [x, y] of ring) if (!Number.isFinite(x) || !Number.isFinite(y) || Math.abs(x) > 180 || Math.abs(y) > 90) out.push('coordinate out of range');
    }
  }
  return out;
}

/** @param {string} type @param {number} lon @param {number} lat */
const zonesAt = (type, lon, lat) =>
  zoneFc.features.filter((/** @type {any} */ f) => f.id.startsWith(`${type}:`) && inGeometry(lon, lat, f.geometry)).map((/** @type {any} */ f) => f.id);

describe('footprint-ugc.json', () => {
  test('validates against its schema', async () => {
    const ajv = await loadAjv();
    const v = ajv.getSchema(`${SCHEMA_BASE}footprint-ugc.schema.json`);
    assert.ok(v);
    assert.equal(v(ugc), true, JSON.stringify(v.errors));
  });

  test('zones are sorted, unique typed keys, and every key has geometry in the zones file (and the reverse)', () => {
    assert.deepEqual([...ugc.zones], [...ugc.zones].sort());
    assert.equal(new Set(ugc.zones).size, ugc.zones.length);
    assert.deepEqual(new Set(ugc.zones), new Set(zoneByKey.keys()));
    for (const [key, f] of zoneByKey) {
      assert.ok(['Polygon', 'MultiPolygon'].includes(f.geometry.type), key);
      assert.equal(f.properties.key, key);
    }
  });

  test('contains every zone of the whole-state members, matching the NWS zone counts captured 10/05/2026', () => {
    /** @param {string} type @param {string} st */
    const count = (type, st) => ugc.zones.filter((/** @type {string} */ k) => k.startsWith(`${type}:${st}`)).length;
    // Fire weather and public zone counts per state from api.weather.gov on 10/05/2026
    // (tests/fixtures/upstream/nws-zones-api/README.md); county counts are the Census county counts.
    assert.deepEqual([count('forecast', 'WA'), count('forecast', 'OR'), count('forecast', 'ID')], [68, 56, 47]);
    assert.deepEqual([count('fire', 'WA'), count('fire', 'OR'), count('fire', 'ID')], [39, 43, 20]);
    assert.deepEqual([count('county', 'WA'), count('county', 'OR'), count('county', 'ID')], [39, 36, 44]);
  });

  test('contains the county zone of every listed county in the sub-regions, and nothing else from those states', () => {
    for (const st of ['CA', 'MT', 'NV', 'AK']) {
      assert.equal(ugc.zones.filter((/** @type {string} */ k) => k.startsWith(`county:${st}C`)).length, def.counties[st].length, st);
    }
    for (const key of ['county:CAC093', 'county:MTC063', 'county:NVC007', 'county:NVC013', 'county:AKC130', 'county:AKC282']) {
      assert.ok(zoneByKey.has(key), key);
    }
    assert.equal(zoneByKey.has('county:CAC037'), false, 'Los Angeles County is outside the footprint');
  });

  test(`partial overlaps are counted from ${MIN_OVERLAP_KM2} square kilometers: Yellowstone's Idaho corner is in, sliver mismatches are out`, () => {
    assert.ok(zoneByKey.has('forecast:WYZ001'));
    assert.equal(zoneByKey.has('forecast:UTZ101'), false);
    assert.equal(zoneByKey.has('forecast:MTZ304'), false);
  });

  test('typed keys keep fire and public zones apart: a code shared by both types has two different geometries', () => {
    const forecast = new Set(ugc.zones.filter((/** @type {string} */ k) => k.startsWith('forecast:')).map((/** @type {string} */ k) => k.slice(9)));
    const shared = ugc.zones.filter((/** @type {string} */ k) => k.startsWith('fire:') && forecast.has(k.slice(5)));
    assert.ok(shared.length > 0, 'at least one code (California, Alaska, or Montana) is shared');
    // Some shared codes describe the same area (the Southeast Alaska zones are both), but California's do not.
    const differing = shared.filter((/** @type {string} */ k) => {
      const code = k.slice(5);
      return JSON.stringify(zoneByKey.get(`forecast:${code}`).geometry) !== JSON.stringify(zoneByKey.get(k).geometry);
    });
    assert.ok(differing.length > 0, 'a shared code with two different geometries exists');
    assert.ok(differing.some((/** @type {string} */ k) => k.startsWith('fire:CA')), 'California shares codes between fire and public zones');
  });

  test('edgeCodes are the UGC codes outside the whole-state members, plus the Southeast Alaska marine zones', () => {
    for (const c of ugc.edgeCodes) assert.match(c, /^[A-Z]{2}[A-Z][0-9]{3}$/);
    assert.deepEqual([...ugc.edgeCodes], [...ugc.edgeCodes].sort());
    const codes = new Set(ugc.zones.map((/** @type {string} */ k) => k.split(':')[1]));
    for (const c of ugc.edgeCodes) assert.ok(codes.has(c), c);
    assert.equal(ugc.edgeCodes.some((/** @type {string} */ c) => /^(WA|OR|ID)/.test(c)), false);
    assert.equal(ugc.edgeCodes.some((/** @type {string} */ c) => /^PZZ/.test(c)), false, 'PZ waters arrive in request 1 (area=PZ)');
    for (const c of ['CAC093', 'MTC063', 'NVC007', 'AKZ332', 'PKZ011']) assert.ok(ugc.edgeCodes.includes(c), c);
    // Every non-whole-state land zone and every PKZ zone is an edge code (the code set drops the type prefix).
    const expected = new Set(ugc.zones.map((/** @type {string} */ k) => k.split(':')[1]).filter((/** @type {string} */ c) => /^PKZ/.test(c) || !/^(WA|OR|ID|PZZ)/.test(c)));
    assert.deepEqual(new Set(ugc.edgeCodes), expected);
  });

  test('stamp comes from the pinned input vintages, never the clock', async () => {
    const inputs = /** @type {{ inputs: { id: string, vintage: string }[] }} */ (await parseDataFile('data/pipeline/inputs.yaml')).inputs;
    const ids = ['nws-public-zones', 'nws-county-zones', 'nws-fire-zones', 'nws-coastal-marine-zones', 'nws-offshore-marine-zones', 'eccc-public-forecast-zones'];
    const latest = ids.map((id) => inputs.find((i) => i.id === id)?.vintage ?? '').sort().at(-1);
    assert.equal(ugc.generatedAt, `${latest}T00:00:00Z`);
  });
});

describe('marineToRegion', () => {
  const marineCodes = ugc.zones.filter((/** @type {string} */ k) => k.startsWith('marine:')).map((/** @type {string} */ k) => k.slice(7)).sort();

  test('covers every marine key and nothing else', () => {
    assert.ok(marineCodes.length >= 60);
    assert.deepEqual(Object.keys(ugc.marineToRegion).sort(), marineCodes);
  });

  test('maps Southeast Alaska waters to ak-se and coastal waters to the region whose coast they front', () => {
    const m = ugc.marineToRegion;
    for (const c of marineCodes.filter((/** @type {string} */ x) => x.startsWith('PKZ'))) assert.equal(m[c], 'ak-se', c);
    for (const c of ['PZZ110', 'PZZ130', 'PZZ135', 'PZZ150', 'PZZ170']) assert.equal(m[c], 'wa', c);
    for (const c of ['PZZ252', 'PZZ253', 'PZZ350', 'PZZ370']) assert.equal(m[c], 'or', c);
    for (const c of ['PZZ410', 'PZZ450', 'PZZ455', 'PZZ475']) assert.equal(m[c], 'ca-n', c);
    for (const v of Object.values(m)) assert.ok(['wa', 'or', 'ca-n', 'ak-se'].includes(/** @type {string} */ (v)));
  });

  test('regionForMarine picks the band containing the latitude, else the nearest', () => {
    const bands = { wa: /** @type {[number, number]} */ ([46.2, 49]), or: /** @type {[number, number]} */ ([42, 46.3]), 'ca-n': /** @type {[number, number]} */ ([38.7, 42]) };
    assert.equal(regionForMarine(47.5, bands), 'wa');
    assert.equal(regionForMarine(44, bands), 'or');
    assert.equal(regionForMarine(40, bands), 'ca-n');
    assert.equal(regionForMarine(37.5, bands), 'ca-n');
    assert.equal(regionForMarine(50.5, bands), 'wa');
  });
});

describe('storm fixtures resolve against the zones file', () => {
  /** @returns {Promise<string[]>} */
  async function fixtureFiles() {
    /** @type {string[]} */
    const out = [];
    for (const rel of ['tests/fixtures/upstream/nws-alerts-active/', 'tests/fixtures/alerts/']) {
      /** @type {import('node:fs').Dirent[]} */
      let ents = [];
      try { ents = await readdir(new URL(rel, root), { recursive: true, withFileTypes: true }); } catch { continue; }
      for (const e of ents) {
        if (e.isFile() && e.name.endsWith('.json') && !e.name.endsWith('.meta.json')) out.push(`${e.parentPath.replace(/\\/g, '/')}/${e.name}`);
      }
    }
    return out.sort();
  }

  test('every affected zone in the captured NWS alerts is resolved, or lies outside the footprint by state or waters', async () => {
    const files = await fixtureFiles();
    assert.ok(files.length > 5);
    let seen = 0;
    /** @type {Set<string>} */
    const unresolved = new Set();
    for (const f of files) {
      const j = JSON.parse(await readFile(f, 'utf8'));
      for (const a of j.features ?? (j.properties ? [j] : [])) {
        for (const url of a?.properties?.affectedZones ?? []) {
          const key = typedKeyFromUrl(url);
          assert.ok(key, `zone URL not typed: ${url}`);
          seen++;
          if (zoneByKey.has(key)) assert.ok(zoneByKey.get(key).geometry, key);
          else unresolved.add(key);
        }
      }
    }
    assert.ok(seen > 400, `only ${seen} zones seen`);
    // Everything in the whole-state members and every Washington, Oregon, or Idaho zone must resolve.
    for (const key of unresolved) {
      const code = key.split(':')[1] ?? '';
      assert.equal(/^(WA|OR|ID)/.test(code) && !key.startsWith('marine:'), false, `${key} is in a whole-state member but missing`);
      if (key.startsWith('marine:')) {
        // Outside the footprint: Monterey Bay and Alaska waters west of Southeast Alaska.
        assert.match(code, /^(PZZ535|PKZ[4-9][0-9]{2})$/, `${key}`);
      } else {
        assert.match(code, /^(CA|AK|MT|MD|NV|UT|WY)/, `${key}`);
      }
    }
    // No Southeast Alaska public zone (AKZ317 through AKZ332) is unresolved.
    for (const key of unresolved) {
      const m = /^forecast:AKZ(\d{3})$/.exec(key);
      if (m) assert.equal(Number(m[1]) >= 317 && Number(m[1]) <= 332, false, key);
    }
  });

  test('the Pacific Northwest alert fixtures keep their zone keys resolvable', async () => {
    const j = JSON.parse(await readFile(new URL('tests/fixtures/upstream/nws-alerts-active/2026-10-05-fire-zone-red-flag-warning.json', root), 'utf8'));
    const keys = (j.features ?? [j]).flatMap((/** @type {any} */ a) => (a.properties.affectedZones ?? []).map(typedKeyFromUrl));
    assert.ok(keys.includes('fire:MTZ123') && keys.includes('fire:MTZ124'));
    assert.equal(typedKeyFromUrl('https://api.weather.gov/zones/forecast/WAZ558'), 'forecast:WAZ558');
    assert.equal(typedKeyFromUrl('https://api.weather.gov/zones/county/WAC033'), 'county:WAC033');
    assert.equal(typedKeyFromUrl('https://api.weather.gov/zones/offshore/PZZ800'), 'marine:PZZ800');
    assert.equal(typedKeyFromUrl('https://api.weather.gov/zones/forecast/'), null);
  });
});

describe('spot checks', () => {
  test('Duck Valley and Fort McDermitt sit in the Nevada counties of the footprint', () => {
    assert.deepEqual(zonesAt('county', -116.1008, 41.9561), ['county:NVC007']);
    assert.deepEqual(zonesAt('county', -117.937, 41.9764), ['county:NVC013']);
    assert.equal(zonesAt('forecast', -116.1008, 41.9561).length, 1);
    assert.equal(zonesAt('fire', -117.937, 41.9764).length, 1);
  });

  test('Annette Island has its own public and fire zone in Southeast Alaska', () => {
    assert.deepEqual(zonesAt('forecast', -131.5, 55.05), ['forecast:AKZ332']);
    assert.deepEqual(zonesAt('county', -131.5, 55.05), ['county:AKC198']);
  });

  test('Seattle, Missoula, and the coastal waters resolve to typed zones', () => {
    assert.deepEqual(zonesAt('county', -122.3321, 47.6062), ['county:WAC033']);
    assert.deepEqual(zonesAt('county', -113.994, 46.8721), ['county:MTC063']);
    assert.deepEqual(zonesAt('marine', -124.9, 48.4), ['marine:PZZ150']);
    assert.deepEqual(zonesAt('marine', -123.4, 48.2), ['marine:PZZ131']);
  });
});

describe('sizes, geometry, and determinism', () => {
  test('nws-zones.topo.json is within the 4.2 targets', async () => {
    const b = await readRaw('site/data/geo/nws-zones.topo.json');
    assert.ok(b.length <= budgets.geometry.nwsZones.rawMax, `raw ${b.length}`);
    assert.ok(gzipSync(b).length <= budgets.geometry.nwsZones.gzipMax, 'gzip');
  });

  test('eccc-regions.topo.json is within the 4.2 target and lists British Columbia zones by CLC', async () => {
    const b = await readRaw('site/data/geo/eccc-regions.topo.json');
    assert.ok(b.length <= budgets.geometry.ecccRegions.rawMax, `raw ${b.length}`);
    assert.deepEqual(Object.keys(ecccTopo.objects), ['regions']);
    const fc = feature(ecccTopo, ecccTopo.objects.regions);
    assert.ok(fc.features.length >= 40);
    for (const f of fc.features) {
      assert.match(f.id, /^[0-9]{6}(-[0-9]{6})*$/);
      assert.ok(f.properties.name.length > 0);
      assert.deepEqual([...new Set(ringProblems(f.geometry))], [], f.id);
    }
    const at = (/** @type {number} */ lon, /** @type {number} */ lat) => fc.features.filter((/** @type {any} */ f) => inGeometry(lon, lat, f.geometry)).map((/** @type {any} */ f) => f.properties.name);
    assert.deepEqual(at(-123.3656, 48.4284), ['Greater Victoria']);
    assert.deepEqual(at(-122.7497, 53.9171), ['Prince George']);
    assert.deepEqual(at(-123.1207, 49.2827), ['Metro Vancouver']);
  });

  test('decoded zone geometry has no invalid rings', () => {
    for (const f of zoneFc.features) assert.deepEqual([...new Set(ringProblems(f.geometry))], [], f.id);
  });

  test('mapshaper -clean leaves each zone type unchanged in count and area', async () => {
    const text = await readRaw('site/data/geo/nws-zones.topo.json');
    const geo = JSON.stringify(zoneFc);
    for (const type of ['forecast', 'county', 'fire', 'marine']) {
      const out = /** @type {Record<string, any>} */ (await mapshaper.applyCommands(
        `-i in.json -filter "key.startsWith('${type}:')" -each "a0=this.area" -clean allow-overlaps -each "a1=this.area" -o format=geojson out.json`,
        { 'in.json': geo },
      ));
      const j = JSON.parse(String(out['out.json']));
      const want = ugc.zones.filter((/** @type {string} */ k) => k.startsWith(`${type}:`)).length;
      assert.equal(j.features.length, want, `${type} count`);
      for (const f of j.features) assert.ok(Math.abs(f.properties.a1 - f.properties.a0) / f.properties.a0 < 1e-3, `${type} ${f.properties.key}`);
    }
    assert.ok(text.length > 0);
  });

  test('outputs are byte-identical on re-run (CTHD_REPRO=1)', { skip: process.env.CTHD_REPRO === '1' ? false : 'set CTHD_REPRO=1 to re-run steps 20 and 30 (needs .cache/inputs)', timeout: 900000 }, async () => {
    const { buildFootprint, loadFootprintDef } = await import('../../../scripts/reference/20-footprint.mjs');
    const { buildZones, buildRadar } = await import('../../../scripts/reference/30-zones.mjs');
    const { loadInputs } = await import('../../../scripts/reference/10-fetch-inputs.mjs');
    const inputs = await loadInputs();
    const d = await loadFootprintDef();
    const { regionsText } = await buildFootprint({ inputs, def: d });
    const z = await buildZones({ inputs, def: d, regionsText });
    const radar = await buildRadar({ inputs, regionsText });
    for (const [rel, value] of /** @type {[string, unknown][]} */ ([
      ['site/data/geo/nws-zones.topo.json', z.zonesTopo], ['site/data/geo/footprint-ugc.json', z.ugc],
      ['site/data/geo/eccc-regions.topo.json', z.ecccTopo], ['site/data/ref/radar-sites.json', radar],
    ])) {
      assert.equal((await readRaw(rel)).toString('utf8'), JSON.stringify(value) + '\n', rel);
    }
  });
});
