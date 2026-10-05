// @ts-check
/**
 * Lane L4 acceptance: the footprint, outline, and British Columbia region files (blueprint 6.2, 4.2).
 * Reads the committed outputs under site/data/geo; the reproducibility check at the end re-runs step 20
 * when CTHD_REPRO=1 (it needs the pinned inputs in .cache/inputs and takes about half a minute).
 */
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { readFile } from 'node:fs/promises';
import { describe, test } from 'node:test';
import { feature as featureTyped } from 'topojson-client';
import mapshaper from 'mapshaper';
import { SCHEMA_BASE, loadAjv, parseDataFile } from '../../../scripts/check/lib/data-files.mjs';

const feature = /** @type {(topology: any, object: any) => any} */ (featureTyped);
const root = new URL('../../../', import.meta.url);
/** @param {string} rel */
const readJson = async (rel) => JSON.parse(await readFile(new URL(rel, root), 'utf8'));
/** @param {string} rel */
const readRaw = (rel) => readFile(new URL(rel, root));

const budgets = await readJson('budgets.json');
const footprint = await readJson('site/data/geo/footprint.json');
const outlinesTopo = await readJson('site/data/geo/outlines.topo.json');
const bcRegions = await readJson('site/data/geo/bc-regions.json');
const def = /** @type {Record<string, any>} */ (await parseDataFile('data/pipeline/footprint.yaml'));

/**
 * Even-odd point-in-polygon over a Polygon or MultiPolygon geometry (rings: first is the outer ring).
 * @param {number} lon @param {number} lat @param {any} geom
 */
