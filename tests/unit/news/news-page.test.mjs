// @ts-check
/**
 * Lane L14 acceptance for the client logic of the News and Archive pages (blueprint 7.7, 7.9), and the
 * repository-wide rule that no proxy exists. DOM behavior (focus, hidden toggling, requests) is proved in
 * tests/e2e/pages/{news,archive,embed}.spec.mjs.
 */
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, test } from 'node:test';
import { CORE_SCHEMA, load as loadYaml } from 'js-yaml';
import { fileURLToPath } from 'node:url';
import {
  ENTRY_KIND_LABELS, archiveStatus, bannerText, femaUrl, formatCalendarDate, timelineOrder,
} from '../../../site/static/js/pages/archive.js';
import {
  JURISDICTION_LABELS, NEWS_URL_SCHEMA, curatedListStatus, filtersFromState, itemMatches, jurisdictionsPresent, normalizeQuery,
  sortItems, sourceStatusLine,
} from '../../../site/static/js/pages/news.js';
import { parseQuery, serializeQuery } from '../../../site/static/js/core/url-state.js';
import { validateSnapshot } from '../../../site/static/js/core/status.js';
import { buildNewsEnvelope, loadNewsSources } from '../../../scripts/snapshot/tasks/news.mjs';
import { createFixtureHttp } from '../../../scripts/lib/http.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** Source without block and line comments, so prose in a header cannot trip a code check. @param {string} s */
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');

/** @returns {Promise<any[]>} headlines built from the dated captures, as the page receives them */
async function realItems() {
  const http = await createFixtureHttp(path.join(ROOT, 'tests', 'fixtures', 'upstream'));
  const ctx = { now: new Date('2026-10-05T10:00:00Z'), http, previous: async () => null, registry: /** @type {any} */ ({}), reference: async () => null, log: () => {} };
  return /** @type {any[]} */ ((await buildNewsEnvelope(ctx, await loadNewsSources())).items);
}

