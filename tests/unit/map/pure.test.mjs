// @ts-check
/**
 * Lane L8 unit tests for the DOM-free map modules: topo, style, support, bounds, and attribution.
 * Inputs are the committed reference files and the dated captures; nothing here is invented data.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { boundsForViewport, decodeOutlines, decodeTopo, mercator, paddedBounds, unmercator } from '../../../site/static/js/map/topo.js';
import { buildStyle } from '../../../site/static/js/map/style.js';
import { chooseMode, probeWebGL } from '../../../site/static/js/map/support.js';
import { attributionLines } from '../../../site/static/js/map/attribution.js';
import { ROOT, topojson } from './helpers.mjs';

const readJson = (/** @type {string} */ rel) => JSON.parse(readFileSync(path.join(ROOT, rel), 'utf8'));

test('L8: decodeTopo decodes a named object, copies the geometry id into properties, and rejects a missing object', () => {
  const topo = readJson('site/data/geo/outlines.topo.json');
  const states = decodeTopo(topo, 'states', topojson);
  assert.equal(states.type, 'FeatureCollection');
  assert.equal(states.features.length, topo.objects.states.geometries.length);
  for (const f of states.features) {
    assert.ok(['Polygon', 'MultiPolygon'].includes(/** @type {any} */ (f.geometry).type));
    assert.ok(/** @type {any} */ (f.properties).name);
  }
  const zones = decodeTopo(readJson('site/data/geo/nws-zones.topo.json'), 'zones', topojson);
  const first = zones.features[0];
  assert.match(String(/** @type {any} */ (first).properties.key), /^(forecast|county|fire|marine):/);
  assert.equal(/** @type {any} */ (first).properties.id, /** @type {any} */ (first).properties.key);
  assert.throws(() => decodeTopo(topo, 'nope', topojson), /missing/);
  assert.throws(() => decodeTopo(null, 'states', topojson), /missing/);
});

test('L8: decodeOutlines tags every feature with its object name', () => {
  const fc = decodeOutlines(readJson('site/data/geo/outlines.topo.json'), topojson);
  const layers = new Set(fc.features.map((f) => /** @type {any} */ (f.properties).layer));
  assert.deepEqual([...layers].sort(), ['counties', 'province', 'states']);
  assert.throws(() => decodeOutlines({}, topojson), /no objects/);
});

test('L8: buildStyle is version 8 with a token-colored background and no glyphs, no sprite, and no sources', () => {
  const style = buildStyle({ token: (name) => (name === '--ground' ? 'rgb(1, 11, 19)' : ''), lowData: false });
  assert.equal(style.version, 8);
  assert.equal('glyphs' in style, false);
  assert.equal('sprite' in style, false);
  assert.deepEqual(style.sources, {});
  assert.equal(style.layers.length, 1);
  assert.deepEqual(style.layers[0], { id: 'background', type: 'background', paint: { 'background-color': 'rgb(1, 11, 19)' } });
  assert.throws(() => buildStyle({ token: () => '', lowData: true }), /--ground/);
});

/**
 * A canvas stand-in whose webgl2 context depends on the requested attributes.
 * @param {{ hardware: boolean, software: boolean, throws?: boolean }} behavior
 */
function fakeCanvas(behavior) {
  const released = { count: 0 };
  const factory = () => /** @type {any} */ ({
    width: 0,
    height: 0,
    getContext(/** @type {string} */ kind, /** @type {any} */ attrs) {
      if (behavior.throws) throw new Error('blocked');
      if (kind !== 'webgl2') return null;
      const strict = attrs?.failIfMajorPerformanceCaveat === true;
      if (strict ? !behavior.hardware : !(behavior.hardware || behavior.software)) return null;
      return { getExtension: (/** @type {string} */ n) => (n === 'WEBGL_lose_context' ? { loseContext: () => { released.count += 1; } } : null) };
    },
  });
  return { factory, released };
}

