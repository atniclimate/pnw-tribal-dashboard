// @ts-check
/**
 * Lane L14 acceptance for the news snapshot task (blueprint 5.8, 12.3): hardened parsing, plain text,
 * https-only links, per-source status, carry-forward, and the safe handling of YouTube and community sources.
 * Inputs are the dated captures in tests/fixtures/upstream/news-* (and their recorded derivations); the few
 * strings passed directly to pure functions are labeled test inputs and never reach a page.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadAjv } from '../../../scripts/check/lib/data-files.mjs';
import { createFixtureHttp, loadSourceRegistry, recordOrigins } from '../../../scripts/lib/http.mjs';
import { envelopeErrors } from '../../../scripts/lib/live.mjs';
import task, {
  FUTURE_SLACK_MS, assertSafeFeed, buildItems, buildNewsEnvelope, classifyLink, decodeEntities, extractEntries, feedSources,
  itemId, loadNewsSources, parseFeedXml, resolveLink, scrubContactLines, summaryText, toPlainText, SUMMARY_MAX, TITLE_MAX,
} from '../../../scripts/snapshot/tasks/news.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const FIXTURES = path.join(ROOT, 'tests', 'fixtures', 'upstream');
const NOW = new Date('2026-10-05T10:00:00Z');
/** @type {Promise<Awaited<ReturnType<typeof loadAjv>>> | null} */
let ajvOnce = null;
const cachedAjv = () => (ajvOnce ??= loadAjv());

/** @param {string} dir @param {string} file */
const fixture = (dir, file) => readFile(path.join(FIXTURES, dir, file), 'utf8');

/**
 * @param {import('../../../site/static/js/types.js').SnapshotHttp} http
 * @param {import('../../../site/static/js/types.js').LiveEnvelope<unknown> | null} [previous]
 * @returns {import('../../../site/static/js/types.js').SnapshotContext}
 */
function ctxWith(http, previous = null) {
  return {
    now: NOW,
    http,
    previous: async () => previous,
    registry: /** @type {any} */ ({}),
    reference: async () => { throw new Error('not used'); },
    log: () => {},
  };
}

/** @param {import('../../../site/static/js/types.js').SnapshotHttp} base @param {string[]} failIds */
function failing(base, failIds) {
  return /** @type {any} */ ({
    ...base,
    getText: async (/** @type {string} */ id, /** @type {string} */ url, /** @type {any} */ o) => (failIds.includes(id)
      ? { ok: false, error: { kind: 'timeout', message: 'no response within 20000 ms' }, fetchedAt: NOW.toISOString(), sourceId: id }
      : base.getText(id, url, o)),
  });
}

const alwaysYes = async () => true;
const alwaysNo = async () => false;

describe('hardened parsing', () => {
  test('a feed with a DOCTYPE or ENTITY is rejected before parsing', async () => {
    const text = await fixture('news-opb', '2026-10-05-rss-doctype-entity.xml');
    assert.match(text, /<!DOCTYPE/);
    assert.match(text, /<!ENTITY/);
    assert.throws(() => assertSafeFeed(text), /DOCTYPE or ENTITY/);
    assert.throws(() => parseFeedXml(text), /DOCTYPE or ENTITY/);
    assert.throws(() => assertSafeFeed('<?xml version="1.0"?><!entity x "y"><rss/>'), /DOCTYPE or ENTITY/i);
  });

  test('the task reports the rejected feed as a failed source, never as items', async () => {
    const base = await createFixtureHttp(FIXTURES);
    // Serve the derived DOCTYPE capture in place of the OPB feed.
    const doctype = await fixture('news-opb', '2026-10-05-rss-doctype-entity.xml');
    const http = { ...base, getText: async (/** @type {string} */ id, /** @type {string} */ url, /** @type {any} */ o) => (id === 'news-opb'
      ? { ok: true, data: doctype, status: 200, fetchedAt: '2026-10-05T09:59:00.000Z', lastModified: null, sourceId: id }
      : base.getText(id, url, o)) };
    const env = await buildNewsEnvelope(ctxWith(/** @type {any} */ (http)), await loadNewsSources());
    assert.equal(env.perSource['news-opb']?.ok, false);
    assert.equal(env.perSource['news-opb']?.count, 0);
    assert.equal(env.items.some((i) => /** @type {any} */ (i).sourceId === 'news-opb'), false);
    assert.equal(env.completeness, 'partial');
  });

  test('entities are never expanded: a declared entity reference stays inert text', () => {
    const tree = parseFeedXml('<rss><channel><item><title>A &x; B</title><link>https://example.test/a</link><pubDate>Mon, 05 Oct 2026 04:00:00 +0000</pubDate></item></channel></rss>');
    const [e] = extractEntries(tree, 'rss');
    assert.equal(e?.title, 'A &x; B');
  });

  test('a document that is not the declared feed kind is a parse failure', () => {
    assert.throws(() => extractEntries(parseFeedXml('<html><body>hello</body></html>'), 'rss'), /not an RSS feed/);
    assert.throws(() => extractEntries(parseFeedXml('<rss><channel/></rss>'), 'atom'), /not an Atom feed/);
  });
});

