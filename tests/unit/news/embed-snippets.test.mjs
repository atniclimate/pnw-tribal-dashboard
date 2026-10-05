// @ts-check
/**
 * Lane L14 acceptance for the embed generator (blueprint 1.4, 1.5, 7.10): the snippets are exactly the shape
 * the blueprint specifies, one per page and view, and the "All Snippets" table on the page is produced by the
 * same function as the generator output. There is no separate embedding document (lean repository ruling);
 * this page is the reference.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { DASHBOARD_PANELS, PAGES } from '../../../site/static/js/config/pages.js';
import {
  EMBED_SCRIPT_URL, HEIGHT_MAX, HEIGHT_MIN, NATION_PAGES, PANEL_HEIGHTS, PUBLISHED_BASE, attr, buildSnippet, clampHeight,
  embeddablePages, previewAddress, referenceRows, resolveNation,
} from '../../../site/static/js/pages/embed.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** Blueprint 1.2 default embed heights, copied from the route table. */
const ROUTE_HEIGHTS = /** @type {Record<string, number>} */ ({
  dashboard: 1500, alerts: 1200, forecasts: 1300, contacts: 1200, resources: 1100, safety: 1100, news: 1100, usage: 900,
  archive: 900, 'archive-event': 1100,
});
/** Blueprint 1.2 `view` values by route. */
const ROUTE_VIEWS = /** @type {Record<string, string[]>} */ ({
  alerts: ['list', 'map', 'declarations'],
  forecasts: ['local', 'precip', 'ar', 'satellite', 'radar', 'rivers'],
  contacts: ['directory', 'near-me'],
  usage: ['usage', 'sources', 'status', 'privacy', 'accessibility'],
});

/** Blueprint 1.5, verbatim apart from the HTML-escaped ampersands the generator writes. */
const BLUEPRINT_ALERTS = `<iframe data-cthd
  src="https://atniclimate.github.io/pnw-tribal-dashboard/alerts/?embed=1"
  title="Cascadia Tribal Hazard Dashboard: Active Alerts"
  style="width:100%;height:1200px;border:0;display:block;"
  loading="eager"
  referrerpolicy="strict-origin-when-cross-origin"></iframe>
<script src="https://atniclimate.github.io/pnw-tribal-dashboard/embed.js" defer></script>`;

describe('the snippet', () => {
  test('equals the blueprint 1.5 example for the Alerts page, character for character', () => {
    assert.equal(buildSnippet({ page: 'alerts' }).code, BLUEPRINT_ALERTS);
  });

  test('points at the published address and the host helper', () => {
    assert.equal(PUBLISHED_BASE, 'https://atniclimate.github.io/pnw-tribal-dashboard/');
    assert.equal(EMBED_SCRIPT_URL, 'https://atniclimate.github.io/pnw-tribal-dashboard/embed.js');
  });

  test('the script line is optional: leaving auto-height off drops it and nothing else', () => {
    const on = buildSnippet({ page: 'resources' });
    const off = buildSnippet({ page: 'resources', autoHeight: false });
    assert.equal(on.code, `${off.code}\n<script src="${EMBED_SCRIPT_URL}" defer></script>`);
    assert.equal(off.autoHeight, false);
  });

  test('a Nation adds n=<id>; a view adds view=<view>; keys sit in sorted order (blueprint 1.5)', () => {
    const s = buildSnippet({ page: 'alerts', view: 'declarations', n: 'us-wa-lummi-nation' });
    assert.equal(s.src, `${PUBLISHED_BASE}alerts/?embed=1&n=us-wa-lummi-nation&view=declarations`);
    assert.match(s.code, /src="[^"]*\?embed=1&amp;n=us-wa-lummi-nation&amp;view=declarations"/);
    assert.equal(s.title, 'Cascadia Tribal Hazard Dashboard: Active Alerts, Declarations');
  });

  test('Contacts and Near Me carry allow="geolocation" when asked', () => {
    const s = buildSnippet({ page: 'contacts', view: 'near-me', geolocation: true });
    assert.match(s.code, /\n {2}allow="geolocation"\n/);
    assert.doesNotMatch(buildSnippet({ page: 'contacts' }).code, /allow=/);
  });

  test('lazy loading changes only the loading attribute', () => {
    const eager = buildSnippet({ page: 'forecasts', view: 'radar' }).code;
    const lazy = buildSnippet({ page: 'forecasts', view: 'radar', lazy: true }).code;
    assert.equal(lazy, eager.replace('loading="eager"', 'loading="lazy"'));
  });

  test('the Dashboard header strip is /?embed=1&panel=banner at 96 px with no helper script', () => {
    const s = buildSnippet({ page: 'dashboard', panel: 'banner' });
    assert.equal(s.src, `${PUBLISHED_BASE}?embed=1&panel=banner`);
    assert.equal(s.height, 96);
    assert.match(s.code, /height:96px;/);
    assert.doesNotMatch(s.code, /<script/);
    assert.ok(s.notes.some((n) => /320 pixels/.test(n)));
  });

  test('every Dashboard panel has a starting height, and only the Dashboard takes panel=', () => {
    assert.deepEqual(Object.keys(PANEL_HEIGHTS).sort(), [...DASHBOARD_PANELS].sort());
    const ignored = buildSnippet({ page: 'alerts', panel: 'banner' });
    assert.doesNotMatch(ignored.src, /panel=/);
    assert.ok(ignored.notes.some((n) => /only for the Dashboard/.test(n)));
  });

  test('options that do not apply are left out and explained, never written', () => {
    const a = buildSnippet({ page: 'news', n: 'us-wa-lummi-nation' });
    assert.doesNotMatch(a.src, /[?&]n=/);
    assert.ok(a.notes.some((n) => /does not take a Nation/.test(n)));
    const b = buildSnippet({ page: 'alerts', n: 'not an id' });
    assert.doesNotMatch(b.src, /[?&]n=/);
    assert.ok(b.notes.some((n) => /not in the form/.test(n)));
    const c = buildSnippet({ page: 'safety', view: 'list' });
    assert.doesNotMatch(c.src, /view=/);
    assert.ok(c.notes.length > 0);
  });

  test('height is a whole number inside the allowed range', () => {
    assert.equal(buildSnippet({ page: 'news', height: 1234.6 }).height, 1235);
    assert.equal(buildSnippet({ page: 'news', height: 5 }).height, HEIGHT_MIN);
    assert.equal(buildSnippet({ page: 'news', height: 90000 }).height, HEIGHT_MAX);
    assert.equal(buildSnippet({ page: 'news', height: Number.NaN }).height, ROUTE_HEIGHTS.news);
  });

  test('the embed page itself and the classic fallback are not embeddable', () => {
    assert.throws(() => buildSnippet({ page: 'embed' }), /not an embeddable page/);
    assert.throws(() => buildSnippet({ page: 'classic' }), /not an embeddable page/);
    assert.throws(() => buildSnippet({ page: 'nope' }), /not an embeddable page/);
  });

  test('attribute values are escaped', () => {
    assert.equal(attr('a&b "c" <d>'), 'a&amp;b &quot;c&quot; &lt;d&gt;');
  });
});

