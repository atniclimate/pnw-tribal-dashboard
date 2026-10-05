// @ts-check
/**
 * check:budgets (blueprint 8.1, 8.2; budgets.json). Measures, in gzip bytes, from each page's critical
 * set and from the vendored and geometry files:
 *
 *   per page      HTML; linked screen CSS; the static JavaScript import graph; preloaded fonts
 *   map rows      the vendored MapLibre set (interactive map row) and topojson-client (outline row), and each
 *                 vendored file against the 300 KB per-request cap
 *   geometry      headquarters points, boundary overview and detail, NWS zones, ECCC regions, outlines, gauges
 *                 status, wherever those files exist
 *
 * Playwright's network logs measure the runtime rows (first data, before-alert-paint, image and request
 * caps, service worker precache, timing); see tests/e2e/budget.spec.mjs. A file that a page links but that
 * does not exist yet is reported as pending, and fails only under CTHD_GATE=1 (Gate V and CI after the page
 * lanes land). `--json` prints the measurements as JSON. Owner: lane L15.
 */
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { ROOT, SITE, isMain, listPages, readPage } from './lib/pages.mjs';
import { moduleGraph } from './modulepreload.mjs';

/** @typedef {{ row: string, bytes: number, max: number, unit: 'gzip' | 'raw', where: string, ok: boolean, level: 'fail' | 'ok' }} Measure */

export async function loadBudgets() {
  return JSON.parse(await readFile(path.join(ROOT, 'budgets.json'), 'utf8'));
}

/** @param {Buffer | string} data */
export const gzipSize = (data) => gzipSync(data, { level: 9 }).length;

/**
 * Critical-set sizes of one page.
 * @param {string} rel page path relative to site/
 * @param {string} html
 * @param {(abs: string) => Promise<Buffer | null>} read file reader (null when absent)
 * @returns {Promise<{ html: number, css: number, js: number, fonts: number, missing: string[] }>}
 */
export async function pageSizes(rel, html, read) {
  const pageDir = path.dirname(path.join(SITE, rel));
  /** @type {string[]} */
  const missing = [];
  /** @param {string} href */
  const sized = async (href) => {
    const abs = path.resolve(pageDir, href.split(/[?#]/)[0] ?? href);
    const buf = await read(abs);
    if (!buf) { missing.push(path.relative(SITE, abs).split(path.sep).join('/')); return 0; }
    return gzipSize(buf);
  };
  let css = 0;
  for (const m of html.matchAll(/<link\s[^>]*>/g)) {
    const tag = m[0];
    const href = /\bhref="([^"]+)"/.exec(tag)?.[1];
    if (!href || /^https?:/.test(href)) continue;
    if (/\brel="stylesheet"/.test(tag) && !/\bmedia="print"/.test(tag)) css += await sized(href);
  }
  let fonts = 0;
  for (const m of html.matchAll(/<link\s[^>]*\brel="preload"[^>]*\bas="font"[^>]*>/g)) {
    const href = /\bhref="([^"]+)"/.exec(m[0])?.[1];
    if (href && !/^https?:/.test(href)) fonts += await sized(href);
  }
  let js = 0;
  for (const m of html.matchAll(/<script\s+type="module"\s+src="([^"]+)"/g)) {
    const entry = path.resolve(pageDir, m[1] ?? '');
    try {
      for (const abs of await moduleGraph(entry)) js += await sized(path.relative(pageDir, abs));
    } catch (e) {
      const msg = /** @type {NodeJS.ErrnoException} */ (e).code === 'ENOENT' ? `${path.relative(SITE, entry).split(path.sep).join('/')} (or a module it imports)` : String(/** @type {Error} */ (e).message);
      missing.push(msg);
    }
  }
  return { html: gzipSize(html), css, js, fonts, missing };
}

/** @param {string} abs @returns {Promise<Buffer | null>} */
async function readIfExists(abs) {
  try { return await readFile(abs); } catch { return null; }
}

/** @param {string} dir absolute @param {RegExp} re @returns {Promise<string[]>} */
async function listFiles(dir, re) {
  try { return (await readdir(dir)).filter((n) => re.test(n)).sort().map((n) => path.join(dir, n)); } catch { return []; }
}