describe('plain text', () => {
  test('every title and summary in every captured feed is plain text within the limits', async () => {
    const http = await createFixtureHttp(FIXTURES);
    const env = await buildNewsEnvelope(ctxWith(http), await loadNewsSources());
    const items = /** @type {any[]} */ (env.items);
    assert.ok(items.length > 20, `expected a real set of items, got ${items.length}`);
    for (const i of items) {
      assert.ok(i.title.length > 0 && Array.from(i.title).length <= TITLE_MAX, i.title);
      assert.ok(Array.from(i.summary).length <= SUMMARY_MAX, i.summary);
      for (const text of [i.title, i.summary]) {
        assert.doesNotMatch(text, /<\/?[a-zA-Z!][^>]*>/, `markup left in: ${text}`);
        assert.doesNotMatch(text, /&(?:lt|gt|amp|quot|#\d+|#x[0-9a-f]+);/i, `entity left in: ${text}`);
        assert.ok(!Array.from(text).some((ch) => { const c = ch.codePointAt(0) ?? 0; return c <= 8 || (c >= 11 && c <= 31); }), 'control character left in');
        assert.equal(text, text.trim());
        assert.doesNotMatch(text, /\s{2,}/);
      }
    }
  });

  test('HTML in a real Idaho Office of Emergency Management description reduces to text', async () => {
    const raw = extractEntries(parseFeedXml(await fixture('news-idaho-oem', '2026-10-05-rss.xml')), 'rss');
    const source = (await loadNewsSources()).find((s) => s.id === 'news-idaho-oem');
    assert.ok(source);
    assert.ok(raw.length >= 5);
    assert.ok(raw.every((e) => /<[a-z]/i.test(e.summary)), 'the capture carries HTML in every description');
    // The newest item is dated 07/02/2026; read the capture as of 07/03/2026, inside the 60-day window.
    const built = await buildItems(raw, source, { now: new Date('2026-07-03T00:00:00Z'), head: alwaysNo });
    assert.ok(built.items.length >= 3);
    for (const i of built.items) {
      assert.doesNotMatch(`${i.title} ${i.summary}`, /<|>|&[a-z#0-9]+;/i);
      assert.ok(Array.from(i.summary).length <= SUMMARY_MAX);
    }
  });

  test('press-contact blocks, email addresses, and telephone numbers never reach a summary', async () => {
    const raw = extractEntries(parseFeedXml(await fixture('news-idaho-oem', '2026-10-05-rss.xml')), 'rss');
    assert.ok(raw.some((e) => /contact:/i.test(toPlainText(e.summary, 100000))), 'the capture has a press-contact block');
    for (const e of raw) {
      const s = summaryText(e.summary);
      assert.doesNotMatch(s, /@|contact\s*:/i);
      assert.doesNotMatch(s, /\(?\d{3}\)?[ .-]?\d{3}[ .-]?\d{4}/);
    }
    assert.equal(scrubContactLines('Release. Contact: A Person (208) 555-0100 a.person@example.test Body text.'), 'Release. Body text.');
    assert.equal(scrubContactLines('Call 208-555-0100 or write a@b.test today'), 'Call or write today');
  });

  test('toPlainText removes escaped, literal, and doubly escaped markup (test inputs)', () => {
    assert.equal(toPlainText('<p>Tom &amp; Jerry</p>', 50), 'Tom & Jerry');
    assert.equal(toPlainText('&lt;p&gt;Tom &amp;amp; Jerry&lt;/p&gt;', 50), 'Tom & Jerry');
    assert.equal(toPlainText('Hello <script>alert(1)</script>world <style>p{}</style>!', 50), 'Hello world !');
    assert.equal(toPlainText('&lt;script&gt;alert(1)&lt;/script&gt;Safe', 50), 'Safe');
    assert.equal(toPlainText('<img src="https://x.test/a.png" alt="a">Caption', 50), 'Caption');
    assert.equal(toPlainText('Line one\n\n   line   two\t', 50), 'Line one line two');
    assert.equal(toPlainText('Caf&eacute; &#8212; &#x2019;ok&#x2019;', 50), 'Café — ’ok’');
    assert.equal(toPlainText('<![CDATA[inside]]>', 50), 'inside');
    assert.equal(toPlainText(['bad', String.fromCharCode(0), 'control', String.fromCharCode(0x202e), 'chars'].join(''), 50), 'bad control chars');
    assert.equal(toPlainText(undefined, 10), '');
  });

  test('toPlainText truncates by character, not by code unit, and marks the cut', () => {
    const out = toPlainText('a'.repeat(300), SUMMARY_MAX);
    assert.equal(Array.from(out).length, SUMMARY_MAX);
    assert.ok(out.endsWith('…'));
    const emoji = toPlainText('\u{1F30A}'.repeat(40), 10);
    assert.equal(Array.from(emoji).length, 10);
    assert.doesNotMatch(emoji, /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
  });

  test('decodeEntities leaves unknown names and invalid code points alone', () => {
    assert.equal(decodeEntities('&bogus; &#0; &#xD800; &#1114112;'), '&bogus; &#0; &#xD800; &#1114112;');
  });
});

describe('links', () => {
  test('classifyLink keeps https, flags http for an upgrade check, and drops everything else', () => {
    assert.deepEqual(classifyLink('https://example.test/a?utm_source=x&cmp=rss&id=3#frag'), { url: 'https://example.test/a?id=3', upgrade: false });
    assert.deepEqual(classifyLink('http://example.test/a'), { url: 'https://example.test/a', upgrade: true });
    assert.deepEqual(classifyLink('javascript:alert(1)'), { url: null, reason: 'scheme' });
    assert.deepEqual(classifyLink('  JaVaScRiPt:alert(1)'), { url: null, reason: 'scheme' });
    assert.deepEqual(classifyLink('data:text/html,<b>x</b>'), { url: null, reason: 'scheme' });
    assert.deepEqual(classifyLink('ftp://example.test/a'), { url: null, reason: 'scheme' });
    assert.deepEqual(classifyLink('//example.test/a'), { url: null, reason: 'invalid' });
    assert.deepEqual(classifyLink('/relative'), { url: null, reason: 'invalid' });
    assert.deepEqual(classifyLink('https://user:pw@example.test/'), { url: null, reason: 'credentials' });
    assert.deepEqual(classifyLink(''), { url: null, reason: 'invalid' });
  });

  test('an http link is upgraded only when the https address answers', async () => {
    assert.deepEqual(await resolveLink('http://www.opb.org/a', alwaysYes), { url: 'https://www.opb.org/a', upgraded: true });
    assert.deepEqual(await resolveLink('http://www.opb.org/a', alwaysNo), { url: null, upgraded: false, reason: 'http-unanswered' });
    assert.deepEqual(await resolveLink('http://www.opb.org/a', async () => { throw new Error('boom'); }), { url: null, upgraded: false, reason: 'http-unanswered' });
    assert.deepEqual(await resolveLink('https://www.opb.org/a', async () => { throw new Error('never asked'); }), { url: 'https://www.opb.org/a', upgraded: false });
  });

  test('the recorded http-link and javascript-link derivations behave as the contract says', async () => {
    const source = /** @type {any} */ ((await loadNewsSources()).find((s) => s.id === 'news-opb'));
    const live = extractEntries(parseFeedXml(await fixture('news-opb', '2026-10-05-rss.xml')), 'rss');
    const http = extractEntries(parseFeedXml(await fixture('news-opb', '2026-10-05-rss-http-link.xml')), 'rss');
    const js = extractEntries(parseFeedXml(await fixture('news-opb', '2026-10-05-rss-javascript-link.xml')), 'rss');
    assert.ok(http[0]?.link.startsWith('http://'));
    assert.ok(js[0]?.link.startsWith('javascript:'));

    const baseline = await buildItems(live, source, { now: NOW, head: alwaysNo });
    const upgraded = await buildItems(http, source, { now: NOW, head: alwaysYes });
    const refused = await buildItems(http, source, { now: NOW, head: alwaysNo });
    const dropped = await buildItems(js, source, { now: NOW, head: alwaysYes });

    assert.equal(upgraded.counts.linksUpgraded, 1);
    assert.equal(upgraded.items[0]?.url, baseline.items[0]?.url, 'the upgraded link equals the original https link');
    assert.equal(refused.counts.linksDropped, 1);
    assert.notEqual(refused.items[0]?.url, baseline.items[0]?.url, 'the unanswered http item is gone');
    assert.equal(dropped.counts.linksDropped, 1);
    for (const r of [baseline, upgraded, refused, dropped]) for (const i of r.items) assert.match(i.url, /^https:\/\//);
  });

  test('the item id is the first sixteen hex characters of the SHA-256 of the canonical link', () => {
    assert.match(itemId('https://example.test/a'), /^[0-9a-f]{16}$/);
    assert.equal(itemId('https://example.test/a'), itemId('https://example.test/a'));
    assert.notEqual(itemId('https://example.test/a'), itemId('https://example.test/b'));
  });
});

describe('items', () => {
  test('latest first, inside the age window, capped, and undated items dropped (test inputs)', async () => {
    const source = { id: 'news-test', name: 'Test', kind: /** @type {const} */ ('media'), regions: ['WA'], homepage: 'https://example.test/', feed: 'https://example.test/f', feedFormat: /** @type {const} */ ('rss'), maxItems: 3, maxAgeDays: 2, verifiedAt: '2026-10-05' };
    const e = (/** @type {string} */ n, /** @type {string} */ date) => ({ title: `Item ${n}`, link: `https://example.test/${n}`, published: date, summary: '' });
    const entries = [
      e('old', 'Mon, 28 Sep 2026 04:00:00 +0000'),
      e('b', 'Mon, 05 Oct 2026 04:00:00 +0000'),
      e('a', 'Mon, 05 Oct 2026 08:00:00 +0000'),
      e('c', 'Sun, 04 Oct 2026 12:00:00 +0000'),
      e('d', 'Sun, 04 Oct 2026 11:00:00 +0000'),
      e('undated', ''),
      e('garbage', 'not a date'),
      e('future', new Date(NOW.getTime() + FUTURE_SLACK_MS + 3600_000).toUTCString()),
    ];
    const r = await buildItems(entries, source, { now: NOW, head: alwaysNo });
    assert.deepEqual(r.items.map((i) => i.title), ['Item a', 'Item b', 'Item c']);
    assert.equal(r.counts.undated, 2);
    assert.equal(r.counts.outsideWindow, 2);
    const times = r.items.map((i) => i.published);
    assert.deepEqual([...times].sort().reverse(), times);
  });

  test('a duplicate link or an empty title is dropped (test inputs)', async () => {
    const source = { id: 'news-test', name: 'Test', kind: /** @type {const} */ ('media'), regions: ['WA'], homepage: 'https://example.test/', feed: 'https://example.test/f', feedFormat: /** @type {const} */ ('rss'), verifiedAt: '2026-10-05' };
    const when = 'Mon, 05 Oct 2026 04:00:00 +0000';
    const r = await buildItems([
      { title: 'One', link: 'https://example.test/x?utm_campaign=a', published: when, summary: '' },
      { title: 'One again', link: 'https://example.test/x', published: when, summary: '' },
      { title: '<b></b>', link: 'https://example.test/y', published: when, summary: '' },
    ], source, { now: NOW, head: alwaysNo });
    assert.equal(r.items.length, 1);
    assert.equal(r.counts.duplicates, 1);
    assert.equal(r.counts.noTitle, 1);
  });

  test('YouTube items carry a title and a watch link only; no thumbnail address is kept', async () => {
    const http = await createFixtureHttp(FIXTURES);
    const env = await buildNewsEnvelope(ctxWith(http), await loadNewsSources());
    const videos = /** @type {any[]} */ (env.items).filter((i) => i.kind === 'video');
    assert.ok(videos.length >= 2);
    for (const v of videos) {
      assert.match(v.url, /^https:\/\/www\.youtube\.com\/watch\?v=[\w-]{11}$/);
      assert.equal(v.summary, '');
      assert.equal(v.sourceId, 'news-youtube-pnwwx');
    }
    assert.doesNotMatch(JSON.stringify(env), /ytimg|hqdefault|\.jpg|\.png|\/embed\//);
  });
});

describe('the envelope', () => {
  test('against the dated captures it validates, names every source, and is latest first', async () => {
    const http = await createFixtureHttp(FIXTURES);
    const sources = await loadNewsSources();
    const env = await buildNewsEnvelope(ctxWith(http), sources);
    const ajv = await cachedAjv();
    assert.deepEqual(envelopeErrors(ajv, 'news.json', env), []);
    assert.equal(env.completeness, 'complete');
    assert.equal(env.asOfBasis, 'retrieved');
    assert.equal(env.failure, null);
    assert.deepEqual(Object.keys(env.perSource).sort(), feedSources(sources).map((s) => s.id).sort());
    const times = /** @type {any[]} */ (env.items).map((i) => i.published);
    assert.deepEqual([...times].sort().reverse(), times);
    for (const i of /** @type {any[]} */ (env.items)) assert.match(i.id, /^[0-9a-f]{16}$/);
  });

  test('a quiet official feed is a healthy source with no items, not an outage', async () => {
    const http = await createFixtureHttp(FIXTURES);
    const env = await buildNewsEnvelope(ctxWith(http), await loadNewsSources());
    assert.deepEqual({ ok: env.perSource['news-idaho-oem']?.ok, count: env.perSource['news-idaho-oem']?.count }, { ok: true, count: 0 });
    assert.ok((env.diagnostics['outsideWindow:news-idaho-oem'] ?? 0) > 0);
  });

  test('one feed failing keeps its earlier items, flagged, and says when it last answered', async () => {
    const base = await createFixtureHttp(FIXTURES);
    const sources = await loadNewsSources();
    const first = await buildNewsEnvelope(ctxWith(base), sources);
    const second = await buildNewsEnvelope(ctxWith(failing(base, ['news-kiro7']), first), sources);
    assert.equal(second.completeness, 'partial');
    const status = second.perSource['news-kiro7'];
    assert.equal(status?.ok, false);
    assert.equal(status?.carriedForward, true);
    assert.equal(status?.asOf, first.perSource['news-kiro7']?.asOf, 'asOf is the last successful answer, not the failure time');
    assert.equal(status?.count, first.perSource['news-kiro7']?.count);
    assert.deepEqual(
      /** @type {any[]} */ (second.items).filter((i) => i.sourceId === 'news-kiro7').map((i) => i.id),
      /** @type {any[]} */ (first.items).filter((i) => i.sourceId === 'news-kiro7').map((i) => i.id),
    );
    assert.equal(second.perSource['news-opb']?.ok, true);
    assert.deepEqual(envelopeErrors(await cachedAjv(), 'news.json', second), []);
  });

  test('a failing feed with no earlier copy is shown as failed with no items', async () => {
    const base = await createFixtureHttp(FIXTURES);
    const env = await buildNewsEnvelope(ctxWith(failing(base, ['news-global-bc'])), await loadNewsSources());
    assert.deepEqual(env.perSource['news-global-bc'], { ok: false, count: 0, asOf: null, completeness: 'rejected', carriedForward: false });
  });

  test('every feed failing is a rejected envelope with no items, so the runner carries the previous file', async () => {
    const base = await createFixtureHttp(FIXTURES);
    const sources = await loadNewsSources();
    const ids = feedSources(sources).map((s) => s.id);
    const env = await buildNewsEnvelope(ctxWith(failing(base, ids)), sources);
    assert.equal(env.completeness, 'rejected');
    assert.equal(env.items.length, 0);
    assert.equal(env.asOf, null);
    assert.equal(env.failure?.code, 'upstream');
    assert.deepEqual(envelopeErrors(await cachedAjv(), 'news.json', env), []);
  });

  test('community sources and sources without a feed are never requested', async () => {
    const base = await createFixtureHttp(FIXTURES);
    /** @type {string[]} */
    const asked = [];
    const spy = {
      getJson: base.getJson,
      getText: (/** @type {string} */ id, /** @type {string} */ url, /** @type {any} */ o) => { asked.push(url); return base.getText(id, url, o); },
      head: (/** @type {string} */ id, /** @type {string} */ url, /** @type {any} */ o) => { asked.push(url); return base.head(id, url, o); },
    };
    const sources = await loadNewsSources();
    await buildNewsEnvelope(ctxWith(spy), sources);
    assert.doesNotMatch(asked.join('\n'), /reddit\./i);
    const fetched = new Set(feedSources(sources).map((s) => s.feed));
    for (const url of asked) assert.ok(fetched.has(url), `unexpected request ${url}`);
    for (const s of sources.filter((x) => x.kind === 'community')) {
      assert.equal(s.feed, null);
      assert.equal(s.feedFormat, 'none');
    }
  });

  test('the default export is a valid task whose source ids are exactly the feeds in news-sources.yaml', async () => {
    const sources = await loadNewsSources();
    assert.equal(task.id, 'news');
    assert.deepEqual([...task.sourceIds].sort(), feedSources(sources).map((s) => s.id).sort());
    assert.deepEqual(task.outputs, ['news.json']);
    assert.equal(task.cadenceMin, 30);
    assert.equal(typeof task.run, 'function');
  });

  test('every fetched feed is registered with an origin that covers its feed address and links', async () => {
    const registry = await loadSourceRegistry(ROOT);
    for (const s of feedSources(await loadNewsSources())) {
      const origins = registry.get(s.id);
      assert.ok(origins && origins.size > 0, `${s.id} has no source record with an origin`);
      assert.ok(origins.has(new URL(/** @type {string} */ (s.feed)).origin), `${s.id} feed origin is not registered`);
      assert.ok(origins.has(new URL(s.homepage).origin) || s.id === 'news-youtube-pnwwx', `${s.id} homepage origin is not registered`);
    }
    assert.deepEqual([...recordOrigins({ url: 'https://a.test/x', urlTemplate: 'https://b.test/{p}' })].sort(), ['https://a.test', 'https://b.test']);
  });
});

describe('through the real task entry point', () => {
  test('run() reads the repository list and the dated captures and returns one valid envelope', async () => {
    const http = await createFixtureHttp(FIXTURES);
    const out = await task.run(ctxWith(http));
    assert.deepEqual(Object.keys(out), ['news.json']);
    assert.deepEqual(envelopeErrors(await cachedAjv(), 'news.json', /** @type {any} */ (out['news.json'])), []);
    assert.equal(/** @type {any} */ (out['news.json']).completeness, 'complete');
  });

  test('an unreadable source list is a rejected envelope, never a throw', async () => {
    const out = await task.run({ ...ctxWith(await createFixtureHttp(FIXTURES)), http: /** @type {any} */ (null) });
    const env = /** @type {any} */ (out['news.json']);
    assert.equal(env.completeness, 'rejected');
    assert.deepEqual(env.items, []);
    assert.deepEqual(envelopeErrors(await cachedAjv(), 'news.json', env), []);
  });
});

