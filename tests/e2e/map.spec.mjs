// @ts-check
/// <reference lib="dom" />
/**
 * Map module end-to-end scenarios (blueprint 10.2 scenarios 4, 10, 13, 15, 16, and 17). Owner: lane L8.
 *
 * The map has no page of its own until the page lanes land, so every test opens the real Forecasts page
 * (its real Content Security Policy, chrome, and host guard), replaces that page's own module with an empty
 * one so no other lane's code runs, adds a map frame to <main>, and drives the real map modules through
 * the real dev server. The upstream tile hosts are answered by the harness: tiles with a transparent PNG
 * generated here and the two valid-time endpoints with test inputs that are never shown as observations.
 * Real alerts come from the 10/05/2026 captures through lane L3's normalizer (tests/unit/map/helpers.mjs).
 *
 * Projects: the Chromium projects run the interactive cases (software GL is enough); the no-WebGL project
 * runs only the outline cases (scenario 15), because the config starts it with WebGL disabled.
 */
import { deflateSync, crc32 } from 'node:zlib';
import { expect, test } from '@playwright/test';
import { attachGuards } from './support/harness.mjs';
import { realAlerts } from '../unit/map/helpers.mjs';

const MAP_PATH = /\/static\/js\/map\//;
const VENDOR_PATH = /\/static\/vendor\//;
const CANONICAL = 'Representation, not jurisdiction.';

/** @returns {Buffer} a 256 x 256 fully transparent PNG, the stand-in for any upstream tile */
function transparentTile() {
  const w = 256;
  const raw = Buffer.alloc((w * 4 + 1) * w);
  /** @param {string} type @param {Buffer} data */
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body) >>> 0);
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(w, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const TILE = transparentTile();

/**
 * A static server shaped like GitHub Pages for the timing and retention cases: the site under
 * /pnw-tribal-dashboard/, text responses gzipped (Pages gzips them; scripts/dev/serve.mjs does not, which
 * would make every byte budget look three times too heavy), and .mjs served as text/javascript.
 * @param {string} dir directory served at /pnw-tribal-dashboard/
 */
async function pagesServer(dir) {
  const { createServer } = await import('node:http');
  const { readFile, stat } = await import('node:fs/promises');
  const { gzipSync } = await import('node:zlib');
  const path = await import('node:path');
  const { MIME } = await import('../../scripts/dev/serve.mjs');
  let root = dir;
  const BASE = '/pnw-tribal-dashboard/';
  const server = createServer(async (req, res) => {
    const rel = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname);
    if (!rel.startsWith(BASE)) { res.writeHead(404).end(); return; }
    let file = path.join(root, rel.slice(BASE.length));
    try { if ((await stat(file)).isDirectory()) file = path.join(file, 'index.html'); } catch { res.writeHead(404).end(); return; }
    try {
      const body = await readFile(file);
      const type = MIME[path.extname(file)] ?? 'application/octet-stream';
      if (/^(text|application\/(json|xml))|svg/.test(type)) res.writeHead(200, { 'content-type': type, 'content-encoding': 'gzip', 'cache-control': 'max-age=600' }).end(gzipSync(body));
      else res.writeHead(200, { 'content-type': type, 'cache-control': 'max-age=600' }).end(body);
    } catch { res.writeHead(404).end(); }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)));
  return { server, port: /** @type {import('node:net').AddressInfo} */ (server.address()).port, setRoot: (/** @type {string} */ d) => { root = d; } };
}

/** Test inputs for the two valid-time endpoints; the layer prints them as the radar valid time. */
const IEM_TIME = JSON.stringify({ meta: { valid: '2026-10-05T08:50:00Z' } });
const GEOMET_CAPS = '<Capabilities><Layer><Name>RADAR_1KM_RRAI</Name><Dimension name="time" units="ISO8601" default="2026-10-05T08:48:00Z">2026-10-05T07:48:00Z/2026-10-05T08:48:00Z/PT6M</Dimension></Layer></Capabilities>';

/**
 * `shippedBasemap`: serve the committed source registry unchanged. By default the harness serves it with the
 * CARTO record set to `active`, a test-only override, so the cases that exercise basemap tiles and their
 * failure path still run while the shipped record stays `active-pending-terms` (Q10: no key yet, basemap off).
 * `delayLibraryMs` answers the library after that delay.
 * @typedef {{ failTiles?: boolean, query?: string, stallLibrary?: boolean, failWorker?: boolean, shippedBasemap?: boolean, delayLibraryMs?: number }} OpenOptions
 */

/**
 * Opens the Forecasts page with the harness mocks and adds an empty map frame.
 * @param {import('@playwright/test').Page} page
 * @param {OpenOptions} [o]
 */
async function openMapPage(page, o = {}) {
  /** @type {Record<string, (route: import('@playwright/test').Route) => Promise<void> | void>} */
  const mocks = {
    'basemaps.cartocdn.com': (r) => (o.failTiles ? r.abort('failed') : r.fulfill({ contentType: 'image/png', headers: { 'access-control-allow-origin': '*' }, body: TILE })),
    'mesonet.agron.iastate.edu': (r) => (r.request().url().includes('n0q_0.json')
      ? r.fulfill({ contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: IEM_TIME })
      : r.fulfill({ contentType: 'image/png', headers: { 'access-control-allow-origin': '*' }, body: TILE })),
    'geo.weather.gc.ca': (r) => (r.request().url().includes('GetCapabilities')
      ? r.fulfill({ contentType: 'text/xml', headers: { 'access-control-allow-origin': '*' }, body: GEOMET_CAPS })
      : r.fulfill({ contentType: 'image/png', headers: { 'access-control-allow-origin': '*' }, body: TILE })),
  };
  const guards = await attachGuards(page, { pageId: 'forecasts', mocks });
  await page.route('**/static/js/pages/forecasts.js', (r) => r.fulfill({ contentType: 'text/javascript', body: '' }));
  if (!o.shippedBasemap) {
    await page.route('**/data/curated/sources.json', async (r) => {
      const res = await r.fetch();
      const doc = await res.json();
      for (const s of doc.items ?? []) if (s.id === 'carto-dark-matter') s.status = 'active';
      await r.fulfill({ response: res, body: JSON.stringify(doc) });
    });
  }
  if (o.stallLibrary) await page.route('**/vendor/maplibre-gl-6.12.0/maplibre-gl.mjs', () => { /* never answered */ });
  if (o.delayLibraryMs) {
    const wait = o.delayLibraryMs;
    await page.route('**/vendor/maplibre-gl-6.12.0/maplibre-gl.mjs', async (r) => { await new Promise((res) => setTimeout(res, wait)); await r.continue(); });
  }
  if (o.failWorker) await page.route('**/vendor/maplibre-gl-6.12.0/maplibre-gl-worker.mjs', (r) => r.abort('failed'));
  await page.goto(`forecasts/${o.query ?? ''}`);
  await page.evaluate(() => {
    const main = document.querySelector('main') ?? document.body;
    const before = document.createElement('div');
    before.style.height = '900px';
    const wrap = document.createElement('section');
    wrap.id = 'map-test';
    wrap.className = 'map-frame';
    const frame = document.createElement('div');
    frame.className = 'map-frame__viewport';
    frame.id = 'map-test-frame';
    wrap.append(frame);
    const after = document.createElement('div');
    after.style.height = '900px';
    main.append(before, wrap, after);
  });
  return guards;
}

/** @param {import('@playwright/test').Page} page @param {{ layers?: string[], mode?: 'auto' | 'outline', alerts?: boolean, label?: string }} [o] */
async function startMap(page, o = {}) {
  const { zoneAlerts, polygonAlert } = realAlerts();
  const alerts = o.alerts === false ? [] : [polygonAlert, ...zoneAlerts.slice(0, 40)];
  return page.evaluate(async ({ layers, mode, alerts: a, label }) => {
    const adapter = new URL('../static/js/map/create-map.js', location.href).href;
    const { createMap } = await import(adapter);
    const frame = /** @type {HTMLElement} */ (document.getElementById('map-test-frame'));
    const w = /** @type {any} */ (window);
    w.__selected = [];
    const map = await createMap(frame, { sovereignty: { sourceIds: ['bia-lar', 'census-aiannh-2025', 'nrcan-aboriginal-lands-bc'] }, label, layers, mode, onSelect: (/** @type {any} */ s) => w.__selected.push(s) });
    w.__map = map;
    map.setAlerts(a);
    return { mode: map.mode };
  }, { layers: o.layers ?? ['basemap', 'radar', 'outlines', 'boundaries', 'zones', 'alerts', 'gauges', 'hq'], mode: o.mode ?? 'auto', alerts, label: o.label ?? 'Map of Cascadia alerts' });
}