describe('News: sorting and filtering', () => {
  test('the default order is latest first across every source', async () => {
    const items = await realItems();
    const sorted = sortItems([...items].reverse(), 'latest');
    const times = sorted.map((i) => i.published);
    assert.deepEqual([...times].sort().reverse(), times);
    assert.ok(new Set(sorted.slice(0, 12).map((i) => i.sourceId)).size > 1, 'the first screen mixes sources');
  });

  test('"Official First" puts official items first and each group latest first', async () => {
    const items = await realItems();
    const mixed = [
      ...items,
      // A real Idaho item, read as of its own week, so an official item exists to order (see news-task tests).
      { id: '00000000000000aa', sourceId: 'news-idaho-oem', title: 'Official test row', url: 'https://example.test/o', published: '2026-09-01T00:00:00.000Z', summary: '', kind: 'official', regions: ['ID'] },
    ];
    const sorted = sortItems(mixed, 'official');
    assert.equal(sorted[0]?.kind, 'official');
    const firstOther = sorted.findIndex((i) => i.kind !== 'official');
    assert.ok(sorted.slice(firstOther).every((i) => i.kind !== 'official'));
    const rest = sorted.slice(firstOther).map((i) => i.published);
    assert.deepEqual([...rest].sort().reverse(), rest);
  });

  test('sorting is stable for equal times and never mutates its input', () => {
    const a = { id: 'a', published: '2026-10-05T00:00:00.000Z', kind: 'media' };
    const b = { id: 'b', published: '2026-10-05T00:00:00.000Z', kind: 'media' };
    const input = /** @type {any[]} */ ([b, a]);
    assert.deepEqual(sortItems(input, 'latest').map((i) => i.id), ['a', 'b']);
    assert.deepEqual(input.map((i) => i.id), ['b', 'a']);
  });

  test('filters combine: kind, place, and every search word, accent and case blind', async () => {
    const items = await realItems();
    const none = { kinds: [], j: null, q: '', sort: /** @type {const} */ ('latest') };
    assert.equal(items.filter((i) => itemMatches(i, none)).length, items.length);
    const video = items.filter((i) => itemMatches(i, { ...none, kinds: ['video'] }));
    assert.ok(video.length > 0 && video.every((i) => i.kind === 'video'));
    const bc = items.filter((i) => itemMatches(i, { ...none, j: 'BC' }));
    assert.ok(bc.length > 0 && bc.every((i) => i.regions.includes('BC')));
    const word = normalizeQuery(items[0].title).split(' ').find((w) => w.length > 4) ?? '';
    const hit = items.filter((i) => itemMatches(i, { ...none, q: word.toUpperCase() }));
    assert.ok(hit.includes(items[0]));
    assert.equal(items.filter((i) => itemMatches(i, { ...none, q: `${word} qqqqqzzzz` })).length, 0, 'every word must match');
    assert.equal(itemMatches(items[0], { ...none, q: `  ${word}   ` }), true, 'extra spaces are ignored');
  });

  test('the source name is searchable', () => {
    const item = /** @type {any} */ ({ id: 'x', title: 'Headline', summary: '', kind: 'media', regions: ['WA'], sourceId: 's', published: '2026-10-05T00:00:00.000Z', url: 'https://example.test/' });
    const f = { kinds: [], j: null, q: 'public broadcasting', sort: /** @type {const} */ ('latest') };
    assert.equal(itemMatches(item, f), false);
    assert.equal(itemMatches(item, f, 'Oregon Public Broadcasting'), true);
  });

  test('normalizeQuery folds accents and case and collapses space', () => {
    assert.equal(normalizeQuery('  Café   Río '), 'cafe rio');
    assert.equal(normalizeQuery(null), '');
  });

  test('URL state: kind, j, q, and sort round-trip; unknown values are dropped; embed is kept', () => {
    const parsed = parseQuery('?embed=1&kind=official,video,bogus&j=BC&q=flood%20warning&sort=official&j2=x', NEWS_URL_SCHEMA);
    assert.deepEqual(filtersFromState(parsed), { kinds: ['official', 'video'], j: 'BC', q: 'flood warning', sort: 'official' });
    assert.deepEqual(filtersFromState(parseQuery('?j=ZZ&sort=nope', NEWS_URL_SCHEMA)), { kinds: [], j: null, q: '', sort: 'latest' });
    const written = serializeQuery({ kind: ['media'], j: 'OR', q: 'ferry', sort: undefined }, '?embed=1&sort=official');
    assert.equal(written, '?embed=1&j=OR&kind=media&q=ferry');
  });

  test('the place list is built from the registry jurisdictions that appear', async () => {
    const items = await realItems();
    const present = jurisdictionsPresent(items, await loadNewsSources());
    assert.ok(present.includes('WA') && present.includes('OR') && present.includes('BC'));
    assert.ok(present.every((j) => j in JURISDICTION_LABELS));
  });
});

describe('News: per-source status', () => {
  const source = /** @type {any} */ ({ id: 'news-opb', name: 'Oregon Public Broadcasting', kind: 'media', regions: ['OR'], homepage: 'https://www.opb.org/', feed: 'https://x.test/', feedFormat: 'rss', maxAgeDays: 14, verifiedAt: '2026-10-05' });

  test('a feed that answered says when and how many', () => {
    const line = sourceStatusLine(source, { ok: true, count: 10, asOf: '2026-10-05T22:00:00.000Z' }, 'America/Los_Angeles');
    assert.equal(line.state, 'live');
    assert.equal(line.text, 'Oregon Public Broadcasting feed answered 10/05/2026 3:00 PM PDT: 10 headlines.');
  });

  test('a quiet feed is not an outage', () => {
    const line = sourceStatusLine(source, { ok: true, count: 0, asOf: '2026-10-05T22:00:00.000Z' }, 'America/Los_Angeles');
    assert.equal(line.state, 'live');
    assert.match(line.text, /no headlines in the last 14 days/);
  });

  test('a feed that stopped answering names its last answer and what is still shown', () => {
    const line = sourceStatusLine(source, { ok: false, count: 4, asOf: '2026-10-05T22:00:00.000Z', carriedForward: true }, 'America/Los_Angeles');
    assert.equal(line.state, 'stale');
    assert.equal(line.text, 'Oregon Public Broadcasting feed has not answered since 10/05/2026 3:00 PM PDT. Showing 4 earlier headlines.');
  });

  test('a feed that never answered, or is missing from the update, says so', () => {
    assert.match(sourceStatusLine(source, { ok: false, count: 0, asOf: null }).text, /has not answered in any update on record\. No earlier headlines are held\./);
    assert.equal(sourceStatusLine(source, { ok: false, count: 0, asOf: null }).state, 'unavailable');
    assert.match(sourceStatusLine(source, undefined).text, /was not part of the latest update/);
    assert.match(sourceStatusLine(source, { ok: false, count: 1, asOf: '2026-10-05T22:00:00.000Z' }, 'UTC').text, /Showing 1 earlier headline\./);
  });

  test('the curated link list status is valid, names the check date, and is never "live" as news', async () => {
    const doc = { generatedAt: '2026-10-05T09:00:00.000Z', items: await loadNewsSources() };
    const st = curatedListStatus(doc, new Date('2026-10-06T00:00:00Z'));
    assert.deepEqual(validateSnapshot(st), []);
    assert.equal(st.asOf, doc.generatedAt);
    assert.equal(st.detail, 'Links last checked 10/05/2026');
    assert.deepEqual(st.sourceIds, ['cthd-news']);
  });
});

