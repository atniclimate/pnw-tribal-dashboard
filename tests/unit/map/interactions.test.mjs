// @ts-check
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createBoundariesLayer } from '../../../site/static/js/map/layers/boundaries.js';
import { geometryBounds } from '../../../site/static/js/map/topo.js';
import { buildGaugeFeatures, drawnCategory } from '../../../site/static/js/map/layers/gauges.js';
import { layerStatus } from '../../../site/static/js/map/style.js';
import { validateSnapshot } from '../../../site/static/js/core/status.js';

/** Isolated map lifecycle double; its coordinates are TEST INPUT, never production data. */
function harness() {
  /** @type {Map<string, any>} */
  const sources = new Map();
  /** @type {Map<string, any>} */
  const layers = new Map();
  /** @type {Map<string, (result: unknown) => void>} */
  const pending = new Map();
  /** @type {unknown[]} */
  const notes = [];
  const map = {
    getLayersOrder: () => [...layers.keys()],
    addSource: (/** @type {string} */ id, /** @type {unknown} */ value) => { assert.ok(!sources.has(id), `duplicate source ${id}`); sources.set(id, value); },
    addLayer: (/** @type {any} */ value) => layers.set(value.id, value),
    getSource: (/** @type {string} */ id) => sources.get(id),
    getLayer: (/** @type {string} */ id) => layers.get(id),
    removeLayer: (/** @type {string} */ id) => layers.delete(id),
    removeSource: (/** @type {string} */ id) => sources.delete(id),
    setFeatureState: () => {},
    setLayoutProperty: (/** @type {string} */ id, /** @type {string} */ key, /** @type {string} */ value) => { layers.get(id).layout = { [key]: value }; },
  };
  const layer = createBoundariesLayer();
  const context = {
    map, token: () => '#123456', signal: new AbortController().signal,
    fetchLocal: (/** @type {string} */ path) => new Promise((resolve) => pending.set(path, resolve)),
    status: () => {}, setDatasets: (/** @type {unknown} */ data) => notes.push(data),
    zoomNow: () => 3, onZoom: () => () => {},
  };
  const record = (/** @type {string} */ id) => ({ id, boundary: { status: 'polygon', detailRef: `geo/${id}.json`, parts: [] } });
  const finish = (/** @type {string} */ id) => { const resolve = pending.get(`data/geo/${id}.json`); assert.ok(resolve); resolve({ ok: true, data: { type: 'FeatureCollection', features: [{ type: 'Feature', properties: { nationId: id }, geometry: { type: 'Point', coordinates: [-122, 47] } }] } }); };
  return { layer, context, record, finish, sources, layers, notes };
}

test('Nation boundary: a late previous response cannot replace the current selection', async () => {
  const h = harness();
  await h.layer.add(/** @type {any} */ (h.context));
  const previous = h.layer.focus?.(h.record('previous'));
  const current = h.layer.focus?.(h.record('current'));
  h.finish('current'); await current;
  h.finish('previous'); await previous;
  assert.equal(h.sources.get('boundaries-detail').data.features[0].properties.nationId, 'current');
  assert.equal(h.notes.length, 1);
});

test('Nation boundary: clearing during download cannot revive the cleared geometry', async () => {
  const h = harness();
  await h.layer.add(/** @type {any} */ (h.context));
  const old = h.layer.focus?.(h.record('previous'));
  await h.layer.focus?.(null);
  h.finish('previous'); await old;
  assert.equal(h.sources.has('boundaries-detail'), false);
  assert.equal(h.notes.length, 1);
});

test('Nation boundary: layer hidden during download remains hidden when its detail arrives', async () => {
  const h = harness();
  await h.layer.add(/** @type {any} */ (h.context));
  const selected = h.layer.focus?.(h.record('current'));
  h.layer.setVisible(false);
  h.finish('current'); await selected;
  for (const layer of h.layers.values()) assert.equal(layer.layout.visibility, 'none');
});

test('Nation boundary: removal while loading does not add data to a removed map', async () => {
  const h = harness();
  await h.layer.add(/** @type {any} */ (h.context));
  const selected = h.layer.focus?.(h.record('current'));
  h.layer.remove();
  h.finish('current'); await selected;
  assert.equal(h.sources.size, 0);
  assert.equal(h.notes.length, 0);
});

test('feature bounds include geometry collections and reject malformed coordinates', () => {
  assert.deepEqual(geometryBounds({ type: 'GeometryCollection', geometries: [
    { type: 'Point', coordinates: [-125, 45] },
    { type: 'MultiPolygon', coordinates: [[[[-123, 48], [-120, 46], [999, 50], [NaN, 51]]]] },
  ] }), [-125, 45, -120, 48]);
  assert.equal(geometryBounds({ type: 'Point', coordinates: [999, 47] }), null);
  assert.equal(geometryBounds(null), null);
});

test('outdated and undated gauge readings stay hollow and carry explicit status', () => {
  const now = new Date('2026-10-05T12:00:00Z');
  const old = /** @type {any} */ ({ id: 'test', observed: { category: 'no_flooding', validTime: '2026-10-04T00:00:00Z' } });
  assert.equal(drawnCategory(old, now), 'no-reading');
  assert.equal(drawnCategory({ ...old, observed: { category: 'major', validTime: null } }, now), 'no-reading');
  const built = buildGaugeFeatures({ gauges: [{ id: 'test', name: 'TEST INPUT', lat: 47, lon: -122 }] }, null, [old], now);
  assert.match(built.items[0]?.name ?? '', /observation not current, observed/);
});

test('reference layer status does not invent timestamps and known compile dates validate', () => {
  const unknown = layerStatus('live', 'Reference geometry rendered.', ['cthd-registry']);
  assert.equal(unknown.state, 'unavailable');
  assert.equal(unknown.asOf, null);
  assert.deepEqual(validateSnapshot(unknown), []);
  const known = layerStatus('cached', 'Registry build date.', ['cthd-registry'], '2026-10-04T00:00:00Z', 'retrieved');
  assert.deepEqual(validateSnapshot(known), []);
  assert.equal(known.asOf, '2026-10-04T00:00:00Z');
});
