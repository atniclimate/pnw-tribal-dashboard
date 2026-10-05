// @ts-check
/**
 * News page acceptance (blueprint 7.7, 12.3 lane L14): latest first by default, per-source status, search that
 * never loses focus, YouTube as text links with no third-party request on load, Reddit as labeled links only,
 * a provenance footer on every panel, and no request to any host but the site's own.
 *
 * `news.json` is served from the real news task run over the dated feed captures in
 * tests/fixtures/upstream/news-* (no invented items); its observation times are those captures' times.
 */
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { createFixtureHttp } from '../../../scripts/lib/http.mjs';
import { buildNewsEnvelope, loadNewsSources } from '../../../scripts/snapshot/tasks/news.mjs';

const FIXTURES = fileURLToPath(new URL('../../fixtures/upstream/', import.meta.url));

/** @type {any} */
let envelope;

test.beforeAll(async () => {
  const http = await createFixtureHttp(FIXTURES);
  const ctx = { now: new Date('2026-10-05T10:00:00Z'), http, previous: async () => null, registry: /** @type {any} */ ({}), reference: async () => null, log: () => {} };
  envelope = await buildNewsEnvelope(ctx, await loadNewsSources());
});

/**
 * Serve the envelope (optionally edited) and record every request.
 * @param {import('@playwright/test').Page} page
 * @param {(env: any) => any} [edit]
 * @returns {Promise<{ urls: string[] }>}
 */
async function mockNews(page, edit) {
  /** @type {string[]} */
  const urls = [];
  page.on('request', (r) => urls.push(r.url()));
  const body = JSON.stringify(edit ? edit(structuredClone(envelope)) : envelope);
  await page.route('**/data/live/news.json', (route) => route.fulfill({ status: 200, contentType: 'application/json', body }));
  return { urls };
}

test('headlines render on load, latest first across every source', async ({ page }) => {
  await mockNews(page);
  await page.goto('news/');
  const cards = page.locator('[data-news-item]');
  await expect(cards.first()).toBeVisible();
  expect(await cards.count()).toBe(envelope.items.length);
  const times = await cards.evaluateAll((els) => els.map((e) => e.querySelector('time')?.getAttribute('datetime') ?? ''));
  expect([...times].sort().reverse()).toEqual(times);
  const first = await cards.evaluateAll((els) => els.slice(0, 12).map((e) => e.querySelector('.news-item__meta')?.textContent ?? ''));
  expect(new Set(first.map((t) => t.split('·')[1]?.trim())).size).toBeGreaterThan(1);
});