describe('Archive helpers', () => {
  test('calendar dates print as MM/DD/YYYY with no time zone drift', () => {
    assert.equal(formatCalendarDate('2025-12-05'), '12/05/2025');
    assert.equal(formatCalendarDate('2026-01-01'), '01/01/2026');
    assert.equal(formatCalendarDate('nonsense'), 'nonsense');
  });

  test('the banner states the event period from the data and says the information is not current', () => {
    assert.equal(bannerText({ start: '2025-12-05', end: '2025-12-19' }), 'Archived event: 12/05/2025 to 12/19/2025. This information is not current.');
  });

  test('the static banner in the event page matches the period in the event file', async () => {
    const html = await readFile(path.join(ROOT, 'site', 'archive', '2025-12-atmospheric-river', 'index.html'), 'utf8');
    const events = /** @type {any} */ ({ items: [loadYaml(await readFile(path.join(ROOT, 'data', 'events', '2025-12-atmospheric-river.yaml'), 'utf8'), { schema: CORE_SCHEMA })] });
    const ev = events.items.find((/** @type {any} */ e) => e.id === '2025-12-atmospheric-river');
    assert.ok(ev);
    assert.ok(html.includes(bannerText(ev.period)), `the page says "${bannerText(ev.period)}"`);
  });

  test('the timeline runs oldest to newest and keeps file order within a day', async () => {
    const events = /** @type {any} */ ({ items: [loadYaml(await readFile(path.join(ROOT, 'data', 'events', '2025-12-atmospheric-river.yaml'), 'utf8'), { schema: CORE_SCHEMA })] });
    const entries = events.items[0].entries;
    const ordered = timelineOrder([...entries].reverse());
    const dates = ordered.map((/** @type {any} */ e) => e.date);
    assert.deepEqual([...dates].sort(), dates);
    assert.equal(timelineOrder(entries).filter((e) => e.date === '2025-12-10').length, entries.filter((/** @type {any} */ e) => e.date === '2025-12-10').length);
  });

  test('every entry kind in the schema has a label', async () => {
    const schema = JSON.parse(await readFile(path.join(ROOT, 'schemas', 'event.schema.json'), 'utf8'));
    const kinds = schema.properties.entries.items.properties.kind.enum;
    for (const k of kinds) assert.ok(ENTRY_KIND_LABELS[k], k);
  });

  test('archive status is Stale, valid, stamped with the compile time, and names the last link check', () => {
    const st = archiveStatus('2026-10-05T09:24:38.201Z', /** @type {any} */ ([{ verifiedAt: '2026-10-05' }, { verifiedAt: '2026-09-30' }]), ['cthd-events'], new Date('2026-10-05T12:00:00Z'));
    assert.deepEqual(validateSnapshot(st), []);
    assert.equal(st.state, 'stale');
    assert.equal(st.asOf, '2026-10-05T09:24:38.201Z');
    assert.match(st.detail ?? '', /Archived event, not current/);
    assert.match(st.detail ?? '', /link checked 10\/05\/2026/);
  });

  test('FEMA links take their host from the registry record, never a literal', () => {
    assert.equal(femaUrl(4906, 'https://www.fema.gov/about/openfema/api'), 'https://www.fema.gov/disaster/4906');
    assert.equal(femaUrl(4906, null), null);
    assert.equal(femaUrl(4906, 'http://www.fema.gov/x'), null);
    assert.equal(femaUrl(-1, 'https://www.fema.gov/x'), null);
    assert.equal(femaUrl(4906, 'not a url'), null);
  });
});

