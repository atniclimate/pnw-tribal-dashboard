// @ts-check
/* global document */
/**
 * Lane L7 river components: view models in Node, then the rendered DOM in Chromium (served from a throwaway
 * static server; skipped when no browser can launch). Fixtures are built from the committed reference file.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { associateNations } from '../../../scripts/reference/60-gauges.mjs';
import { buildGaugeDetailModel } from '../../../site/static/js/ui/gauge-detail.js';
import { buildGaugeListModel, floodToken, readingText } from '../../../site/static/js/ui/gauge-list.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const ref = JSON.parse(readFileSync(path.join(ROOT, 'site/data/ref/gauges.json'), 'utf8'));
const wsc = JSON.parse(readFileSync(path.join(ROOT, 'site/data/ref/wsc-stations.json'), 'utf8'));
const NOW = new Date('2026-10-05T18:00:00Z');
const FRESH = '2026-10-05T17:30:00Z';
const OLD = '2026-10-05T09:00:00Z';

/** @param {string} id @param {Partial<Record<string, unknown>>} [over] */
function gauge(id, over = {}) {
  const base = ref.gauges.find((/** @type {{ id: string }} */ g) => g.id === id);
  assert.ok(base, `reference gauge ${id}`);
  return { ...base, ...over };
}
/** @param {string} id @param {string} category @param {string} validTime @param {number | null} stage @returns {any} */
const status = (id, category, validTime, stage) => ({
  id, observed: { stage, unit: 'ft', flow: null, flowUnit: null, category, validTime }, forecast: null,
});

const crnw1 = gauge('nwps:CRNW1');
const forecastPoint = ref.gauges.find((/** @type {{ isForecastPoint: boolean, stages: unknown }} */ g) => g.isForecastPoint && g.stages);

describe('gauge list model', () => {
  test('groups by region, ranks by severity, words the NWS category', () => {
    const a = gauge(crnw1.id);
    const b = { ...gauge(crnw1.id), id: 'nwps:TESTB', name: 'Test B', region: 'or' };
    const statuses = new Map([[a.id, status(a.id, 'minor', FRESH, 12)], [b.id, status(b.id, 'no_flooding', FRESH, 3)]]);
    const m = buildGaugeListModel([b, a], statuses, { timeZone: 'America/Los_Angeles', now: NOW });
    assert.deepEqual(m.groups.map((g) => g.region), [a.region, 'or'].sort((x, y) => ['wa', 'or', 'id'].indexOf(x) - ['wa', 'or', 'id'].indexOf(y)));
    const row = m.groups.flatMap((g) => g.rows).find((r) => r.id === a.id);
    assert.equal(row?.label, 'Minor Flood');
    assert.equal(m.counts.minor, 1);
    assert.equal(m.counts.no_flooding, 1);
  });

  test('observations over six hours old read "Observation not current"; null category never reads normal', () => {
    const g = gauge(crnw1.id);
    const stale = buildGaugeListModel([g], new Map([[g.id, status(g.id, 'no_flooding', OLD, 3)]]), { timeZone: 'UTC', now: NOW });
    assert.equal(stale.groups[0]?.rows[0]?.label, 'Observation not current');
    const nd = buildGaugeListModel([g], new Map([[g.id, status(g.id, 'not_defined', FRESH, 3)]]), { timeZone: 'UTC', now: NOW });
    assert.equal(nd.groups[0]?.rows[0]?.label,'No flood categories defined for this gauge');
    assert.ok(!/normal/i.test(JSON.stringify(nd)));
  });

  test('a 0 ft reading is a reading, not missing', () => {
    assert.equal(readingText(status('x', 'no_flooding', FRESH, 0)), '0 ft');
    assert.equal(readingText(null), 'No reading');
  });

  test('At or Above Action Stage keeps only current action-or-higher observations', () => {
    const g1 = gauge(crnw1.id);
    const g2 = { ...g1, id: 'nwps:TESTC', name: 'Test C' };
    const g3 = { ...g1, id: 'nwps:TESTD', name: 'Test D' };
    const statuses = new Map([[g1.id, status(g1.id, 'action', FRESH, 5)], [g2.id, status(g2.id, 'no_flooding', FRESH, 1)], [g3.id, status(g3.id, 'major', OLD, 9)]]);
    const m = buildGaugeListModel([g1, g2, g3], statuses, { timeZone: 'UTC', now: NOW, atOrAboveAction: true });
    assert.deepEqual(m.groups.flatMap((g) => g.rows.map((r) => r.id)), [g1.id]);
    assert.equal(m.total, 3);
  });

  test('British Columbia stations carry no category and a threshold note in detail', () => {
    const s = wsc.stations[0];
    const g = /** @type {any} */ ({ id: s.id, country: 'CA', agency: 'WSC', lid: null, usgsId: null, wscId: s.id.slice(4), name: s.name, river: null, region: 'bc', wfo: null, rfc: null, lat: s.lat, lon: s.lon, timeZone: s.timeZone, stages: null, isForecastPoint: false, hydrographImage: null, links: s.links, nationIds: [], selection: 'auto' });
    const st = /** @type {any} */ ({ id: s.id, observed: { stage: 1.2, unit: 'm', flow: 4.5, flowUnit: 'm3/s', category: null, validTime: FRESH }, forecast: null });
    const list = buildGaugeListModel([g], new Map([[g.id, st]]), { timeZone: s.timeZone, now: NOW });
    assert.equal(list.groups[0]?.rows[0]?.category, null);
    assert.equal(list.groups[0]?.rows[0]?.reading, '1.2 m, 4.5 m3/s');
    const d = buildGaugeDetailModel(/** @type {any} */ (g), /** @type {any} */ (st), { timeZone: s.timeZone, now: NOW });
    assert.match(String(d.thresholdNote), /No official flood thresholds/);
  });

  test('floodToken maps every NWS word to a styled token', () => {
    assert.equal(floodToken('no_flooding'), 'none');
    assert.equal(floodToken('not_defined'), 'not-defined');
    assert.equal(floodToken(null), 'not-defined');
    assert.equal(floodToken('major'), 'major');
  });
});