test('L8: the WebGL2 probe yields full, caveat, and none, and releases each context at once', () => {
  const full = fakeCanvas({ hardware: true, software: true });
  assert.equal(probeWebGL(full.factory), 'full');
  assert.equal(full.released.count, 1);
  const caveat = fakeCanvas({ hardware: false, software: true });
  assert.equal(probeWebGL(caveat.factory), 'caveat');
  assert.equal(caveat.released.count, 1);
  assert.equal(probeWebGL(fakeCanvas({ hardware: false, software: false }).factory), 'none');
  assert.equal(probeWebGL(fakeCanvas({ hardware: true, software: true, throws: true }).factory), 'none');
});

test('L8: chooseMode follows the 4.6 table', () => {
  assert.equal(chooseMode('full', { lowData: false, requested: false }), 'interactive');
  assert.equal(chooseMode('full', { lowData: true, requested: false }), 'outline-offer-interactive');
  assert.equal(chooseMode('caveat', { lowData: false, requested: false }), 'outline-offer-interactive');
  assert.equal(chooseMode('caveat', { lowData: false, requested: true }), 'interactive');
  assert.equal(chooseMode('full', { lowData: true, requested: true }), 'interactive');
  assert.equal(chooseMode('none', { lowData: false, requested: false }), 'outline');
  assert.equal(chooseMode('none', { lowData: false, requested: true }), 'outline');
});

test('L8: Web Mercator round-trips and the footprint pads by ten percent', () => {
  for (const [lon, lat] of [[-122.3, 47.6], [-139, 59.9], [-111.2, 38.1]]) {
    const [x, y] = mercator(/** @type {number} */ (lon), /** @type {number} */ (lat));
    const [lon2, lat2] = unmercator(x, y);
    assert.ok(Math.abs(lon2 - /** @type {number} */ (lon)) < 1e-9);
    assert.ok(Math.abs(lat2 - /** @type {number} */ (lat)) < 1e-9);
  }
  const padded = paddedBounds([-142, 37.5, -108, 61]);
  assert.deepEqual(padded.map((n) => Number(n.toFixed(6))), [-145.4, 35.15, -104.6, 63.35]);
});

test('L8: boundsForViewport keeps the center, matches the frame shape, and never shrinks the box', () => {
  const box = /** @type {[number, number, number, number]} */ (paddedBounds([-142, 37.5, -108, 61]));
  for (const [w, h] of [[968, 544], [360, 270], [1280, 720], [300, 900]]) {
    const out = boundsForViewport(box, /** @type {number} */ (w), /** @type {number} */ (h));
    assert.ok(out[0] <= box[0] + 1e-9 && out[2] >= box[2] - 1e-9 && out[1] <= box[1] + 1e-9 && out[3] >= box[3] - 1e-9, `contains the box for ${w}x${h}`);
    const [x0, y1] = mercator(out[0], out[1]);
    const [x1, y0] = mercator(out[2], out[3]);
    const aspect = (x1 - x0) / (y1 - y0);
    assert.ok(Math.abs(aspect - /** @type {number} */ (w) / /** @type {number} */ (h)) < 0.02, `aspect for ${w}x${h}`);
    const [bx0, by1] = mercator(box[0], box[1]);
    const [bx1, by0] = mercator(box[2], box[3]);
    assert.ok(Math.abs((x0 + x1) / 2 - (bx0 + bx1) / 2) < 1e-9);
    assert.ok(Math.abs((y0 + y1) / 2 - (by0 + by1) / 2) < 1e-9);
  }
  assert.deepEqual(boundsForViewport(box, 0, 100), box);
});

test('L8: attributionLines reads the registry text, skips unknown ids, and never repeats a line', () => {
  const records = new Map([
    ['carto-dark-matter', { attribution: '© OpenStreetMap contributors © CARTO' }],
    ['iem-nexrad-n0q', { attribution: 'Radar: NOAA NWS via Iowa Environmental Mesonet' }],
    ['dup', { attribution: '© OpenStreetMap contributors © CARTO' }],
  ]);
  const lookup = (/** @type {string} */ id) => /** @type {any} */ (records.get(id) ?? (id === 'throws' ? (() => { throw new Error('unknown'); })() : null));
  assert.deepEqual(attributionLines(['carto-dark-matter', 'iem-nexrad-n0q', 'dup', 'missing', 'throws'], lookup), [
    '© OpenStreetMap contributors © CARTO',
    'Radar: NOAA NWS via Iowa Environmental Mesonet',
  ]);
});
