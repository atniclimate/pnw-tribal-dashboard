// @ts-check
/**
 * Runtime contract (blueprint 2.2, 12.3): the alert modules import unchanged under Node 24 and the browser
 * (relative ES module imports only, no Node built-ins, no bare specifiers, no DOM globals), and 500 alerts
 * normalize in under 50 ms in Node.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { normalizeNwsCollection } from '../../../site/static/js/alerts/nws.js';
import { ROOT, fixture, ctxOf } from './helpers.mjs';

const DIRS = ['site/static/js/alerts', 'site/static/js/bc'];
const files = DIRS.flatMap((d) => readdirSync(path.join(ROOT, d)).filter((f) => f.endsWith('.js')).map((f) => path.join(ROOT, d, f)));

test('every alert and BC module imports in Node and exports its contract names', async () => {
  const contract = JSON.parse(readFileSync(path.join(ROOT, 'tests', 'unit', 'contracts', 'module-contract.json'), 'utf8'));
  for (const file of files) {
    const mod = await import(pathToFileURL(file).href);
    const rel = path.relative(ROOT, file).split(path.sep).join('/');
    const entry = contract.modules.find((/** @type {any} */ m) => m.path === rel);
    assert.ok(entry, `${rel} is in the module contract`);
    for (const name of entry.exports) assert.ok(name in mod, `${rel} exports ${name}`);
  }
});

test('browser-safe imports: relative .js paths only; no node:, no bare specifiers, no DOM globals', () => {
  for (const file of files) {
    const src = readFileSync(file, 'utf8');
    for (const m of src.matchAll(/^\s*import\s[^'"]*['"]([^'"]+)['"]/gm)) {
      const spec = /** @type {string} */ (m[1]);
      assert.ok(spec.startsWith('./') || spec.startsWith('../'), `${path.basename(file)} imports ${spec}`);
      assert.ok(spec.endsWith('.js'), `${path.basename(file)} imports ${spec} without .js`);
    }
    assert.ok(!/\b(document|window|localStorage|navigator)\./.test(src.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '')), `${path.basename(file)} touches a DOM global`);
    assert.ok(!/\bfetch\(/.test(src), `${path.basename(file)} calls fetch`);
    assert.ok(!/innerHTML|insertAdjacentHTML|outerHTML/.test(src), `${path.basename(file)} uses an HTML sink`);
  }
});

test('500 alerts normalize in under 50 ms in Node', () => {
  const { body, meta } = fixture('nws-alerts-active', 'footprint-active.json');
  const features = [];
  for (let i = 0; features.length < 500; i += 1) {
    const f = structuredClone(body.features[i % body.features.length]);
    f.properties.id = `${f.properties.id}.copy${i}`;
    features.push(f);
  }
  const coll = { ...body, features };
  normalizeNwsCollection(coll, ctxOf(meta));
  let best = Infinity;
  for (let run = 0; run < 5; run += 1) {
    const t0 = performance.now();
    const out = normalizeNwsCollection(coll, ctxOf(meta));
    best = Math.min(best, performance.now() - t0);
    assert.equal(out.alerts.length, 500);
  }
  assert.ok(best < 50, `500 alerts took ${best.toFixed(1)} ms`);
});
