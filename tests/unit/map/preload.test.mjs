// @ts-check
/**
 * Lane L8: the adapter's preload list equals create-map's static import graph inside map/, its layer list
 * equals the layer modules on disk, and its asset constants equal the loader's, so the one-round-trip load
 * never drifts from the code it hints.
 */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { moduleGraph } from '../../../scripts/check/modulepreload.mjs';
import { ROOT } from './helpers.mjs';

const MAP = path.join(ROOT, 'site', 'static', 'js', 'map');
const rel = (/** @type {string} */ f) => path.relative(MAP, f).split(path.sep).join('/');

const adapter = await import('../../../site/static/js/map/adapter.js');
const loader = await import('../../../site/static/js/map/loader.js');
const topo = await import('../../../site/static/js/map/topo.js');

test('L8: CREATE_MAP_GRAPH equals the map/ part of create-map.js static graph', async () => {
  const graph = (await moduleGraph(path.join(MAP, 'create-map.js'))).map(rel).filter((f) => !f.startsWith('..'));
  assert.deepEqual([...adapter.CREATE_MAP_GRAPH].sort(), [...graph].sort());
});

test('L8: the adapter imports no map module statically (its chain stays one hop deep)', async () => {
  const graph = (await moduleGraph(path.join(MAP, 'adapter.js'))).map(rel).filter((f) => !f.startsWith('..'));
  assert.deepEqual(graph, ['adapter.js']);
});

test('L8: create-map.js statically imports no layer module, so outline mode requests none', async () => {
  const graph = (await moduleGraph(path.join(MAP, 'create-map.js'))).map(rel);
  assert.deepEqual(graph.filter((f) => f.startsWith('layers/')), []);
});

test('L8: LAYER_FILES names every layer module on disk', () => {
  const onDisk = readdirSync(path.join(MAP, 'layers')).filter((f) => f.endsWith('.js') && f !== 'common.js').map((f) => f.replace(/\.js$/, '')).sort();
  assert.deepEqual([...adapter.LAYER_FILES].sort(), onDisk);
});

test('L8: the adapter hints the same assets the loader and topo modules fetch', () => {
  assert.equal(adapter.LIBRARY_BASE, loader.MAPLIBRE_BASE);
  assert.equal(adapter.OUTLINES_PATH, topo.OUTLINES_FILE);
  const loaderSource = readFileSync(path.join(MAP, 'loader.js'), 'utf8');
  assert.ok(loaderSource.includes(`const TOPOJSON_FILE = '${adapter.TOPOJSON_FILE}';`));
  assert.ok(loaderSource.includes(`const MAP_CSS = '${adapter.MAP_CSS}';`));
});