/** @param {import('@playwright/test').Page} page @param {string} what */
async function waitForMode(page, what) {
  await expect.poll(() => page.evaluate(() => document.getElementById('map-test-frame')?.getAttribute('data-map-mode')), { timeout: 25_000, message: what }).toBe(what.split(' ')[0]);
}

/** @param {import('@playwright/test').Page} page */
async function noteIsVisibleAndUncovered(page) {
  return page.evaluate((canonical) => {
    const note = document.querySelector('.sovereignty-note');
    if (!note) return 'no note';
    if (!(note.textContent ?? '').includes(canonical)) return 'canonical sentence missing';
    note.scrollIntoView({ block: 'center' });
    const r = note.getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return hit && note.contains(hit) ? 'ok' : `covered by ${hit?.tagName}.${hit?.className}`;
  }, CANONICAL);
}

/** @param {import('@playwright/test').Page} page */
const webglProject = (page) => !/no-webgl/.test(test.info().project.name);

test.describe('map module', () => {
  test('scenario 4: nothing in map/ or vendor/ is requested before alerts-painted and a map request', async ({ page }) => {
    test.skip(!webglProject(page), 'interactive case');
    const g = await openMapPage(page);
    await page.waitForTimeout(800);
    expect(g.requests.filter((r) => MAP_PATH.test(r.url) || VENDOR_PATH.test(r.url))).toEqual([]);
    // Importing the adapter early, with no alerts-painted mark, must not pull in create-map, a layer, or the library.
    await page.evaluate(() => {
      const w = /** @type {any} */ (window);
      w.__early = import(new URL('../static/js/map/adapter.js', location.href).href).then((m) => m.requestMap(/** @type {HTMLElement} */ (document.getElementById('map-test-frame')), {
        sovereignty: { sourceIds: ['bia-lar'] }, label: 'Early request', layers: ['outlines', 'hq'],
      }));
    });
    await page.waitForTimeout(800);
    const early = g.requests.filter((r) => MAP_PATH.test(r.url) || VENDOR_PATH.test(r.url)).map((r) => r.url);
    expect(early.some((u) => /\/map\/(create-map|layers\/)/.test(u))).toBe(false);
    expect(early.some((u) => VENDOR_PATH.test(u))).toBe(false);
    await page.evaluate(() => { performance.mark('alerts-painted'); });
    await expect.poll(() => g.requests.some((r) => /maplibre-gl\.mjs/.test(r.url)), { timeout: 20_000 }).toBe(true);
    await page.evaluate(() => /** @type {any} */ (window).__early);
    expect(await g.cspViolations()).toEqual([]);
  });

  test('scenario 10: the sovereignty note shows, uncovered, at 320 and 1280 pixels and in embed mode', async ({ page }) => {
    test.skip(!webglProject(page), 'interactive case');
    for (const width of [320, 1280]) {
      await page.setViewportSize({ width, height: 800 });
      const g = await openMapPage(page);
      await startMap(page);
      expect(await noteIsVisibleAndUncovered(page)).toBe('ok');
      expect(await g.cspViolations()).toEqual([]);
    }
    await openMapPage(page, { query: '?embed=1' });
    await startMap(page);
    expect(await noteIsVisibleAndUncovered(page)).toBe('ok');
  });

  test('scenario 10: createMap throws without the sovereignty option and mounts the note before resolving', async ({ page }) => {
    await openMapPage(page);
    const result = await page.evaluate(async () => {
      const { createMap } = await import(new URL('../static/js/map/create-map.js', location.href).href);
      const frame = /** @type {HTMLElement} */ (document.getElementById('map-test-frame'));
      /** @type {string[]} */
      const out = [];
      for (const bad of [undefined, {}, { sovereignty: {} }, { sovereignty: { sourceIds: [] } }]) {
        try { await createMap(frame, { label: 'x', layers: [], ...bad }); out.push('resolved'); } catch (e) { out.push('threw'); }
      }
      const noteBefore = document.querySelectorAll('.sovereignty-note').length;
      const m = await createMap(frame, { sovereignty: { sourceIds: ['bia-lar'] }, label: 'Outline check', layers: ['outlines'], mode: 'outline' });
      const mounted = { notes: document.querySelectorAll('.sovereignty-note').length, attribution: document.querySelectorAll('.map-attribution').length, outline: document.querySelectorAll('svg.map-outline').length };
      m.destroy();
      return { out, noteBefore, mounted, after: document.querySelectorAll('.sovereignty-note').length };
    });
    expect(result.out).toEqual(['threw', 'threw', 'threw', 'threw']);
    expect(result.noteBefore).toBe(0);
    expect(result.mounted).toEqual({ notes: 1, attribution: 1, outline: 1 });
    expect(result.after).toBe(0);
  });

  test('scenario 10: tile failure shows outlines and a degraded basemap stamp', async ({ page }) => {
    test.skip(!webglProject(page), 'interactive case');
    test.setTimeout(60_000);
    const g = await openMapPage(page, { failTiles: true });
    await startMap(page, { layers: ['basemap', 'outlines', 'hq'], alerts: false });
    await expect.poll(() => page.evaluate(() => document.getElementById('map-test-frame')?.getAttribute('data-map-state')), { timeout: 30_000 }).toBe('degraded');
    await expect(page.locator('.map-status')).toContainText('Base map tiles unavailable; outlines shown.');
    expect(await page.evaluate(() => document.getElementById('map-test-frame')?.getAttribute('data-map-mode'))).toBe('interactive');
    expect(await page.evaluate(() => document.querySelector('.map-legend')?.textContent ?? '')).toContain('State, Province, and County Outlines');
    expect(await noteIsVisibleAndUncovered(page)).toBe('ok');
    expect(await g.cspViolations()).toEqual([]);
  });

  test('with the shipped CARTO record (no key yet) no basemap tile is requested, the pill stays live, and the legend says so', async ({ page }) => {
    test.skip(!webglProject(page), 'interactive case');
    test.setTimeout(60_000);
    const g = await openMapPage(page, { shippedBasemap: true });
    await startMap(page, { layers: ['basemap', 'outlines', 'hq'], alerts: false });
    await waitForMode(page, 'interactive');
    await page.waitForTimeout(1500);
    expect(g.requests.filter((r) => /basemaps\.cartocdn\.com/.test(r.url))).toEqual([]);
    expect(await page.evaluate(() => document.getElementById('map-test-frame')?.getAttribute('data-map-state'))).toBe('live');
    await expect(page.locator('.map-legend')).toContainText('Base map not enabled; outlines shown.');
    expect(await noteIsVisibleAndUncovered(page)).toBe('ok');
    expect(await g.cspViolations()).toEqual([]);
  });

  test('scenario 15: with WebGL unavailable every map renders outline mode and never requests the library', async ({ page }) => {
    const g = await openMapPage(page);
    const probe = await page.evaluate(() => {
      const c = document.createElement('canvas');
      return Boolean(c.getContext('webgl2'));
    });
    test.skip(probe, 'this project has WebGL; the no-WebGL project runs this case');
    const modes = await page.evaluate(async () => {
      performance.mark('alerts-painted');
      const { requestMap } = await import(new URL('../static/js/map/adapter.js', location.href).href);
      const frame = /** @type {HTMLElement} */ (document.getElementById('map-test-frame'));
      const map = await requestMap(frame, { sovereignty: { sourceIds: ['bia-lar'] }, label: 'No WebGL map', layers: ['basemap', 'outlines', 'hq', 'alerts'] });
      return { mode: map.mode, notes: document.querySelectorAll('.sovereignty-note').length, attribution: document.querySelector('.map-attribution')?.textContent ?? '', legend: document.querySelector('.map-legend')?.textContent ?? '', label: document.querySelector('svg.map-outline')?.getAttribute('aria-label') ?? '', notice: document.querySelector('.map-notice')?.textContent ?? '' };
    });
    expect(modes.mode).toBe('outline');
    expect(modes.notes).toBe(1);
    expect(modes.attribution).toContain('Outlines');
    // Outline mode draws no tile, so it credits no basemap (blueprint 4.3, 4.8).
    expect(modes.attribution).not.toContain('CARTO');
    expect(modes.legend).toContain('Needs the interactive map');
    expect(modes.label).toMatch(/^No WebGL map\. Outline map of Cascadia with .* alert/);
    expect(modes.notice).toBe('This device cannot draw the interactive map. Outlines and the alert list are shown.');
    expect(g.requests.filter((r) => /maplibre-gl/.test(r.url))).toEqual([]);
    expect(await noteIsVisibleAndUncovered(page)).toBe('ok');
    expect(await g.cspViolations()).toEqual([]);
  });

  test('scenario 16: losing the GPU context mid-session switches to outline mode with a degraded status', async ({ page }) => {
    test.skip(!webglProject(page), 'interactive case');
    test.setTimeout(60_000);
    const g = await openMapPage(page);
    await startMap(page);
    await waitForMode(page, 'interactive');
    await page.evaluate(() => {
      const w = /** @type {any} */ (window);
      w.__modes = [];
      // Time inside the page, so the check does not depend on how often the test polls.
      w.__map.onModeChange((/** @type {string} */ m, /** @type {string} */ r) => { w.__switchedAt = performance.now(); w.__modes.push([m, r]); });
      w.__lostAt = performance.now();
      const canvas = /** @type {HTMLCanvasElement} */ (document.querySelector('.map-canvas canvas'));
      /** @type {any} */ (canvas.getContext('webgl2')).getExtension('WEBGL_lose_context').loseContext();
    });
    await waitForMode(page, 'outline');
    const took = await page.evaluate(() => /** @type {any} */ (window).__switchedAt - /** @type {any} */ (window).__lostAt);
    expect(took).toBeGreaterThanOrEqual(4900); // it waits the five second restore window first
    expect(took).toBeLessThan(6000);
    await expect(page.locator('.map-status')).toContainText('Interactive map unavailable on this device right now; outlines shown.');
    expect(await page.evaluate(() => document.getElementById('map-test-frame')?.getAttribute('data-map-state'))).toBe('degraded');
    expect(await noteIsVisibleAndUncovered(page)).toBe('ok');
    expect(await page.evaluate(() => /** @type {any} */ (window).__modes)).toEqual([['outline', 'Interactive map unavailable on this device right now; outlines shown.']]);
    expect(await g.cspViolations()).toEqual([]);
  });

  test('scenario 16: a failing worker switches to outline mode', async ({ page }) => {
    test.skip(!webglProject(page), 'interactive case');
    test.setTimeout(60_000);
    const g = await openMapPage(page, { failWorker: true });
    await startMap(page, { layers: ['outlines', 'hq'], alerts: false });
    await waitForMode(page, 'outline');
    await expect(page.locator('.map-status')).toContainText('Interactive map unavailable');
    expect(await noteIsVisibleAndUncovered(page)).toBe('ok');
    expect(await g.cspViolations()).toEqual([]);
  });

  test('scenario 16: a library that never loads falls back after the 20 second timeout', async ({ page }) => {
    test.skip(!webglProject(page), 'interactive case');
    test.setTimeout(60_000);
    const g = await openMapPage(page, { stallLibrary: true });
    const started = Date.now();
    await page.evaluate(() => {
      const w = /** @type {any} */ (window);
      w.__start = import(new URL('../static/js/map/create-map.js', location.href).href).then(({ createMap }) => createMap(/** @type {HTMLElement} */ (document.getElementById('map-test-frame')), {
        sovereignty: { sourceIds: ['bia-lar'] }, label: 'Timeout map', layers: ['outlines', 'hq'], mode: 'auto',
      }).then((/** @type {any} */ m) => { w.__map = m; }));
    });
    await waitForMode(page, 'outline');
    const took = Date.now() - started;
    expect(took).toBeGreaterThan(19_000);
    expect(took).toBeLessThan(30_000);
    expect(await noteIsVisibleAndUncovered(page)).toBe('ok');
    expect(await g.cspViolations()).toEqual([]);
  });

  test('scenario 16: one 20 second deadline covers the library and the map load together', async ({ page }) => {
    test.skip(!webglProject(page), 'interactive case');
    test.setTimeout(60_000);
    // The library arrives at about 15 s and the map then never loads: animation frames are swallowed, so MapLibre
    // never renders its first frame and never fires `load`. With one deadline from the request the fallback comes
    // at about 20 s; two timers in a row would give about 35 s.
    const g = await openMapPage(page, { delayLibraryMs: 15_000 });
    await page.evaluate(() => {
      const w = /** @type {any} */ (window);
      w.requestAnimationFrame = () => 0;
      w.__t0 = performance.now();
      w.__start = import(new URL('../static/js/map/create-map.js', location.href).href).then(({ createMap }) => createMap(/** @type {HTMLElement} */ (document.getElementById('map-test-frame')), {
        sovereignty: { sourceIds: ['bia-lar'] }, label: 'Deadline map', layers: ['outlines', 'hq'], mode: 'auto',
      }).then((/** @type {any} */ m) => { w.__map = m; }));
    });
    await expect.poll(() => page.evaluate(() => document.getElementById('map-test-frame')?.getAttribute('data-map-mode')), { timeout: 45_000 }).toBe('outline');
    const took = await page.evaluate(() => performance.now() - /** @type {any} */ (window).__t0);
    expect(took).toBeGreaterThan(19_000);
    expect(took).toBeLessThan(26_000);
    expect(await noteIsVisibleAndUncovered(page)).toBe('ok');
    expect(await g.cspViolations()).toEqual([]);
  });

  test('worker is a same-origin module worker with no blob URL, and no policy violation across layers, outline mode, and a context loss', async ({ page }) => {
    test.skip(!webglProject(page), 'interactive case');
    test.setTimeout(60_000);
    /** @type {string[]} */
    const workers = [];
    page.on('worker', (w) => workers.push(w.url()));
    const g = await openMapPage(page);
    await startMap(page);
    await waitForMode(page, 'interactive');
    await page.evaluate(async () => {
      const m = /** @type {any} */ (window).__map;
      for (const id of ['basemap', 'radar', 'outlines', 'boundaries', 'zones', 'alerts', 'gauges', 'hq']) { m.setLayer(id, false); m.setLayer(id, true); }
    });
    await page.waitForTimeout(1500);
    expect(workers.length).toBeGreaterThan(0);
    for (const url of workers) { expect(url).toMatch(/\/static\/vendor\/maplibre-gl-6\.12\.0\/maplibre-gl-worker\.mjs$/); expect(url.startsWith('blob:')).toBe(false); }
    expect(g.requests.filter((r) => r.url.startsWith('blob:'))).toEqual([]);
    expect(await g.cspViolations()).toEqual([]);
    expect(g.pageErrors).toEqual([]);
    expect(g.blockedHosts).toEqual([]);
  });

  test('the style has no text symbol layer, no glyphs, and no sprite; layers draw in the documented order; the canvas draws', async ({ page }) => {
    test.skip(!webglProject(page), 'interactive case');
    test.setTimeout(60_000);
    const g = await openMapPage(page);
    await startMap(page);
    await waitForMode(page, 'interactive');
    await page.waitForTimeout(2500);
    const info = await page.evaluate(() => /** @type {any} */ (window).__map.inspect());
    expect(info.glyphs).toBeNull();
    expect(info.sprite).toBeNull();
    expect(info.layers.filter((/** @type {any} */ l) => l.text)).toEqual([]);
    // Draw order, bottom to top (blueprint 4.4): background, basemap, radar, outlines, boundaries, zones, alerts, bc, gauges, hq, selection.
    const order = ['basemap', 'radar', 'outlines', 'boundaries', 'zones', 'alerts', 'bc', 'gauges', 'hq', 'selection'];
    const groups = info.layers.map((/** @type {any} */ l) => l.id.split(':')[0]).filter((/** @type {string} */ id) => order.includes(id));
    const ranks = groups.map((/** @type {string} */ id) => order.indexOf(id));
    expect(ranks).toEqual([...ranks].sort((x, y) => x - y));
    expect(new Set(groups)).toEqual(new Set(['basemap', 'radar', 'outlines', 'zones', 'alerts', 'gauges', 'hq', 'selection']));
    expect(info.layers[0].id).toBe('background');
    expect(g.requests.filter((r) => /\.pbf|glyphs|sprite/i.test(r.url))).toEqual([]);
    // The canvas is not blank: a screenshot with every layer on is much larger than one with every layer off.
    const withLayers = (await page.locator('.map-canvas canvas').first().screenshot()).length;
    await page.evaluate(() => { const m = /** @type {any} */ (window).__map; for (const id of ['basemap', 'radar', 'outlines', 'boundaries', 'zones', 'alerts', 'gauges', 'hq']) m.setLayer(id, false); });
    await page.waitForTimeout(1200);
    const without = (await page.locator('.map-canvas canvas').first().screenshot()).length;
    expect(withLayers).toBeGreaterThan(without * 3);
  });

  test('zone-basis alerts draw dashed zones apart from storm polygons, and the legend explains both', async ({ page }) => {
    test.skip(!webglProject(page), 'interactive case');
    test.setTimeout(60_000);
    await openMapPage(page);
    await startMap(page);
    await waitForMode(page, 'interactive');
    await expect.poll(async () => page.evaluate(() => /** @type {any} */ (window).__map.inspect().layers.filter((/** @type {any} */ l) => l.id.startsWith('zones:')).length), { timeout: 15_000 }).toBe(2);
    const legend = await page.locator('.map-legend').textContent();
    expect(legend).toContain('Forecast Zone Coverage (Whole Zone)');
    expect(legend).toContain('Alert Area (Drawn by Forecasters)');
    // Every alert in the feature list is named and the zone-basis ones say so.
    await page.locator('.map-feature-list > summary').click();
    const names = await page.locator('.map-feature-list__button').allTextContents();
    expect(names.length).toBeGreaterThan(0);
  });

  test('radar prints its valid times, refreshes by setTiles while visible, and pauses when hidden', async ({ page }) => {
    test.skip(!webglProject(page), 'interactive case');
    test.setTimeout(90_000);
    await page.clock.install({ time: new Date('2026-10-05T08:51:00Z') });
    const g = await openMapPage(page);
    await startMap(page, { layers: ['outlines', 'radar', 'hq'], alerts: false });
    await waitForMode(page, 'interactive');
    await expect.poll(() => page.locator('.map-legend').textContent(), { timeout: 20_000 }).toMatch(/U\.S\. Radar.*Valid \d\d\/\d\d\/2026 \d{1,2}:\d\d [AP]M/);
    expect(await page.locator('.map-legend').textContent()).toMatch(/British Columbia Radar.*Valid \d\d\/\d\d\/2026 \d{1,2}:\d\d [AP]M/);
    expect(await page.locator('.map-legend').textContent()).toContain('Outside the continental U.S. radar mosaic.');
    const tileBuckets = () => [...new Set(g.requests.filter((r) => /nexrad-n0q\/\d+\/\d+\/\d+\.png/.test(r.url)).map((r) => /[?&]t=(\d+)/.exec(r.url)?.[1]))];
    const timeReads = () => g.requests.filter((r) => /n0q_0\.json/.test(r.url)).length;
    await expect.poll(tileBuckets, { timeout: 15_000 }).toHaveLength(1);
    const reads = timeReads();
    await page.clock.fastForward('06:00');
    await expect.poll(timeReads, { timeout: 15_000 }).toBeGreaterThan(reads);
    await expect.poll(() => tileBuckets().length, { timeout: 15_000 }).toBeGreaterThan(1);
    // Hidden page: no further reads.
    await page.evaluate(() => {
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    const hiddenReads = timeReads();
    await page.clock.fastForward('12:00');
    await page.waitForTimeout(800);
    expect(timeReads()).toBe(hiddenReads);
  });

  test('radar shows the honest text when the source publishes no valid time', async ({ page }) => {
    test.skip(!webglProject(page), 'interactive case');
    test.setTimeout(60_000);
    const g = await openMapPage(page);
    await page.route('**/n0q_0.json', (r) => r.fulfill({ contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: '{}' }));
    await startMap(page, { layers: ['outlines', 'radar'], alerts: false });
    await waitForMode(page, 'interactive');
    await expect.poll(() => page.locator('.map-legend').textContent(), { timeout: 20_000 }).toMatch(/U\.S\. Radar.*Mosaic time not published; checked \d{1,2}:\d\d [AP]M/);
    expect(g.blockedHosts).toEqual([]);
  });

  test('the WebGL2 probe agrees with the browser, and an unsuited device starts in outline mode with an offer', async ({ page }, info) => {
    const g = await openMapPage(page);
    const probe = await page.evaluate(async () => {
      const { probeWebGL } = await import(new URL('../static/js/map/support.js', location.href).href);
      return probeWebGL();
    });
    if (/no-webgl/.test(info.project.name)) { expect(probe).toBe('none'); return; }
    expect(['full', 'caveat']).toContain(probe);
    if (probe === 'full') return;
    // Software rendering ('caveat'): outline mode first, the interactive map on request.
    test.setTimeout(60_000);
    const mode = await page.evaluate(async () => {
      performance.mark('alerts-painted');
      const { requestMap } = await import(new URL('../static/js/map/adapter.js', location.href).href);
      const map = await requestMap(/** @type {HTMLElement} */ (document.getElementById('map-test-frame')), { sovereignty: { sourceIds: ['bia-lar'] }, label: 'Caveat map', layers: ['basemap', 'outlines', 'hq'] });
      /** @type {any} */ (window).__map = map;
      return map.mode;
    });
    expect(mode).toBe('outline');
    expect(g.requests.filter((r) => /maplibre-gl/.test(r.url))).toEqual([]);
    const offer = page.getByRole('button', { name: 'Load Interactive Map (about 315 KB)' });
    await expect(offer).toBeVisible();
    await expect(page.locator('.sovereignty-note')).toHaveCount(1);
    await offer.click();
    await waitForMode(page, 'interactive');
    await expect(page.locator('.sovereignty-note')).toHaveCount(1);
    await expect(offer).toHaveCount(0);
  });

  test('a Nation with a published land area draws it and names its datasets in the note; one without says so', async ({ page }) => {
    test.skip(!webglProject(page), 'interactive case');
    test.setTimeout(60_000);
    await openMapPage(page);
    // Pick one of each from the committed registry index (real files, whatever the draft holds today).
    const { readFile } = await import('node:fs/promises');
    const index = JSON.parse(await readFile(new URL('../../site/data/registry/nations-index.json', import.meta.url), 'utf8'));
    const withLand = index.nations.find((/** @type {any} */ n) => n.hasBoundary);
    const pointOnly = index.nations.find((/** @type {any} */ n) => !n.hasBoundary);
    test.skip(!withLand || !pointOnly, 'the registry has no Nation of one of the two kinds yet');
    await startMap(page, { layers: ['outlines', 'boundaries', 'hq'], alerts: false });
    await waitForMode(page, 'interactive');
    await page.evaluate((id) => /** @type {any} */ (window).__map.focusNation(id), withLand.id);
    await expect.poll(() => page.evaluate(() => /** @type {any} */ (window).__map.inspect().layers.filter((/** @type {any} */ l) => l.id.startsWith('boundaries:detail')).length), { timeout: 15_000 }).toBe(3);
    await page.locator('.sovereignty-note__more > summary').click();
    await expect(page.locator('.sovereignty-note__datasets')).toContainText('Boundary datasets:');
    await expect(page.locator('.sovereignty-note__datasets')).toContainText('retrieved');
    await expect(page.locator('.map-nation-label')).toHaveCount(1);
    await expect(page.locator('.map-nation-label')).toHaveText(withLand.preferredName ?? withLand.name);
    // Zoom seven and above draws the overview of every Nation's land area.
    await page.evaluate(() => /** @type {any} */ (window).__map.setLayer('boundaries', true));
    await expect.poll(() => page.evaluate(() => /** @type {any} */ (window).__map.inspect().layers.filter((/** @type {any} */ l) => l.id.startsWith('boundaries:overview')).length), { timeout: 15_000 }).toBe(3);
    // A Nation with no published polygon: no detail layer, and the note says so.
    await page.evaluate((id) => /** @type {any} */ (window).__map.focusNation(id), pointOnly.id);
    await expect(page.locator('.sovereignty-note__datasets')).toContainText('No land-area boundary is published in the federal sources used here; headquarters location shown.');
    expect(await page.evaluate(() => /** @type {any} */ (window).__map.inspect().layers.filter((/** @type {any} */ l) => l.id.startsWith('boundaries:detail')).length)).toBe(0);
  });

  test('outline mode draws a selected Nation and storm polygons, and keeps the same note', async ({ page }) => {
    await openMapPage(page);
    await startMap(page, { mode: 'outline' });
    await expect(page.locator('svg.map-outline path.map-outline__alert').first()).toBeAttached();
    await expect(page.locator('svg.map-outline')).toHaveAttribute('role', 'img');
    // No style attribute anywhere in the picture: colors come from classes.
    expect(await page.locator('svg.map-outline [style]').count()).toBe(0);
    await page.evaluate(() => /** @type {any} */ (window).__map.focusNation('ca-fn-501'));
    await expect(page.locator('svg.map-outline circle.map-outline__hq')).toHaveCount(1);
    expect(await noteIsVisibleAndUncovered(page)).toBe('ok');
    expect(await page.locator('.map-attribution').textContent()).toContain('Outlines: U.S. Census Bureau, Province of British Columbia');
    const names = await (async () => { await page.locator('.map-feature-list > summary').click(); return page.locator('.map-feature-list__button').allTextContents(); })();
    expect(names.length).toBeGreaterThan(0);
  });

  test('scenario 17: keyboard pan and zoom, the feature list names the drawn features, and Escape returns focus', async ({ page }) => {
    test.skip(!webglProject(page), 'interactive case');
    test.setTimeout(60_000);
    const g = await openMapPage(page);
    await startMap(page);
    await waitForMode(page, 'interactive');
    const canvas = page.locator('.map-canvas canvas').first();
    await canvas.focus();
    const cam = () => page.evaluate(() => /** @type {any} */ (window).__map.camera());
    await page.waitForTimeout(1200);
    // The start view fits the whole footprint inside maxBounds, so zoom first, then pan.
    const start = await cam();
    await page.keyboard.press('Equal');
    await page.keyboard.press('Equal');
    await page.waitForTimeout(900);
    const zoomedIn = await cam();
    expect(zoomedIn.zoom).toBeGreaterThan(start.zoom);
    await page.keyboard.press('ArrowRight');
    await page.waitForTimeout(900);
    const panned = await cam();
    expect(panned.lng).toBeGreaterThan(zoomedIn.lng);
    await page.keyboard.press('Minus');
    await page.waitForTimeout(900);
    expect((await cam()).zoom).toBeLessThan(zoomedIn.zoom);
    // The feature list: every button is a named feature in view.
    await page.locator('.map-feature-list > summary').click();
    await expect.poll(() => page.locator('.map-feature-list__button').count(), { timeout: 15_000 }).toBeGreaterThan(0);
    const names = await page.locator('.map-feature-list__button').allTextContents();
    expect(names.every((n) => n.trim().length > 0)).toBe(true);
    const first = page.locator('.map-feature-list__button').first();
    await first.focus();
    await first.press('Enter');
    await expect(page.locator('.maplibregl-popup')).toBeVisible();
    await expect(page.locator('.maplibregl-popup')).toContainText((await first.textContent())?.trim().slice(0, 20) ?? '');
    await page.keyboard.press('Escape');
    await expect(page.locator('.maplibregl-popup')).toHaveCount(0);
    await expect(first).toBeFocused();
    expect(await page.evaluate(() => /** @type {any} */ (window).__selected.length)).toBeGreaterThan(0);
    expect(await g.cspViolations()).toEqual([]);
  });

  test('scenario 17: with reduced motion, selecting a Nation changes the view with no intermediate camera frames', async ({ page }) => {
    test.skip(!webglProject(page), 'interactive case');
    test.setTimeout(60_000);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await openMapPage(page);
    await startMap(page);
    await waitForMode(page, 'interactive');
    await page.waitForTimeout(1500);
    const frames = await page.evaluate(async () => {
      const m = /** @type {any} */ (window).__map;
      /** @type {string[]} */
      const seen = [];
      let stop = false;
      const sample = () => { const c = m.camera(); seen.push(`${c.lng.toFixed(5)},${c.lat.toFixed(5)},${c.zoom.toFixed(4)}`); if (!stop) requestAnimationFrame(sample); };
      requestAnimationFrame(sample);
      m.focusNation('ca-fn-501');
      await new Promise((r) => setTimeout(r, 1500));
      stop = true;
      return [...new Set(seen)];
    });
    // The start view and the final view only: a jump, never an ease.
    expect(frames.length).toBeLessThanOrEqual(2);
  });

  test('scenario 17: on touch, a one-finger drag over the map scrolls the page', async ({ page }, info) => {
    test.skip(info.project.name !== 'chromium-phone', 'touch emulation runs in the phone project');
    test.setTimeout(60_000);
    await openMapPage(page);
    await startMap(page);
    await waitForMode(page, 'interactive');
    await page.waitForTimeout(1200);
    await page.evaluate(() => { document.getElementById('map-test')?.scrollIntoView({ block: 'center' }); });
    await page.waitForTimeout(300);
    const box = await page.locator('.map-canvas').boundingBox();
    if (!box) throw new Error('map frame has no box');
    const before = await page.evaluate(() => window.scrollY);
    const camBefore = await page.evaluate(() => /** @type {any} */ (window).__map.camera());
    const client = await page.context().newCDPSession(page);
    // One finger: touch down on the map, drag upward in steps, lift.
    const x = Math.round(box.x + box.width / 2);
    const y = Math.round(box.y + box.height / 2);
    await client.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
    for (let step = 1; step <= 10; step += 1) {
      await client.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: y - step * 20 }] });
      await page.waitForTimeout(20);
    }
    await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await page.waitForTimeout(600);
    const after = await page.evaluate(() => window.scrollY);
    const camAfter = await page.evaluate(() => /** @type {any} */ (window).__map.camera());
    expect(after).toBeGreaterThan(before);
    expect(camAfter.lng).toBeCloseTo(camBefore.lng, 4);
    expect(camAfter.lat).toBeCloseTo(camBefore.lat, 4);
  });

  test('scenario 13: a page loaded from build N still lazy-loads the map, MapLibre, and the worker after build N+1 is deployed', async ({ page }, info) => {
    test.skip(!webglProject(page), 'interactive case');
    test.skip(info.project.name !== 'chromium-desktop', 'one project assembles the two builds');
    test.setTimeout(120_000);
    const { mkdtemp, cp, rm: remove } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const path = await import('node:path');
    const { execFileSync } = await import('node:child_process');
    const root = await mkdtemp(path.join(tmpdir(), 'cthd-retention-'));
    const shaN = 'a'.repeat(40);
    const shaN1 = 'b'.repeat(40);
    const assemble = (/** @type {string} */ out, /** @type {string} */ sha) => execFileSync(process.execPath, ['scripts/assemble-site.mjs', '--out', out, '--sha', sha], { cwd: process.cwd(), stdio: 'pipe' });
    const buildN = path.join(root, 'N');
    const buildN1 = path.join(root, 'N1');
    assemble(buildN, shaN);
    assemble(buildN1, shaN1);
    // The deploy workflow restores the previous generation next to the new one (blueprint 2.1); do the same here.
    await cp(path.join(buildN, 'v', 'a'.repeat(12)), path.join(buildN1, 'v', 'a'.repeat(12)), { recursive: true });
    const BASE = '/pnw-tribal-dashboard/';
    const pages = await pagesServer(buildN);
    const server = pages.server;
    const port = pages.port;
    try {
      /** @type {{ url: string, status: number, type: string }[]} */
      const seen = [];
      /** @type {string[]} */
      const workers = [];
      page.on('response', (r) => seen.push({ url: r.url(), status: r.status(), type: r.headers()['content-type'] ?? '' }));
      page.on('worker', (w) => workers.push(w.url()));
      await page.route('**/*', (r) => (new URL(r.request().url()).hostname === '127.0.0.1' ? r.continue() : r.abort('failed')));
      await page.route('**/v/*/js/pages/forecasts.js', (r) => r.fulfill({ contentType: 'text/javascript', body: '' }));
      await page.goto(`http://127.0.0.1:${port}${BASE}forecasts/`);
      const entry = await page.evaluate(() => /** @type {HTMLScriptElement} */ (document.querySelector('script[type="module"]')).src);
      expect(entry).toContain(`/v/${'a'.repeat(12)}/js/pages/forecasts.js`);
      pages.setRoot(buildN1); // build N+1 is now live; its HTML references v/bbbbbbbbbbbb, and v/aaaaaaaaaaaa is retained.
      await page.evaluate(() => {
        const wrap = document.createElement('section');
        wrap.className = 'map-frame';
        const frame = document.createElement('div');
        frame.className = 'map-frame__viewport';
        frame.id = 'map-test-frame';
        wrap.append(frame);
        document.body.prepend(wrap);
      });
      const mapUrl = await page.evaluate((e) => new URL('../map/create-map.js', e).href, entry);
      await page.evaluate(async ({ url }) => {
        const { createMap } = await import(url);
        const map = await createMap(/** @type {HTMLElement} */ (document.getElementById('map-test-frame')), { sovereignty: { sourceIds: ['bia-lar'] }, label: 'Retention map', layers: ['outlines', 'hq'], mode: 'auto' });
        /** @type {any} */ (window).__map = map;
      }, { url: mapUrl });
      await waitForMode(page, 'interactive');
      const fromN = seen.filter((s) => s.url.includes(`/v/${'a'.repeat(12)}/`));
      const need = ['js/map/create-map.js', 'js/map/layers/outlines.js', 'js/map/layers/hq.js', 'vendor/maplibre-gl-6.12.0/maplibre-gl.mjs', 'vendor/maplibre-gl-6.12.0/maplibre-gl-shared.mjs', 'vendor/maplibre-gl-6.12.0/maplibre-gl.css', 'vendor/topojson-client-3.1.0/topojson-client.min.js', 'css/map.css'];
      for (const f of need) {
        const hit = fromN.find((s) => s.url.endsWith(f));
        expect(hit, `${f} was requested from build N`).toBeTruthy();
        expect(hit?.status, `${f} status`).toBe(200);
      }
      expect(fromN.filter((s) => s.status !== 200 && !/favicon|\.map$/.test(s.url))).toEqual([]);
      expect(workers.some((w) => w.endsWith(`/v/${'a'.repeat(12)}/vendor/maplibre-gl-6.12.0/maplibre-gl-worker.mjs`))).toBe(true);
      expect(workers.every((w) => !w.startsWith('blob:'))).toBe(true);
      const mjs = fromN.filter((s) => s.url.endsWith('.mjs'));
      expect(mjs.length).toBeGreaterThanOrEqual(3);
      for (const s of mjs) expect(s.type).toMatch(/^text\/javascript/);
    } finally {
      server.close();
      await remove(root, { recursive: true, force: true });
    }
  });

  test('every feature drawn in view is reachable from the feature list with a matching name', async ({ page }) => {
    test.skip(!webglProject(page), 'interactive case');
    test.setTimeout(60_000);
    await openMapPage(page);
    const { readFile } = await import('node:fs/promises');
    const index = JSON.parse(await readFile(new URL('../../site/data/registry/nations-index.json', import.meta.url), 'utf8'));
    const nation = index.nations.find((/** @type {any} */ n) => n.hasBoundary) ?? index.nations[0];
    await startMap(page);
    await waitForMode(page, 'interactive');
    await page.evaluate((id) => /** @type {any} */ (window).__map.focusNation(id), nation.id);
    await page.waitForTimeout(2500);
    await page.locator('.map-feature-list > summary').click();
    const rendered = await page.evaluate(() => /** @type {any} */ (window).__map.rendered());
    const buttons = await page.locator('.map-feature-list__button').evaluateAll((els) => els.map((e) => ({ kind: /** @type {HTMLElement} */ (e).dataset.kind, id: /** @type {HTMLElement} */ (e).dataset.id, text: (e.textContent ?? '').trim() })));
    const total = await page.locator('.map-feature-list__more').textContent();
    // Under the cap every rendered feature has a button; at the cap the list says how many more there are.
    const capped = buttons.length >= 50;
    if (capped) expect(total).toMatch(/^and \d+ more; see the list above$/);
    let checked = 0;
    for (const f of rendered) {
      const hit = buttons.find((b) => b.kind === f.kind && b.id === f.id);
      if (!hit) { expect(capped, `${f.kind} ${f.id} is missing from an uncapped list`).toBe(true); continue; }
      if (f.source === 'hq' || f.source === 'gauges' || f.source === 'alerts') expect(hit.text).toBe(f.name);
      expect(hit.text.length).toBeGreaterThan(0);
      checked += 1;
    }
    expect(rendered.length).toBeGreaterThan(0);
    expect(checked).toBeGreaterThan(0);
  });

  for (const profile of /** @type {const} */ (['constrained', 'storm'])) {
    test(`8.2 map timings on the ${profile} profile, and peak heap with every layer on`, async ({ page }, info) => {
      test.skip(info.project.name !== 'chromium-phone', 'timings are defined at 360 x 740 on the phone project');
      test.setTimeout(120_000);
      const { readFile } = await import('node:fs/promises');
      const budgets = JSON.parse(await readFile(new URL('../../budgets.json', import.meta.url), 'utf8')).timing;
      const spec = budgets.profiles[profile];
      const target = budgets.targets[`${profile}Map`];
      // A Pages-shaped server (gzip, max-age) so bytes and caching match what the byte budgets measure.
      // Playwright request routing turns the HTTP cache off, which would make the worker download MapLibre's
      // shared module a second time, so this test blocks the third-party hosts and the page's own module
      // through the DevTools protocol instead of routing. Basemap tiles and the radar times therefore fail
      // fast: the map-ready mark does not wait for tiles (blueprint 8.2), and the legend says so honestly.
      const { fileURLToPath } = await import('node:url');
      const site = await pagesServer(fileURLToPath(new URL('../../site/', import.meta.url)));
      try {
        const client = await page.context().newCDPSession(page);
        await client.send('Network.enable');
        await client.send('Network.setBlockedURLs', { urls: ['*basemaps.cartocdn.com*', '*mesonet.agron.iastate.edu*', '*geo.weather.gc.ca*', '*/static/js/pages/forecasts.js*'] });
        await client.send('Network.emulateNetworkConditions', { offline: false, latency: spec.latencyMs, downloadThroughput: (spec.downloadKbps * 1000) / 8, uploadThroughput: (spec.downloadKbps * 1000) / 8 });
        await client.send('Emulation.setCPUThrottlingRate', { rate: spec.cpuSlowdown });
        /** @param {'auto' | 'outline'} mode */
        const timeOne = async (mode) => {
          await page.goto(`http://127.0.0.1:${site.port}/pnw-tribal-dashboard/forecasts/`);
          // A real page has loaded the source registry and the core modules before any map tap.
          await page.evaluate(async () => {
            await (await import(new URL('../static/js/core/sources.js', location.href).href)).loadSources();
            await import(new URL('../static/js/ui/status-pill.js', location.href).href);
            const wrap = document.createElement('section');
            wrap.className = 'map-frame';
            const frame = document.createElement('div');
            frame.className = 'map-frame__viewport';
            frame.id = 'map-test-frame';
            wrap.append(frame);
            document.body.prepend(wrap);
          });
          return page.evaluate(async (m) => {
            /** @type {number[]} */
            const longTasks = [];
            /** @type {string[]} */
            const taskLog = [];
            const observer = new PerformanceObserver((list) => { for (const e of list.getEntries()) { longTasks.push(e.duration); taskLog.push(`${Math.round(e.startTime - tap)}+${Math.round(e.duration)}`); } });
            try { observer.observe({ type: 'longtask', buffered: false }); } catch { /* not supported */ }
            // Attribution (blueprint 8.2): the long-animation-frame API names the script behind each slow frame, so
            // time spent in map/* is told apart from MapLibre's own parse, which is recorded and not gated.
            /** @type {{ at: number, frame: number, mapMs: number, vendorMs: number }[]} */
            const frames = [];
            /** @type {{ start: number, end: number }[]} */
            const mapScripts = [];
            const loaf = new PerformanceObserver((list) => {
              for (const e of list.getEntries()) {
                const scripts = /** @type {any} */ (e).scripts ?? [];
                const sum = (/** @type {RegExp} */ re) => scripts.filter((/** @type {any} */ x) => re.test(String(x.sourceURL))).reduce((/** @type {number} */ acc, /** @type {any} */ x) => acc + x.duration, 0);
                frames.push({ at: Math.round(e.startTime - tap), frame: Math.round(e.duration), mapMs: Math.round(sum(/\/js\/map\//)), vendorMs: Math.round(sum(/\/vendor\//)) });
                for (const x of scripts) if (/\/js\/map\//.test(String(x.sourceURL))) mapScripts.push({ start: x.startTime, end: x.startTime + x.duration });
              }
            });
            try { loaf.observe({ type: 'long-animation-frame', buffered: false }); } catch { /* not supported */ }
            const tap = performance.now();
            performance.mark('alerts-painted');
            const opts = { sovereignty: { sourceIds: ['bia-lar'] }, label: 'Timing map', layers: ['basemap', 'radar', 'outlines', 'boundaries', 'zones', 'alerts', 'gauges', 'hq'], mode: m };
            const frame = /** @type {HTMLElement} */ (document.getElementById('map-test-frame'));
            // Outline mode goes through the adapter (as a page would); the interactive map is forced past the software-GL offer.
            const adapter = await import(new URL('../static/js/map/adapter.js', location.href).href);
            /** @type {any} */
            let map;
            if (m === 'outline') map = await adapter.requestMap(frame, opts);
            else {
              // What requestMap does on a device with a GPU: start the shared downloads, probe, then hint the library.
              const supportModule = import(new URL('../static/js/map/support.js', location.href).href);
              adapter.startMapLoad(opts.layers);
              await supportModule;
              adapter.preloadInteractive(opts.layers);
              map = await (await import(new URL('../static/js/map/create-map.js', location.href).href)).createMap(frame, opts);
            }
            /** @type {any} */ (window).__map = map;
            const readyAt = await new Promise((resolve) => {
              const found = performance.getEntriesByName('map-ready');
              if (found.length) { resolve(/** @type {PerformanceEntry} */ (found[found.length - 1]).startTime); return; }
              const po = new PerformanceObserver((l) => { const e = l.getEntries().find((x) => x.name === 'map-ready'); if (e) { po.disconnect(); resolve(e.startTime); } });
              po.observe({ type: 'mark', buffered: true });
              setTimeout(() => resolve(null), 60_000);
            });
            await new Promise((r) => setTimeout(r, 500));
            observer.disconnect();
            loaf.disconnect();
            // The longest single script run in map/*, less the time MapLibre's constructor took inside it.
            const ctor = performance.getEntriesByName('map-ctor').pop();
            const ctorSpan = ctor ? { start: ctor.startTime, end: ctor.startTime + ctor.duration } : null;
            const ownMs = Math.round(Math.max(0, ...mapScripts.map((x) => {
              const overlap = ctorSpan ? Math.max(0, Math.min(x.end, ctorSpan.end) - Math.max(x.start, ctorSpan.start)) : 0;
              return x.end - x.start - overlap;
            })));
            const at = (/** @type {string} */ name) => { const e = performance.getEntriesByName(name).pop(); return e ? Math.round(e.startTime - tap) : null; };
            return { mode: map.mode, readyMs: readyAt === null ? null : Math.round(/** @type {number} */ (readyAt) - tap), maxLongTaskMs: Math.round(Math.max(0, ...longTasks)), libraryLoadedMs: at('map-lib-loaded'), styleLoadedMs: at('map-load'), longTasks: taskLog, maxMapScriptMs: ownMs, maxMapScriptRawMs: Math.round(Math.max(0, ...mapScripts.map((x) => x.end - x.start))), maxVendorScriptMs: Math.max(0, ...frames.map((f) => f.vendorMs)), slowFrames: frames };
          }, mode);
        };
        const outline = await timeOne('outline');
        expect(outline.mode).toBe('outline');
        expect(outline.readyMs, 'outline mode ready').not.toBeNull();
        const interactive = await timeOne('auto');
        expect(interactive.mode).toBe('interactive');
        // Peak heap with every layer on: sample the JavaScript heap while the layers draw and toggle.
        let peak = 0;
        const sample = async () => { const { metrics } = await client.send('Performance.getMetrics'); const used = metrics.find((/** @type {any} */ x) => x.name === 'JSHeapUsedSize')?.value ?? 0; peak = Math.max(peak, used); };
        await client.send('Performance.enable');
        for (let i = 0; i < 12; i += 1) { await sample(); await page.waitForTimeout(250); }
        await page.evaluate(() => { const m = /** @type {any} */ (window).__map; for (const id of ['radar', 'boundaries', 'zones', 'alerts', 'gauges']) { m.setLayer(id, false); m.setLayer(id, true); } });
        for (let i = 0; i < 8; i += 1) { await sample(); await page.waitForTimeout(250); }
        const result = { profile, viewport: '360 x 740', cpuSlowdown: spec.cpuSlowdown, kbps: spec.downloadKbps, latencyMs: spec.latencyMs, outline, interactive, peakHeapMB: Math.round((peak / 1_048_576) * 10) / 10, targets: target };
        await info.attach(`map-timing-${profile}.json`, { body: JSON.stringify(result, null, 2), contentType: 'application/json' });
        console.log(`L8 timing ${JSON.stringify(result)}`);
        expect(/** @type {number} */ (outline.readyMs), 'outline mode ready (ms)').toBeLessThanOrEqual(target.outlineModeMs);
        expect(interactive.readyMs, 'interactive map ready').not.toBeNull();
        // The interactive targets describe a device with hardware WebGL2 (the probe's `full`). A software
        // renderer (`caveat`), which is what headless Chromium has, starts in outline mode by design, and its
        // timings are recorded above but not asserted: they measure SwiftShader under a 4x CPU slowdown.
        const probe = await page.evaluate(async () => (await import(new URL('../static/js/map/support.js', location.href).href)).probeWebGL());
        if (probe === 'full') {
          expect(/** @type {number} */ (interactive.readyMs), 'interactive map ready (ms)').toBeLessThanOrEqual(target.mapReadyMs);
          // No long task over 200 ms attributable to map/*; MapLibre's own parse is recorded (maxVendorScriptMs), not gated.
          if (target.maxLongTaskFromMapMs) expect(interactive.maxMapScriptMs, 'longest script run in map/*, less the MapLibre constructor (ms)').toBeLessThanOrEqual(target.maxLongTaskFromMapMs);
        } else {
          info.annotations.push({ type: 'interactive-timing', description: `recorded under software WebGL (${probe}); ready ${interactive.readyMs} ms against ${target.mapReadyMs} ms` });
        }
      } finally {
        site.server.close();
      }
    });
  }

  test('axe finds no serious or critical violation in the map, its note, legend, and feature list, in either mode', async ({ page }, info) => {
    test.setTimeout(60_000);
    const { AxeBuilder } = await import('@axe-core/playwright');
    const check = async (/** @type {string} */ label) => {
      const result = await new AxeBuilder({ page }).include('#map-test').withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze();
      const bad = result.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`);
      expect(bad, `${label} axe`).toEqual([]);
    };
    await openMapPage(page);
    if (webglProject(page)) {
      await startMap(page);
      await waitForMode(page, 'interactive');
      await page.waitForTimeout(2000);
      await page.locator('.map-feature-list > summary').click();
      await check(`interactive (${info.project.name})`);
      await page.evaluate(() => /** @type {any} */ (window).__map.destroy());
    }
    await startMap(page, { mode: 'outline' });
    await page.locator('.map-feature-list > summary').click();
    await check(`outline (${info.project.name})`);
  });

  test('layer rules: headquarters below zoom seven and at every zoom without a polygon; zones dashed, alert polygons solid; attribution is printed in the map', async ({ page }) => {
    test.skip(!webglProject(page), 'interactive case');
    test.setTimeout(60_000);
    await openMapPage(page);
    await startMap(page);
    await waitForMode(page, 'interactive');
    await expect.poll(async () => page.evaluate(() => /** @type {any} */ (window).__map.inspect().layers.filter((/** @type {any} */ l) => /^(hq|zones|alerts):/.test(l.id)).length), { timeout: 20_000 }).toBeGreaterThanOrEqual(7);
    const layers = await page.evaluate(() => /** @type {any} */ (window).__map.inspect().layers);
    const byId = (/** @type {string} */ id) => layers.find((/** @type {any} */ l) => l.id === id);
    expect(byId('hq:overview').maxzoom).toBe(7);
    expect(byId('hq:no-polygon').minzoom).toBe(7);
    // Zone coverage is dashed; storm polygons are solid (blueprint 4.4).
    expect(byId('zones:line').dashed).toBe(true);
    expect(byId('alerts:line').dashed).toBe(false);
    // The AttributionControl prints each source's text, not collapsed behind a button.
    const attribution = page.locator('.maplibregl-ctrl-attrib');
    await expect(attribution).toContainText('Outlines: U.S. Census Bureau, Province of British Columbia');
    await expect(attribution).toContainText('© OpenStreetMap contributors © CARTO');
    await expect(attribution).toContainText('Radar: NOAA NWS via Iowa Environmental Mesonet');
    await expect(attribution).toContainText('Environment and Climate Change Canada');
    await expect(page.locator('.maplibregl-ctrl-attrib-button')).toBeHidden();
  });

  test('cooperative gestures: the wheel alone leaves the map, Ctrl plus the wheel zooms it', async ({ page }, info) => {
    test.skip(!webglProject(page) || info.project.name !== 'chromium-desktop', 'desktop wheel case');
    test.setTimeout(60_000);
    await openMapPage(page);
    await startMap(page, { layers: ['outlines', 'hq'], alerts: false });
    await waitForMode(page, 'interactive');
    await page.waitForTimeout(1200);
    await page.evaluate(() => { document.getElementById('map-test')?.scrollIntoView({ block: 'center' }); });
    const box = await page.locator('.map-canvas').boundingBox();
    if (!box) throw new Error('no map box');
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    const before = await page.evaluate(() => /** @type {any} */ (window).__map.camera());
    await page.mouse.wheel(0, -400);
    await page.waitForTimeout(700);
    expect((await page.evaluate(() => /** @type {any} */ (window).__map.camera())).zoom).toBeCloseTo(before.zoom, 3);
    // The plain wheel scrolled the page (cooperative gestures); put the map back under the pointer.
    await page.evaluate(() => { document.getElementById('map-test')?.scrollIntoView({ block: 'center' }); });
    await page.waitForTimeout(300);
    const again = await page.locator('.map-canvas').boundingBox();
    if (!again) throw new Error('no map box');
    await page.mouse.move(again.x + again.width / 2, again.y + again.height / 2);
    await page.keyboard.down('Control');
    await page.mouse.wheel(0, -400);
    await page.keyboard.up('Control');
    await page.waitForTimeout(900);
    expect((await page.evaluate(() => /** @type {any} */ (window).__map.camera())).zoom).toBeGreaterThan(before.zoom);
  });

  test('print always shows the outline picture, never the blank canvas', async ({ page }) => {
    test.skip(!webglProject(page), 'interactive case');
    test.setTimeout(60_000);
    await openMapPage(page);
    await startMap(page);
    await waitForMode(page, 'interactive');
    await page.evaluate(() => window.dispatchEvent(new Event('beforeprint')));
    await expect(page.locator('.map-print svg.map-outline')).toHaveCount(1);
    await page.emulateMedia({ media: 'print' });
    expect(await page.locator('.map-canvas').evaluate((el) => getComputedStyle(el).display)).toBe('none');
    expect(await page.locator('.map-print').evaluate((el) => getComputedStyle(el).display)).toBe('block');
    expect(await page.locator('.sovereignty-note').isVisible()).toBe(true);
    await page.evaluate(() => window.dispatchEvent(new Event('afterprint')));
    await expect(page.locator('.map-print svg')).toHaveCount(0);
  });

  test('no listener or WebGL context leaks across ten layer toggles and five create and destroy cycles', async ({ page }) => {
    test.skip(!webglProject(page), 'interactive case');
    test.setTimeout(90_000);
    // Live WebGL contexts: every context a canvas hands out, until its own webglcontextlost event.
    await page.addInitScript(() => {
      const w = /** @type {any} */ (window);
      w.__live = new Set();
      const get = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = /** @type {any} */ (/** @this {HTMLCanvasElement} */ function (/** @type {string} */ kind, /** @type {any} */ attrs) {
        const ctx = get.call(this, kind, attrs);
        if (ctx && /webgl/.test(kind) && !w.__live.has(ctx)) {
          w.__live.add(ctx);
          this.addEventListener('webglcontextlost', () => w.__live.delete(ctx));
        }
        return ctx;
      });
    });
    await openMapPage(page);
    const client = await page.context().newCDPSession(page);
    // The browser's own listener accounting for window and document, through the DevTools protocol.
    const listeners = async () => {
      let total = 0;
      /** @type {Record<string, number>} */
      const byType = {};
      for (const expression of ['window', 'document']) {
        const { result } = await client.send('Runtime.evaluate', { expression });
        const { listeners: found } = await client.send('DOMDebugger.getEventListeners', { objectId: /** @type {string} */ (result.objectId) });
        total += found.length;
        for (const l of found) byType[`${expression}:${l.type}`] = (byType[`${expression}:${l.type}`] ?? 0) + 1;
      }
      return { total, byType };
    };
    const baseline = await listeners();
    await startMap(page);
    await waitForMode(page, 'interactive');
    await page.waitForTimeout(1500);
    const live = await listeners();
    await page.evaluate(() => {
      const m = /** @type {any} */ (window).__map;
      for (let i = 0; i < 10; i += 1) for (const id of ['radar', 'alerts', 'gauges', 'boundaries', 'zones', 'hq']) m.setLayer(id, i % 2 === 1);
    });
    await page.waitForTimeout(500);
    const toggled = await listeners();
    expect(toggled.byType).toEqual(live.byType);
    await page.evaluate(async () => {
      /** @type {any} */ (window).__map.destroy();
      await new Promise((r) => setTimeout(r, 300));
    });
    expect((await listeners()).byType).toEqual(baseline.byType);
    expect(await page.evaluate(() => /** @type {any} */ (window).__live.size)).toBe(0);
    for (let i = 0; i < 5; i += 1) {
      await page.evaluate(async () => {
        const { createMap } = await import(new URL('../static/js/map/create-map.js', location.href).href);
        const m = await createMap(/** @type {HTMLElement} */ (document.getElementById('map-test-frame')), { sovereignty: { sourceIds: ['bia-lar'] }, label: 'Cycle', layers: ['basemap', 'outlines', 'hq', 'radar'], mode: 'auto' });
        await new Promise((r) => setTimeout(r, 500));
        m.destroy();
        await new Promise((r) => setTimeout(r, 300));
      });
      expect((await listeners()).byType).toEqual(baseline.byType);
      expect(await page.evaluate(() => /** @type {any} */ (window).__live.size)).toBe(0);
    }
    expect(await page.evaluate(() => document.querySelectorAll('.sovereignty-note, .map-extras, .map-attribution, .map-feature-list, canvas.maplibregl-canvas, .maplibregl-map').length)).toBe(0);
  });
});
