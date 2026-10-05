// @ts-check
/**
 * Lane L8: vendored MapLibre and topojson-client (blueprint 2.3), the check:vendor script, and the static
 * rules of the map module (no flyTo, no setHTML, no blob, no inline allowance, one importer).
 */
import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { checkVendor } from '../../../scripts/check/vendor-integrity.mjs';
import { VENDOR_PLAN, buildManifest } from '../../../scripts/dev/vendor.mjs';
import { MIME } from '../../../scripts/dev/serve.mjs';
import { ROOT } from './helpers.mjs';

/** @param {string} text @returns {string} source with block and line comments removed */
const stripComments = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');

const MAPLIBRE_INTEGRITY = 'sha512-DwgganVi2BhNxOpD7ob3lJC0dQQz4HfJfuQQV3XxCY3XdOzFrMqp9ylMXhRzryRsOnIezdZcklWXIIs/Q8JPjA==';

/** A scratch repository root with the files check:vendor reads. @returns {Promise<string>} */
async function scratchRoot() {
  const dir = await mkdtemp(path.join(tmpdir(), 'cthd-vendor-'));
  await cp(path.join(ROOT, 'site', 'static', 'vendor'), path.join(dir, 'site', 'static', 'vendor'), { recursive: true });
  await cp(path.join(ROOT, 'site', 'static', 'js', 'map', 'loader.js'), path.join(dir, 'site', 'static', 'js', 'map', 'loader.js'), { recursive: true });
  await writeFile(path.join(dir, 'package.json'), await readFile(path.join(ROOT, 'package.json')));
  await writeFile(path.join(dir, 'package-lock.json'), await readFile(path.join(ROOT, 'package-lock.json')));
  return dir;
}

test('L8: MapLibre 6.12.0 is vendored from the npm tarball with manifest integrity and SHA-256 values', async () => {
  assert.deepEqual(await checkVendor(), []);
  const manifest = JSON.parse(readFileSync(path.join(ROOT, 'site/static/vendor/manifest.json'), 'utf8'));
  const m = manifest.packages['maplibre-gl'];
  assert.equal(m.version, '6.12.0');
  assert.equal(m.integrity, MAPLIBRE_INTEGRITY);
  assert.equal(m.tarball, 'https://registry.npmjs.org/maplibre-gl/-/maplibre-gl-6.12.0.tgz');
  assert.equal(m.dir, 'maplibre-gl-6.12.0');
  // The values the blueprint records (2.3), by their published prefixes and suffixes.
  const sha = (/** @type {string} */ f) => m.files[f].sha256;
  assert.ok(sha('maplibre-gl.mjs').startsWith('8e0545d1') && sha('maplibre-gl.mjs').endsWith('cf69'));
  assert.ok(sha('maplibre-gl-shared.mjs').startsWith('df3d0b4b') && sha('maplibre-gl-shared.mjs').endsWith('4631'));
  assert.ok(sha('maplibre-gl-worker.mjs').startsWith('1ecca717') && sha('maplibre-gl-worker.mjs').endsWith('90c2'));
  assert.ok(sha('maplibre-gl.css').startsWith('8456072a') && sha('maplibre-gl.css').endsWith('ab8b'));
  assert.ok('LICENSE.txt' in m.files);
  assert.equal(manifest.packages['topojson-client'].version, '3.1.0');
  assert.equal(manifest.packages['topojson-client'].dir, 'topojson-client-3.1.0');
  assert.deepEqual(Object.keys(VENDOR_PLAN), ['maplibre-gl', 'topojson-client']);
  // Rebuilding the manifest from the vendored files and the lockfile reproduces the committed one.
  assert.deepEqual(await buildManifest(), manifest);
});