describe('gauge detail model', () => {
  test('alt text names latest and crest values; table repeats them; null thresholds read Not defined', () => {
    const g = /** @type {any} */ (forecastPoint);
    const st = /** @type {any} */ ({ id: g.id, observed: { stage: 4.5, unit: 'ft', flow: null, flowUnit: null, category: 'action', validTime: FRESH },
      forecast: { stage: null, unit: 'ft', category: 'minor', validTime: FRESH, crestStage: 9.5, crestTime: '2026-10-06T12:00:00Z' } });
    const d = buildGaugeDetailModel(g, st, { timeZone: 'America/Los_Angeles', now: NOW });
    assert.match(d.alt, /latest observed stage 4\.5 ft/);
    assert.match(d.alt, /forecast crest 9\.5 ft/);
    assert.equal(d.tableRows[0]?.value, '4.5 ft');
    assert.equal(d.tableRows[1]?.value, '9.5 ft');
    assert.equal(d.forecastCategory, 'Minor Flood');
    const noStages = buildGaugeDetailModel({ ...g, stages: { ...g.stages, minor: null } }, st, { timeZone: 'UTC', now: NOW });
    assert.equal(noStages.stageRows.find((r) => r.label === 'Minor Flood Stage')?.value, 'Not defined');
  });

  test('CRNW1 shows its 50.7 ft action stage', () => {
    const d = buildGaugeDetailModel(/** @type {any} */ (crnw1), null, { timeZone: 'UTC', now: NOW });
    assert.equal(d.stageRows[0]?.value, '50.7 ft');
  });
});

describe('Nation associations', () => {
  test('proximity within 25 km of a headquarters point; kept override ids; never inferred flow', () => {
    const places = [{ lat: 47.0, lon: -122.0, nationIds: ['us-tribe-keep'] }, { lat: 40, lon: -120, nationIds: [] }];
    const nations = [{ id: 'a', hq: /** @type {[number, number]} */ ([47.1, -122.0]) }, { id: 'b', hq: /** @type {[number, number]} */ ([47.5, -122.0]) }, { id: 'c', hq: null }];
    const out = associateNations(places, nations);
    assert.deepEqual(out[0]?.nationIds, ['a', 'us-tribe-keep']);
    assert.deepEqual(out[1]?.nationIds, []);
  });

  test('the committed reference carries nationIds that exist in the Nation index', () => {
    const idx = JSON.parse(readFileSync(path.join(ROOT, 'site/data/registry/nations-index.json'), 'utf8'));
    const ids = new Set(idx.nations.map((/** @type {{ id: string }} */ n) => n.id));
    let associated = 0;
    for (const r of [...ref.gauges, ...wsc.stations]) {
      for (const id of r.nationIds) { assert.ok(ids.has(id), `${r.id}: ${id}`); associated += 1; }
    }
    assert.ok(associated > 0);
  });
});