test('every headline link is https and opens in a new tab with rel noopener', async ({ page }) => {
  await mockNews(page);
  await page.goto('news/');
  await expect(page.locator('[data-news-item]').first()).toBeVisible();
  const links = await page.locator('[data-news-item] a').evaluateAll((as) => as.map((a) => ({ href: /** @type {HTMLAnchorElement} */ (a).href, target: a.getAttribute('target'), rel: a.getAttribute('rel') ?? '' })));
  expect(links.length).toBeGreaterThan(20);
  for (const l of links) {
    expect(l.href).toMatch(/^https:\/\//);
    expect(l.target).toBe('_blank');
    expect(l.rel).toContain('noopener');
  }
});

test('YouTube items are text links with no image, no player, and no request to YouTube on load', async ({ page }) => {
  const { urls } = await mockNews(page);
  await page.goto('news/');
  const videos = page.locator('[data-news-item][data-kind="video"]');
  await expect(videos.first()).toBeVisible();
  expect(await videos.count()).toBeGreaterThan(1);
  await expect(videos.first().locator('a', { hasText: 'Watch on YouTube' })).toHaveAttribute('href', /^https:\/\/www\.youtube\.com\/watch\?v=/);
  expect(await videos.first().locator('img, iframe, video, picture, embed, object').count()).toBe(0);
  await page.waitForLoadState('networkidle');
  expect(urls.filter((u) => /youtube|ytimg|googlevideo/i.test(u))).toEqual([]);
});

test('every request goes to this site; nothing reaches a feed, a proxy, or a third party', async ({ page }) => {
  const { urls } = await mockNews(page);
  await page.goto('news/');
  await expect(page.locator('[data-news-item]').first()).toBeVisible();
  await page.waitForLoadState('networkidle');
  const hosts = new Set(urls.map((u) => new URL(u).hostname));
  expect([...hosts]).toEqual(['localhost']);
});

test('Reddit communities are labeled links only, in their own section, never fetched', async ({ page }) => {
  const { urls } = await mockNews(page);
  await page.goto('news/');
  const section = page.locator('[data-panel="news-community"]');
  await expect(section.locator('a').first()).toBeVisible();
  await expect(section.getByRole('heading', { name: 'Community, Unverified' })).toBeVisible();
  const links = await section.locator('li a').evaluateAll((as) => as.map((a) => /** @type {HTMLAnchorElement} */ (a).href));
  expect(links.length).toBe(5);
  for (const l of links) expect(l).toMatch(/^https:\/\/www\.reddit\.com\/r\//);
  for (const li of await section.locator('li').all()) await expect(li).toContainText('Community, Unverified');
  expect(urls.filter((u) => /reddit/i.test(u))).toEqual([]);
  await expect(page.locator('[data-news-list] a[href*="reddit.com"]')).toHaveCount(0);
});

test('per-source status names every feed, its last answer, and what is shown', async ({ page }) => {
  await mockNews(page, (env) => {
    env.completeness = 'partial';
    env.perSource['news-kiro7'] = { ok: false, count: env.perSource['news-kiro7'].count, asOf: env.perSource['news-kiro7'].asOf, completeness: 'rejected', carriedForward: true };
    return env;
  });
  await page.goto('news/');
  const status = page.locator('.news-status');
  await expect(status).toBeVisible();
  const rows = status.locator('li');
  await expect(rows).toHaveCount(Object.keys(envelope.perSource).length);
  await expect(status.getByText(/KIRO 7 \(Seattle\) feed has not answered since \d\d\/\d\d\/\d{4} \d{1,2}:\d\d [AP]M [A-Z]{2,4}\. Showing 10 earlier headlines\./)).toBeVisible();
  await expect(status.getByText(/Oregon Public Broadcasting feed answered/)).toBeVisible();
  await expect(status.getByText(/Idaho Office of Emergency Management feed answered .*: no headlines in the last 60 days\./)).toBeVisible();
  // The panel as a whole reports a partial result rather than a clean one.
  await expect(page.locator('[data-panel="news"] [data-provenance]')).toHaveAttribute('data-status', /degraded|stale/);
});

test('search keeps focus and the same input element while it filters; the URL follows', async ({ page }) => {
  await mockNews(page);
  await page.goto('news/');
  const cards = page.locator('[data-news-item]');
  await expect(cards.first()).toBeVisible();
  const total = await cards.count();
  const input = page.getByLabel('Search headlines');
  await input.click();
  await input.evaluate((el) => { /** @type {any} */ (el).__mark = 'same-node'; });
  const word = (await cards.first().locator('.news-item__title').innerText()).split(/\s+/).find((w) => w.replace(/\W/g, '').length > 4)?.replace(/\W/g, '') ?? '';
  expect(word.length).toBeGreaterThan(4);
  for (const ch of word) {
    await page.keyboard.type(ch);
    const state = await page.evaluate(() => ({
      focused: document.activeElement?.id,
      mark: /** @type {any} */ (document.activeElement)?.__mark,
    }));
    expect(state).toEqual({ focused: 'news-q', mark: 'same-node' });
  }
  const shown = await page.locator('[data-news-item]:not([hidden])').count();
  expect(shown).toBeGreaterThan(0);
  expect(shown).toBeLessThan(total);
  expect(await cards.count()).toBe(total);
  await expect(page).toHaveURL(new RegExp(`[?&]q=${word}`));
  // A background refresh would rebuild the list but never the input: simulate one and type again.
  await page.keyboard.type('zzzzzz');
  await expect(page.locator('[data-news-empty]')).toBeVisible();
  await expect(input).toBeFocused();
  await input.fill('');
  expect(await page.locator('[data-news-item]:not([hidden])').count()).toBe(total);
  await expect(page.locator('[data-news-empty]')).toBeHidden();
});

test('filters by kind and place, and a shared URL restores them', async ({ page }) => {
  await mockNews(page);
  await page.goto('news/?kind=video&j=WA');
  await expect(page.locator('[data-news-item]:not([hidden])').first()).toBeVisible();
  const visible = page.locator('[data-news-item]:not([hidden])');
  expect(await visible.count()).toBeGreaterThan(0);
  expect(await visible.evaluateAll((els) => els.every((e) => e.getAttribute('data-kind') === 'video'))).toBe(true);
  await expect(page.getByRole('button', { name: /^Video/ })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByLabel('Place')).toHaveValue('WA');

  await page.getByRole('button', { name: /^Video/ }).click();
  await page.getByRole('button', { name: /^Official/ }).click();
  await expect(page).toHaveURL(/kind=official/);
  await page.getByLabel('Place').selectOption('BC');
  await expect(page).toHaveURL(/j=BC/);
  await page.getByRole('button', { name: /^Official/ }).click();
  const bc = page.locator('[data-news-item]:not([hidden])');
  expect(await bc.count()).toBeGreaterThan(0);
  await expect(page.locator('[data-news-item][data-kind="official"]:not([hidden])')).toHaveCount(0);
});

test('Official First puts official headlines ahead; Latest First is the default', async ({ page }) => {
  await mockNews(page, (env) => {
    env.items.push({ id: 'aaaaaaaaaaaaaaaa', sourceId: 'news-idaho-oem', title: 'Official ordering check', url: 'https://ioem.idaho.gov/ordering-check/', published: '2026-09-20T00:00:00.000Z', summary: '', kind: 'official', regions: ['ID'] });
    return env;
  });
  await page.goto('news/');
  await expect(page.getByLabel('Order')).toHaveValue('latest');
  const kinds = () => page.locator('[data-news-item]').evaluateAll((els) => els.map((e) => e.getAttribute('data-kind')));
  expect((await kinds())[0]).not.toBe('official');
  await page.getByLabel('Order').selectOption('official');
  await expect(page).toHaveURL(/sort=official/);
  expect((await kinds())[0]).toBe('official');
});

test('every panel carries a provenance footer naming its source, a time, and a status', async ({ page }) => {
  await mockNews(page);
  await page.goto('news/');
  await expect(page.locator('[data-news-item]').first()).toBeVisible();
  const panels = page.locator('[data-panel]');
  expect(await panels.count()).toBe(3);
  for (const p of await panels.all()) {
    const f = p.locator('[data-provenance]');
    await expect(f).toHaveAttribute('data-source-ids', 'cthd-news');
    await expect(f.locator('time[datetime]').first()).toBeVisible();
    await expect(f.locator('.status-pill')).toBeVisible();
  }
});

test('with no scheduled copy the panel says Unavailable and shows no sample headlines', async ({ page }) => {
  await page.route('**/data/live/news.json', (route) => route.fulfill({ status: 404, body: 'not found' }));
  await page.goto('news/');
  const panel = page.locator('[data-panel="news"]');
  await expect(panel.locator('[data-provenance]')).toHaveAttribute('data-status', 'unavailable');
  await expect(panel.locator('.panel__unavailable')).toContainText('Headlines are unavailable right now');
  await expect(page.locator('[data-news-item]')).toHaveCount(0);
  // The source directory still stands on its own, so a reader has somewhere to go.
  await expect(page.locator('[data-panel="news-directory"] a').first()).toBeVisible();
});

test('a rejected scheduled copy is also Unavailable, not an empty list', async ({ page }) => {
  await mockNews(page, (env) => ({ ...env, completeness: 'rejected', items: [], failure: { code: 'upstream', message: 'No news feed could be read.', at: env.generatedAt } }));
  await page.goto('news/');
  await expect(page.locator('[data-panel="news"] [data-provenance]')).toHaveAttribute('data-status', 'unavailable');
  await expect(page.locator('[data-news-item]')).toHaveCount(0);
});

test('embed mode keeps the footer note, the filters, and the provenance', async ({ page }) => {
  await mockNews(page);
  await page.goto('news/?embed=1');
  await expect(page.locator('html')).toHaveAttribute('data-embed', '1');
  await expect(page.locator('[data-news-item]').first()).toBeVisible();
  await expect(page.getByLabel('Search headlines')).toBeVisible();
  await expect(page.locator('[data-panel="news"] [data-provenance]')).toBeVisible();
  await expect(page.locator('.site-footer__sovereignty')).toBeVisible();
});

test('no horizontal scroll at phone width', async ({ page }) => {
  await mockNews(page);
  await page.goto('news/');
  await expect(page.locator('[data-news-item]').first()).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1)).toBe(false);
});