test('L8: a vendored file edited by one byte fails check:vendor', async () => {
  const dir = await scratchRoot();
  try {
    const file = path.join(dir, 'site', 'static', 'vendor', 'maplibre-gl-6.12.0', 'maplibre-gl-worker.mjs');
    const bytes = await readFile(file);
    bytes[10] = (bytes[10] ?? 0) ^ 1;
    await writeFile(file, bytes);
    const problems = await checkVendor(dir);
    assert.ok(problems.some((p) => /maplibre-gl-worker\.mjs: SHA-256 differs/.test(p)), problems.join('\n'));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('L8: check:vendor also fails on a missing file, an extra file, a changed integrity, and a version drift', async () => {
  const dir = await scratchRoot();
  try {
    const vdir = path.join(dir, 'site', 'static', 'vendor', 'maplibre-gl-6.12.0');
    await writeFile(path.join(vdir, 'extra.js'), 'x');
    await rm(path.join(vdir, 'maplibre-gl.css'));
    const manifestPath = path.join(dir, 'site', 'static', 'vendor', 'manifest.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    manifest.packages['maplibre-gl'].integrity = 'sha512-AAAA';
    manifest.packages['topojson-client'].version = '3.1.1';
    await writeFile(manifestPath, JSON.stringify(manifest));
    const problems = (await checkVendor(dir)).join('\n');
    assert.match(problems, /extra\.js: vendored but not in the plan/);
    assert.match(problems, /maplibre-gl\.css: missing on disk/);
    assert.match(problems, /manifest integrity differs from package-lock\.json/);
    assert.match(problems, /topojson-client: manifest version 3\.1\.1/);
    await rm(manifestPath);
    assert.match((await checkVendor(dir)).join('\n'), /manifest\.json is missing/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('L8: the vendored worker is an ES module loaded as a module worker, with no blob URL path on the same-origin route', async () => {
  const dir = path.join(ROOT, 'site', 'static', 'vendor', 'maplibre-gl-6.12.0');
  const entry = await readFile(path.join(dir, 'maplibre-gl.mjs'), 'utf8');
  const shared = await readFile(path.join(dir, 'maplibre-gl-shared.mjs'), 'utf8');
  assert.match(entry, /type:\s*[`'"]module[`'"]/);
  assert.match(entry + shared, /new Worker\(/);
  // The entry module imports the shared module (so the loader preloads both in parallel).
  assert.match(entry, /maplibre-gl-shared\.mjs/);
  const loader = stripComments(await readFile(path.join(ROOT, 'site/static/js/map/loader.js'), 'utf8'));
  assert.match(loader, /setWorkerUrl\(new URL\('maplibre-gl-worker\.mjs', base\)\.href\)/);
  assert.match(loader, /setWorkerCount\(1\)/);
  assert.doesNotMatch(loader, /blob:|createObjectURL|importScriptInWorkers/);
});

test('L8: the dev server serves .mjs as text/javascript', () => {
  assert.match(MIME['.mjs'] ?? '', /^text\/javascript/);
});

/** @param {string} dir @returns {Promise<string[]>} every .js file under dir */
async function jsFiles(dir) {
  const out = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...(await jsFiles(p)));
    else if (e.name.endsWith('.js')) out.push(p);
  }
  return out;
}

test('L8: no flyTo, setHTML, blob, or eval anywhere in site code; only loader.js imports the vendored library; only create-map.js constructs a Map', async () => {
  const files = await jsFiles(path.join(ROOT, 'site', 'static', 'js'));
  assert.ok(files.length > 20);
  for (const file of files) {
    const rel = path.relative(ROOT, file).split(path.sep).join('/');
    const text = (await readFile(file, 'utf8')).replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
    assert.doesNotMatch(text, /\.flyTo\s*\(/, `${rel} calls flyTo`);
    assert.doesNotMatch(text, /\.setHTML\s*\(/, `${rel} calls setHTML`);
    assert.doesNotMatch(text, /createObjectURL|blob:/, `${rel} builds a blob URL`);
    assert.doesNotMatch(text, /\beval\s*\(|new Function\s*\(/, `${rel} evaluates strings`);
    // Only loader.js imports the library (the adapter names the same folder only to hint it to the browser).
    if (!rel.endsWith('map/loader.js')) assert.doesNotMatch(text, /(?:\bfrom|\bimport\s*\()\s*['"`][^'"`]*vendor\/maplibre-gl/, `${rel} imports the vendored library`);
    if (!rel.endsWith('map/create-map.js')) assert.doesNotMatch(text, /new\s+maplibre(gl)?\.Map\s*\(/, `${rel} constructs a Map`);
  }
});

test('L8: every page policy allows module scripts and the same-origin worker without blob:, unsafe-eval, or unsafe-inline', async () => {
  /** @type {string[]} */
  const pages = [];
  const walk = async (/** @type {string} */ dir) => {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (e.name !== 'classic' && e.name !== 'data' && e.name !== 'static') await walk(p); } else if (e.name.endsWith('.html')) pages.push(p);
    }
  };
  await walk(path.join(ROOT, 'site'));
  assert.ok(pages.length >= 10);
  for (const page of pages) {
    const html = await readFile(page, 'utf8');
    const csp = /<meta http-equiv="Content-Security-Policy" content="([^"]+)"/.exec(html)?.[1];
    if (!csp) continue;
    assert.doesNotMatch(csp, /blob:|unsafe-eval|unsafe-inline|data:[^;]*script/, `${path.relative(ROOT, page)} policy`);
    assert.match(csp, /script-src 'self'/);
    assert.match(csp, /worker-src 'self'/);
    assert.match(csp, /style-src 'self'(;|$)/);
  }
});

test('L8: the style builder sets no glyphs or sprite and no layer in the map code is a text symbol layer', async () => {
  for (const f of await jsFiles(path.join(ROOT, 'site/static/js/map'))) {
    if (f.endsWith('create-map.js')) continue; // its read-only inspect() reports the style's glyphs and sprite (both null)
    const text = stripComments(await readFile(f, 'utf8'));
    assert.doesNotMatch(text, /['"]text-field['"]|text-font|\bglyphs\s*:|\bsprite\s*:/, `${path.relative(ROOT, f)} uses canvas text`);
  }
});