/** @param {string} abs */
const relSite = (abs) => path.relative(SITE, abs).split(path.sep).join('/');

/**
 * @param {Measure[]} out @param {string} row @param {number} bytes @param {number} max
 * @param {'gzip' | 'raw'} unit @param {string} where
 */
function push(out, row, bytes, max, unit, where) {
  const ok = bytes <= max;
  out.push({ row, bytes, max, unit, where, ok, level: ok ? 'ok' : 'fail' });
}

/**
 * Both map rows of blueprint 8.1: the vendored MapLibre set and the topojson-client outline set.
 * @param {any} budgets
 * @param {{ maplibre: { file: string, gzip: number }[], topojson: { file: string, gzip: number }[] }} vendored
 * @returns {Measure[]}
 */
export function mapRows(budgets, vendored) {
  /** @type {Measure[]} */
  const out = [];
  const total = vendored.maplibre.reduce((s, f) => s + f.gzip, 0);
  if (vendored.maplibre.length) {
    push(out, 'mapInteractive.maplibreVendoredMax', total, budgets.bytes.mapInteractive.maplibreVendoredMax, 'gzip', `${vendored.maplibre.length} vendored MapLibre file(s)`);
    for (const f of vendored.maplibre) push(out, 'requestWithoutTap.max (MapLibre file)', f.gzip, budgets.bytes.requestWithoutTap.max, 'gzip', f.file);
  }
  if (vendored.topojson.length) {
    const t = vendored.topojson.reduce((s, f) => s + f.gzip, 0);
    // The outline row is stated as "about 3 KB"; the check fails at twice that.
    push(out, 'mapOutline.topojsonClientApprox (fail above 2x)', t, budgets.bytes.mapOutline.topojsonClientApprox * 2, 'gzip', vendored.topojson.map((f) => f.file).join(', '));
  }
  return out;
}

/**
 * Geometry rows (budgets.geometry) for files that exist.
 * @param {any} budgets
 * @param {{ file: string, raw: number, gzip: number }[]} files measured geometry files by site-relative path
 * @returns {Measure[]}
 */
export function geometryRows(budgets, files) {
  const g = budgets.geometry;
  /** @type {Measure[]} */
  const out = [];
  /** @param {RegExp} re */
  const pick = (re) => files.filter((f) => re.test(f.file));
  for (const f of pick(/^data\/geo\/hq-points\.json$/)) push(out, 'geometry.hqPoints.rawMax', f.raw, g.hqPoints.rawMax, 'raw', f.file);
  for (const f of pick(/^data\/geo\/boundaries-overview[^/]*\.json$/)) {
    push(out, 'geometry.boundariesOverview.rawMax', f.raw, g.boundariesOverview.rawMax, 'raw', f.file);
    push(out, 'geometry.boundariesOverview.gzipMax', f.gzip, g.boundariesOverview.gzipMax, 'gzip', f.file);
  }
  const detail = pick(/^data\/geo\/boundaries\/[^/]+\.json$/);
  if (detail.length) push(out, 'geometry.boundaryDetailTotal.rawMax', detail.reduce((s, f) => s + f.raw, 0), g.boundaryDetailTotal.rawMax, 'raw', `${detail.length} detail file(s)`);
  for (const f of pick(/^data\/geo\/nws-zones[^/]*\.json$/)) {
    push(out, 'geometry.nwsZones.rawMax', f.raw, g.nwsZones.rawMax, 'raw', f.file);
    push(out, 'geometry.nwsZones.gzipMax', f.gzip, g.nwsZones.gzipMax, 'gzip', f.file);
  }
  for (const f of pick(/^data\/geo\/eccc-regions[^/]*\.json$/)) push(out, 'geometry.ecccRegions.rawMax', f.raw, g.ecccRegions.rawMax, 'raw', f.file);
  for (const f of pick(/^data\/geo\/outlines\.topo\.json$/)) push(out, 'geometry.outlines.rawMax', f.raw, g.outlines.rawMax, 'raw', f.file);
  for (const f of pick(/^data\/live\/gauges-status\.json$/)) push(out, 'geometry.gaugesStatus.gzipMax', f.gzip, g.gaugesStatus.gzipMax, 'gzip', f.file);
  return out;
}