describe('rendered DOM (Chromium)', () => {
  /** @type {import('node:http').Server} */
  let server;
  /** @type {import('playwright').Browser | null} */
  let browser = null;
  let port = 0;
  before(async () => {
    server = createServer((req, res) => {
      const rel = decodeURIComponent((req.url ?? '/').split('?')[0] ?? '/');
      if (rel === '/blank') { res.setHeader('content-type', 'text/html'); res.end('<!doctype html><meta charset="utf-8"><title>t</title><div id="root"></div>'); return; }
      try {
        const body = readFileSync(path.join(ROOT, 'site', rel));
        res.setHeader('content-type', rel.endsWith('.js') ? 'text/javascript' : rel.endsWith('.css') ? 'text/css' : 'application/octet-stream');
        res.end(body);
      } catch { res.statusCode = 404; res.end(); }
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', () => r(undefined)));
    port = /** @type {import('node:net').AddressInfo} */ (server.address()).port;
    try { browser = await (await import('playwright')).chromium.launch(); } catch { browser = null; }
  });
  after(async () => { await browser?.close(); await new Promise((r) => server.close(() => r(undefined))); });

  test('list renders, chips filter, the toggle narrows, a click selects', async (t) => {
    if (!browser) return t.skip('no browser available');
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${port}/blank`);
    const result = await page.evaluate(async ({ g, base }) => {
      const mod = await import(`${base}/static/js/ui/gauge-list.js`);
      const root = document.getElementById('root');
      const now = new Date().toISOString();
      const mk = (/** @type {number} */ i, /** @type {string} */ cat) => ({ ...g, id: `nwps:T${i}`, name: `Gauge ${i}` , _cat: cat });
      const gauges = [mk(1, 'major'), mk(2, 'no_flooding'), mk(3, 'action')];
      const statuses = new Map(gauges.map((x) => [x.id, { id: x.id, observed: { stage: 0, unit: 'ft', flow: null, flowUnit: null, category: x._cat, validTime: now }, forecast: null }]));
      /** @type {string[]} */
      const picked = [];
      mod.renderGaugeList(/** @type {HTMLElement} */ (root), gauges, statuses, { timeZone: 'America/Los_Angeles', onSelect: (/** @type {string} */ id) => picked.push(id) });
      const out = {};
      out.rows = document.querySelectorAll('.gauge-card').length;
      out.firstName = document.querySelector('.gauge-card__name')?.textContent;
      out.zero = document.querySelector('.gauge-card__reading')?.textContent;
      /** @type {HTMLElement} */ (document.querySelector('[data-action="chip"][data-key="major"]')).click();
      out.afterChip = document.querySelectorAll('.gauge-card').length;
      out.pressedFocus = document.activeElement?.getAttribute('data-key');
      /** @type {HTMLElement} */ (document.querySelector('[data-action="chip"][data-key="major"]')).click();
      /** @type {HTMLInputElement} */ (document.querySelector('[data-action="toggle-action"]')).click();
      out.afterToggle = document.querySelectorAll('.gauge-card').length;
      /** @type {HTMLElement} */ (document.querySelector('[data-action="select-gauge"]')).click();
      out.picked = picked;
      return out;
    }, { g: crnw1, base: `http://127.0.0.1:${port}` });
    assert.equal(result.rows, 3);
    assert.equal(result.firstName, 'Gauge 1');
    assert.equal(result.zero, '0 ft');
    assert.equal(result.afterChip, 1);
    assert.equal(result.pressedFocus, 'major');
    assert.equal(result.afterToggle, 2);
    assert.deepEqual(result.picked, ['nwps:T1']);
    await page.close();
  });

  test('detail renders the hydrograph image with alt text and a text table', async (t) => {
    if (!browser) return t.skip('no browser available');
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${port}/blank`);
    const out = await page.evaluate(async ({ g, base }) => {
      const mod = await import(`${base}/static/js/ui/gauge-detail.js`);
      const root = /** @type {HTMLElement} */ (document.getElementById('root'));
      const now = new Date().toISOString();
      mod.renderGaugeDetail(root, g, { id: g.id, observed: { stage: 7.25, unit: 'ft', flow: null, flowUnit: null, category: 'no_flooding', validTime: now },
        forecast: { stage: null, unit: 'ft', category: null, validTime: null, crestStage: 8.5, crestTime: now } }, { timeZone: 'America/Los_Angeles' });
      const img = root.querySelector('img');
      return { alt: img?.getAttribute('alt'), w: img?.getAttribute('width'), cells: [...root.querySelectorAll('table')].map((x) => x.textContent), links: root.querySelectorAll('a').length };
    }, { g: crnw1, base: `http://127.0.0.1:${port}` });
    assert.match(String(out.alt), /7\.25 ft/);
    assert.match(String(out.alt), /8\.5 ft/);
    assert.equal(out.w, '600');
    assert.ok(out.cells.some((c) => /50\.7 ft/.test(String(c))));
    assert.ok(out.cells.some((c) => /Forecast Crest/.test(String(c)) && /8\.5 ft/.test(String(c))));
    assert.ok(out.links >= 1);
    await page.close();
  });
});