describe('what a Squarespace Code Block needs', () => {
  const rows = referenceRows();

  test('every snippet is plain ASCII with straight quotes, one iframe, and at most one script', () => {
    for (const r of rows) {
      const code = r.snippet.code;
      assert.match(code, /^[\x20-\x7E\n]+$/, `${r.key} has a character outside printable ASCII`);
      assert.equal((code.match(/<iframe/g) ?? []).length, 1, r.key);
      assert.equal((code.match(/<\/iframe>/g) ?? []).length, 1, r.key);
      assert.ok((code.match(/<script/g) ?? []).length <= 1, r.key);
      assert.doesNotMatch(code, /<style|javascript:|on[a-z]+=|srcdoc|<html|<body|<!doctype/i, r.key);
      // Every ampersand in an attribute is an escaped one, so a Code Block parses it the same way a browser does.
      assert.doesNotMatch(code.replace(/&amp;/g, ''), /&/, r.key);
    }
  });

  test('every iframe has a title, the data-cthd marker the helper looks for, https only, and the strict referrer policy', () => {
    for (const r of rows) {
      const code = r.snippet.code;
      assert.match(code, /^<iframe data-cthd\n/, r.key);
      assert.match(code, /\n {2}title="Cascadia Tribal Hazard Dashboard: [^"]+"\n/, r.key);
      assert.match(code, /\n {2}src="https:\/\/atniclimate\.github\.io\/pnw-tribal-dashboard\/[^"]*\?embed=1[^"]*"\n/, r.key);
      assert.match(code, /\n {2}style="width:100%;height:\d+px;border:0;display:block;"\n/, r.key);
      assert.match(code, /\n {2}referrerpolicy="strict-origin-when-cross-origin"><\/iframe>/, r.key);
      assert.doesNotMatch(code, /http:\/\//, r.key);
    }
  });

  test('the only script a snippet loads is the dashboard host helper', () => {
    for (const r of rows) {
      const scripts = r.snippet.code.match(/<script[^>]*>/g) ?? [];
      for (const s of scripts) assert.equal(s, `<script src="${EMBED_SCRIPT_URL}" defer>`, r.key);
    }
  });
});

describe('one snippet per page and view', () => {
  const rows = referenceRows();

  test('every embeddable page is covered and the page list matches blueprint 1.2', () => {
    assert.deepEqual(embeddablePages().map((p) => p.id), Object.keys(ROUTE_HEIGHTS));
    for (const p of PAGES) assert.equal(p.embeddable, p.id in ROUTE_HEIGHTS, p.id);
    for (const id of Object.keys(ROUTE_HEIGHTS)) assert.ok(rows.some((r) => r.pageId === id), `${id} has a row`);
  });

  test('pages with views have one row per view; pages without have one row; the Dashboard adds one row per panel', () => {
    for (const [id, views] of Object.entries(ROUTE_VIEWS)) {
      assert.deepEqual(rows.filter((r) => r.pageId === id).map((r) => r.options.view), views, id);
    }
    for (const id of ['resources', 'safety', 'news', 'archive', 'archive-event']) assert.equal(rows.filter((r) => r.pageId === id).length, 1, id);
    const dash = rows.filter((r) => r.pageId === 'dashboard');
    assert.equal(dash.length, 1 + DASHBOARD_PANELS.length);
    assert.deepEqual(dash.slice(1).map((r) => r.options.panel), [...DASHBOARD_PANELS]);
    assert.equal(new Set(rows.map((r) => r.key)).size, rows.length, 'row keys are unique');
    assert.equal(new Set(rows.map((r) => r.snippet.src)).size, rows.length, 'no two rows share an address');
  });

  test('default heights are the blueprint 1.2 route table (the header strip is 96 px)', () => {
    for (const r of rows) {
      const want = r.options.panel ? PANEL_HEIGHTS[r.options.panel] : ROUTE_HEIGHTS[r.pageId];
      assert.equal(r.snippet.height, want, r.key);
    }
    assert.equal(PANEL_HEIGHTS.banner, 96);
  });

  test('the table row for a page and view equals what the generator writes for the same choices', () => {
    for (const r of rows) {
      assert.equal(buildSnippet({ ...r.options, geolocation: r.pageId === 'contacts' }).code, r.snippet.code, r.key);
    }
  });

  test('Nation scope is offered only where the route table lists n', () => {
    assert.deepEqual([...NATION_PAGES].sort(), ['alerts', 'contacts', 'dashboard', 'forecasts', 'resources']);
    for (const p of embeddablePages()) {
      const s = buildSnippet({ page: p.id, n: 'us-wa-lummi-nation' });
      assert.equal(/[?&]n=/.test(s.src), NATION_PAGES.includes(p.id), p.id);
    }
  });

  test('Contacts rows carry the location permission by default; no other row does', () => {
    for (const r of rows) assert.equal(/allow="geolocation"/.test(r.snippet.code), r.pageId === 'contacts', r.key);
  });

  test('the Dashboard snippet in the page for visitors without JavaScript equals the generated one', async () => {
    const html = await readFile(path.join(ROOT, 'site', 'embed', 'index.html'), 'utf8');
    const m = /<noscript>[\s\S]*?<pre><code>([\s\S]*?)<\/code><\/pre><\/noscript>/.exec(html);
    assert.ok(m, 'the static snippet is present');
    const decoded = /** @type {string} */ (m[1]).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
    assert.equal(decoded, buildSnippet({ page: 'dashboard' }).code);
  });
});

describe('preview and helpers', () => {
  test('the preview loads the same page and query from this copy of the site', () => {
    const s = buildSnippet({ page: 'alerts', view: 'map', n: 'us-wa-lummi-nation' });
    assert.equal(previewAddress(s), '../alerts/?embed=1&n=us-wa-lummi-nation&view=map');
    assert.equal(previewAddress(buildSnippet({ page: 'dashboard' })), '../?embed=1');
    for (const r of referenceRows()) assert.doesNotMatch(previewAddress(r.snippet), /^https?:/);
  });

  test('clampHeight mirrors site/embed.js (320 to 6000)', () => {
    assert.equal(clampHeight(100), 320);
    assert.equal(clampHeight(1500.4), 1500);
    assert.equal(clampHeight(99999), 6000);
    assert.equal(clampHeight('abc'), 320);
    assert.equal(clampHeight(undefined), 320);
  });

  test('resolveNation accepts an id, an exact name, an alias, and says when it cannot (test inputs)', () => {
    const list = [{ id: 'us-wa-test-nation', name: 'Test Nation', preferredName: 'Test', aliases: ['The Test People'] }];
    assert.deepEqual(resolveNation('', list), { id: null, empty: true });
    assert.deepEqual(resolveNation('us-wa-other-nation', list), { id: 'us-wa-other-nation', empty: false });
    assert.deepEqual(resolveNation('  test nation ', list), { id: 'us-wa-test-nation', empty: false });
    assert.deepEqual(resolveNation('the test people', list), { id: 'us-wa-test-nation', empty: false });
    assert.deepEqual(resolveNation('Nobody', list), { id: null, empty: false });
  });
});