/** @param {any} budgets @param {{ html: number, css: number, js: number, fonts: number }} s @param {string} page @returns {Measure[]} */
export function pageRows(budgets, s, page) {
  /** @type {Measure[]} */
  const out = [];
  push(out, 'htmlPerPage', s.html, budgets.bytes.htmlPerPage.gzipMax, 'gzip', page);
  push(out, 'cssCritical', s.css, budgets.bytes.cssCritical.gzipMax, 'gzip', page);
  push(out, 'jsStaticGraph', s.js, budgets.bytes.jsStaticGraph.gzipMax, 'gzip', page);
  push(out, 'fontsPreloaded', s.fonts, budgets.bytes.fontsPreloaded.gzipMax, 'gzip', page);
  return out;
}

async function main() {
  const budgets = await loadBudgets();
  const gate = process.env.CTHD_GATE === '1';
  /** @type {Measure[]} */
  const rows = [];
  /** @type {Map<string, string[]>} */
  const pending = new Map();
  for (const rel of await listPages()) {
    const html = await readPage(rel);
    const s = await pageSizes(rel, html, readIfExists);
    rows.push(...pageRows(budgets, s, rel));
    if (s.missing.length) pending.set(rel, s.missing);
  }
  /** @param {RegExp} re */
  const vendorSet = async (re) => {
    /** @type {{ file: string, gzip: number }[]} */
    const out = [];
    for (const d of await listFiles(path.join(SITE, 'static', 'vendor'), re)) {
      let inner = [];
      try { inner = (await stat(d)).isDirectory() ? await listFiles(d, /\.(m?js|css)$/) : [d]; } catch { continue; }
      for (const f of inner) { const b = await readIfExists(f); if (b) out.push({ file: relSite(f), gzip: gzipSize(b) }); }
    }
    return out;
  };
  const vendored = { maplibre: await vendorSet(/^maplibre-gl/), topojson: await vendorSet(/^topojson-client/) };
  rows.push(...mapRows(budgets, vendored));
  /** @type {{ file: string, raw: number, gzip: number }[]} */
  const geo = [];
  for (const [dir, re] of /** @type {[string, RegExp][]} */ ([['data/geo', /\.json$/], ['data/geo/boundaries', /\.json$/], ['data/live', /^gauges-status\.json$/]])) {
    for (const f of await listFiles(path.join(SITE, ...dir.split('/')), re)) {
      const b = await readIfExists(f);
      if (b) geo.push({ file: relSite(f), raw: b.length, gzip: gzipSize(b) });
    }
  }
  rows.push(...geometryRows(budgets, geo));

  if (process.argv.includes('--json')) { console.log(JSON.stringify({ rows, pending: Object.fromEntries(pending) }, null, 2)); return; }
  const failed = rows.filter((r) => !r.ok);
  for (const r of failed) console.error(`check:budgets ${r.where}: ${r.row} is ${r.bytes} ${r.unit} bytes, over ${r.max}`);
  const pendingFiles = new Set([...pending.values()].flat());
  if (pendingFiles.size) {
    const msg = `${pendingFiles.size} linked file(s) not delivered yet: ${[...pendingFiles].slice(0, 6).join(', ')}${pendingFiles.size > 6 ? ', ...' : ''}`;
    if (gate) console.error(`check:budgets ${msg}`); else console.warn(`check:budgets pending: ${msg} (fails under CTHD_GATE=1)`);
  }
  const mapMeasured = rows.some((r) => r.row.startsWith('mapInteractive'));
  console.log(`check:budgets ${failed.length ? 'failed' : 'ok'} (${rows.length} measurements; map interactive row ${mapMeasured ? 'measured' : 'pending the vendored MapLibre set'}; outline row ${rows.some((r) => r.row.startsWith('mapOutline')) ? 'measured' : 'pending topojson-client'})`);
  if (failed.length || (gate && pendingFiles.size)) process.exit(1);
}

if (isMain(import.meta.url)) await main();