describe('The archive and news pages in the repository', () => {
  test('the pages never reference data/live from the archive modules or an upstream address', async () => {
    const archive = stripComments(await readFile(path.join(ROOT, 'site', 'static', 'js', 'pages', 'archive.js'), 'utf8'));
    assert.doesNotMatch(archive, /data\/live|getData|https?:\/\//);
    assert.match(archive, /data\/curated\/events\.json/);
    const html = [
      await readFile(path.join(ROOT, 'site', 'archive', 'index.html'), 'utf8'),
      await readFile(path.join(ROOT, 'site', 'archive', '2025-12-atmospheric-river', 'index.html'), 'utf8'),
    ];
    for (const page of html) assert.match(page, /name="robots" content="noindex"/);
  });

  test('the news module reads only the scheduled copy and the compiled list: no feed address, no third-party host', async () => {
    const news = stripComments(await readFile(path.join(ROOT, 'site', 'static', 'js', 'pages', 'news.js'), 'utf8'));
    assert.doesNotMatch(news, /https?:\/\//);
    assert.doesNotMatch(news, /ytimg|youtube\.com\/embed|<iframe|XMLHttpRequest|\bfetch\(/);
  });
});

describe('No proxy anywhere in the repository (blueprint 12.3, L14)', () => {
  const NEEDLES = [
    ['all', 'origins'], ['cors', 'proxy'], ['cors', '-anywhere'], ['thing', 'proxy'], ['code', 'tabs'], ['cors', '.sh'], ['crossorigin', '.me'],
    ['yacdn', '.org'], ['r.jina', '.ai'], ['allorigins'],
  ].map((p) => p.join(''));
  const SKIP_DIRS = new Set(['node_modules', '.git', 'test-results', 'playwright-report', 'reports', 'exports', '_site', '.cache']);
  const TEXT = /\.(?:m?js|json|ya?ml|html|css|md|txt|webmanifest|xml|csv|cff|mjs)$/i;

  /** @param {string} dir @returns {Promise<string[]>} */
  async function walk(dir) {
    /** @type {string[]} */
    const out = [];
    for (const e of await readdir(dir, { withFileTypes: true })) {
      if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) out.push(...await walk(path.join(dir, e.name))); } else if (TEXT.test(e.name)) out.push(path.join(dir, e.name));
    }
    return out;
  }

  test('no tracked-style source, data, test, or page file names a CORS proxy service', async () => {
    const hits = [];
    for (const dir of ['site', 'scripts', 'data', 'tests', 'schemas', 'dev']) {
      for (const f of await walk(path.join(ROOT, dir))) {
        if (f.endsWith('news-page.test.mjs')) continue; // builds the needles from fragments; skipped by name for safety
        const text = (await readFile(f, 'utf8')).toLowerCase();
        for (const n of NEEDLES) if (text.includes(n)) hits.push(`${path.relative(ROOT, f)}: ${n}`);
      }
    }
    for (const f of ['README.md', 'DATA.md', 'index.html', 'package.json']) {
      try {
        const text = (await readFile(path.join(ROOT, f), 'utf8')).toLowerCase();
        for (const n of NEEDLES) if (text.includes(n)) hits.push(`${f}: ${n}`);
      } catch { /* a root file that does not exist cannot name a proxy */ }
    }
    assert.deepEqual(hits, []);
  });

  test('the news task and page make no request to a feed from a browser', async () => {
    const task = await readFile(path.join(ROOT, 'scripts', 'snapshot', 'tasks', 'news.mjs'), 'utf8');
    assert.doesNotMatch(task, /\bfetch\(/, 'the task uses only the registered-origin client');
  });
});