export function inGeometry(lon, lat, geom) {
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
 * Structural validity of every ring: closed, at least four positions, finite and in range, no repeated
 * consecutive position.
 * @param {any} geom
 * @returns {string[]} problems
 */
export function ringProblems(geom) {
  /** @type {string[]} */
  const out = [];
  const polys = geom.type === 'Polygon' ? [geom.coordinates] : geom.type === 'MultiPolygon' ? geom.coordinates : [];
  for (const rings of polys) {
    for (const ring of rings) {
      if (ring.length < 4) out.push('ring shorter than four positions');
      const a = ring[0];
      const b = ring[ring.length - 1];
      if (a[0] !== b[0] || a[1] !== b[1]) out.push('ring not closed');
      for (let i = 0; i < ring.length; i++) {
        const [x, y] = ring[i];
        if (!Number.isFinite(x) || !Number.isFinite(y) || Math.abs(x) > 180 || Math.abs(y) > 90) out.push('coordinate out of range');
        if (i > 0 && x === ring[i - 1][0] && y === ring[i - 1][1]) out.push('repeated position');
      }
    }
  }
  return out;
}

describe('footprint.yaml', () => {
  test('is a draft that covers WA, OR, ID, BC, and the proposed sub-regions, marked ratified false', () => {
    assert.equal(def.ratified, false);
    assert.equal(def.ratifiedOn, null);
    assert.deepEqual(def.states, ['WA', 'OR', 'ID']);
    assert.deepEqual(def.provinces, ['BC']);
    assert.deepEqual(Object.keys(def.counties).sort(), ['AK', 'CA', 'MT', 'NV']);
    // The Q2 proposals: eleven northern California counties, ten Southeast Alaska boroughs and census areas.
    assert.equal(def.counties.CA.length, 11);
    assert.equal(def.counties.AK.length, 10);
    assert.ok(def.counties.NV.includes('Elko') && def.counties.NV.includes('Humboldt'));
    assert.ok(def.counties.MT.includes('Missoula') && def.counties.MT.includes('Flathead'));
  });

  test('validates against its schema', async () => {
    const ajv = await loadAjv();
    const v = ajv.getSchema(`${SCHEMA_BASE}footprint.schema.json`);
    assert.ok(v);
    assert.equal(v(def), true, JSON.stringify(v.errors));
  });
});

describe('footprint.json', () => {
  test('has one polygon feature per jurisdiction and carries ratified false', () => {
    assert.equal(footprint.ratified, false);
    const codes = footprint.features.map((/** @type {any} */ f) => f.properties.region).sort();
    assert.deepEqual(codes, ['ak-se', 'bc', 'ca-n', 'id', 'mt-w', 'nv-n', 'or', 'wa']);
    for (const f of footprint.features) {
      assert.equal(f.properties.ratified, false);
      assert.ok(f.properties.name.length > 0);
      assert.ok(['Polygon', 'MultiPolygon'].includes(f.geometry.type));
    }
  });

  test('spot checks: Duck Valley, Fort McDermitt, Annette Island, and three British Columbia regions', async () => {
    /** @type {[string, number, number, string][]} */
    const checks = [
      ['Duck Valley (Owyhee, Nevada)', -116.1008, 41.9561, 'nv-n'],
      ['Fort McDermitt (Nevada)', -117.937, 41.9764, 'nv-n'],
      ['Annette Island interior (Alaska)', -131.5, 55.05, 'ak-se'],
      ['Vancouver', -123.1207, 49.2827, 'bc'],
      ['Kamloops', -120.3273, 50.6745, 'bc'],
      ['Prince George', -122.7497, 53.9171, 'bc'],
      ['Seattle', -122.3321, 47.6062, 'wa'],
      ['Boise', -116.2023, 43.615, 'id'],
      ['Missoula', -113.994, 46.8721, 'mt-w'],
      ['Eureka, California', -124.1637, 40.8021, 'ca-n'],
    ];
    for (const [label, lon, lat, want] of checks) {
      const hit = footprint.features.filter((/** @type {any} */ f) => inGeometry(lon, lat, f.geometry)).map((/** @type {any} */ f) => f.properties.region);
      assert.deepEqual(hit, [want], `${label}`);
    }
    // Points outside the footprint: Salt Lake City, Los Angeles, Anchorage, Calgary.
    for (const [label, lon, lat] of /** @type {[string, number, number][]} */ ([
      ['Salt Lake City', -111.891, 40.7608], ['Los Angeles', -118.2437, 34.0522], ['Anchorage', -149.9003, 61.2181], ['Calgary', -114.0719, 51.0447],
    ])) {
      assert.equal(footprint.features.some((/** @type {any} */ f) => inGeometry(lon, lat, f.geometry)), false, label);
    }
  });

  test('geometry has no invalid rings', () => {
    for (const f of footprint.features) assert.deepEqual([...new Set(ringProblems(f.geometry))], [], f.properties.region);
  });
});

describe('outlines.topo.json', () => {
  test('carries states, footprint counties, and the province, within the size target', async () => {
    assert.deepEqual(Object.keys(outlinesTopo.objects).sort(), ['counties', 'province', 'states']);
    const bytes = (await readRaw('site/data/geo/outlines.topo.json')).length;
    assert.ok(bytes <= budgets.geometry.outlines.rawMax, `outlines ${bytes} bytes`);
    const counties = feature(outlinesTopo, outlinesTopo.objects.counties);
    const want = Object.values(def.counties).flat().length;
    assert.equal(counties.features.length, want);
    const states = feature(outlinesTopo, outlinesTopo.objects.states).features.map((/** @type {any} */ f) => f.properties.id);
    for (const s of ['WA', 'OR', 'ID', 'CA', 'MT', 'NV', 'AK']) assert.ok(states.includes(s), s);
    const province = feature(outlinesTopo, outlinesTopo.objects.province);
    assert.equal(province.features.length, 1);
    assert.equal(province.features[0].properties.id, 'BC');
  });

  test('decoded geometry has no invalid rings', () => {
    for (const name of ['states', 'counties', 'province']) {
      for (const f of feature(outlinesTopo, outlinesTopo.objects[name]).features) {
        assert.deepEqual([...new Set(ringProblems(f.geometry))], [], `${name} ${f.properties.id}`);
      }
    }
  });
});

describe('bc-regions.json', () => {
  test('lists the British Columbia response regions with provenance', () => {
    assert.ok(bcRegions.features.length >= 4);
    const names = bcRegions.features.map((/** @type {any} */ f) => f.properties.name);
    for (const n of ['Vancouver Island', 'Lower Mainland', 'Southern Interior', 'Northern']) assert.ok(names.includes(n), n);
    for (const f of bcRegions.features) {
      assert.equal(f.properties.source, 'emcr-bc-boundaries');
      assert.match(f.properties.vintage, /^\d{4}-\d{2}-\d{2}$/);
      assert.deepEqual([...new Set(ringProblems(f.geometry))], [], f.properties.name);
    }
  });

  test('spot checks: three regions contain their cities', () => {
    /** @type {[string, number, number, string][]} */
    const checks = [
      ['Victoria', -123.3656, 48.4284, 'Vancouver Island'],
      ['Vancouver', -123.1207, 49.2827, 'Lower Mainland'],
      ['Kamloops', -120.3273, 50.6745, 'Southern Interior'],
      ['Prince George', -122.7497, 53.9171, 'Northern'],
    ];
    for (const [label, lon, lat, want] of checks) {
      const hit = bcRegions.features.filter((/** @type {any} */ f) => inGeometry(lon, lat, f.geometry)).map((/** @type {any} */ f) => f.properties.name);
      assert.deepEqual(hit, [want], label);
    }
  });
});

describe('geometry cleaning and determinism', () => {
  test('mapshaper -clean leaves each footprint, province, and region layer unchanged in count and area', async () => {
    /** @type {[string, string][]} */
    const targets = [['site/data/geo/footprint.json', 'footprint'], ['site/data/geo/bc-regions.json', 'bc-regions']];
    for (const [rel, label] of targets) {
      const text = await readRaw(rel);
      const out = /** @type {Record<string, any>} */ (await mapshaper.applyCommands(
        '-i in.json -each "a0=this.area" -clean -each "a1=this.area" -o format=geojson out.json', { 'in.json': text },
      ));
      const j = JSON.parse(String(out['out.json']));
      const before = JSON.parse(text.toString('utf8')).features.length;
      assert.equal(j.features.length, before, `${label} feature count`);
      for (const f of j.features) {
        const rel2 = Math.abs(f.properties.a1 - f.properties.a0) / f.properties.a0;
        assert.ok(rel2 < 1e-4, `${label} ${f.properties.region ?? f.properties.name}: area changed by ${rel2}`);
      }
    }
  });

  test('stamps come from the pinned input vintages, never the clock', async () => {
    const inputs = /** @type {{ inputs: { id: string, vintage: string }[] }} */ (await parseDataFile('data/pipeline/inputs.yaml')).inputs;
    const latest = ['census-states-500k', 'census-counties-500k', 'emcr-regions']
      .map((id) => inputs.find((i) => i.id === id)?.vintage ?? '')
      .sort()
      .at(-1);
    assert.equal(footprint.generatedAt, `${latest}T00:00:00Z`);
    assert.equal(bcRegions.generatedAt, `${latest}T00:00:00Z`);
  });

  test('files end with one newline and compress well', async () => {
    for (const rel of ['footprint.json', 'outlines.topo.json', 'bc-regions.json']) {
      const b = await readRaw(`site/data/geo/${rel}`);
      assert.equal(b.at(-1), 0x0a);
      assert.notEqual(b.at(-2), 0x0a);
      assert.ok(gzipSync(b).length < b.length / 2, rel);
    }
  });

  test('outputs are byte-identical on re-run (CTHD_REPRO=1)', { skip: process.env.CTHD_REPRO === '1' ? false : 'set CTHD_REPRO=1 to re-run step 20 (needs .cache/inputs)', timeout: 600000 }, async () => {
    const { buildFootprint, loadFootprintDef } = await import('../../../scripts/reference/20-footprint.mjs');
    const { loadInputs } = await import('../../../scripts/reference/10-fetch-inputs.mjs');
    const r = await buildFootprint({ inputs: await loadInputs(), def: await loadFootprintDef() });
    for (const [rel, value] of /** @type {[string, unknown][]} */ ([
      ['site/data/geo/footprint.json', r.footprint], ['site/data/geo/outlines.topo.json', r.outlines], ['site/data/geo/bc-regions.json', r.bcRegions],
    ])) {
      assert.equal((await readRaw(rel)).toString('utf8'), JSON.stringify(value) + '\n', rel);
    }
  });
});
