// @ts-check
/**
 * Archive pages acceptance (blueprint 7.9, 12.3 lane L14): the persistent "Archived event" banner shows, the
 * timeline is rendered from the compiled event file with original dates, dead links are labeled, and the page
 * makes zero live requests: no data/live file, no upstream, no third-party host.
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';

const EVENT_PATH = 'archive/2025-12-atmospheric-river/';

/** @returns {Promise<any>} the compiled event (the dev server compiles before it serves) */
async function compiledEvent() {
  const file = fileURLToPath(new URL('../../../site/data/curated/events.json', import.meta.url));
  const doc = JSON.parse(await readFile(file, 'utf8'));
  return doc.items.find((/** @type {any} */ e) => e.id === '2025-12-atmospheric-river');
}

/** @param {import('@playwright/test').Page} page */
function trackRequests(page) {
  /** @type {string[]} */
  const urls = [];
  page.on('request', (r) => urls.push(r.url()));
  return urls;
}

test('the archived event shows its banner, from the event file\'s own dates', async ({ page }) => {
  const ev = await compiledEvent();
  await page.goto(EVENT_PATH);
  const banner = page.locator('.archive-banner');
  await expect(banner).toBeVisible();
  const [sy, sm, sd] = ev.period.start.split('-');
  const [ey, em, ed] = ev.period.end.split('-');
  await expect(banner).toHaveText(`Archived event: ${sm}/${sd}/${sy} to ${em}/${ed}/${ey}. This information is not current.`);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('December 2025 Atmospheric Rivers');
});

test('the page makes zero live requests: only this site\'s own static files', async ({ page }) => {
  const urls = trackRequests(page);
  await page.goto(EVENT_PATH);
  await expect(page.locator('.archive-entry').first()).toBeVisible();
  await page.waitForLoadState('networkidle');
  const parsed = urls.map((u) => new URL(u));
  expect([...new Set(parsed.map((u) => u.hostname))]).toEqual(['localhost']);
  expect(parsed.filter((u) => u.pathname.includes('/data/live/'))).toEqual([]);
  expect(parsed.filter((u) => u.pathname.includes('/data/') && !u.pathname.includes('/data/curated/')).map((u) => u.pathname)).toEqual([]);
});

test('the index page makes zero live requests and lists the event', async ({ page }) => {
  const urls = trackRequests(page);
  await page.goto('archive/');
  const link = page.getByRole('link', { name: 'December 2025 Atmospheric River and Flooding' });
  await expect(link).toBeVisible();
  await expect(link).toHaveAttribute('href', './2025-12-atmospheric-river/');
  await page.waitForLoadState('networkidle');
  const parsed = urls.map((u) => new URL(u));
  expect([...new Set(parsed.map((u) => u.hostname))]).toEqual(['localhost']);
  expect(parsed.filter((u) => u.pathname.includes('/data/live/'))).toEqual([]);
  await link.click();
  await expect(page).toHaveURL(/archive\/2025-12-atmospheric-river\/$/);
  await expect(page.locator('.archive-banner')).toBeVisible();
});

test('the timeline lists every entry with its original date, kind, issuer, and a link to the source', async ({ page }) => {
  const ev = await compiledEvent();
  await page.goto(EVENT_PATH);
  const entries = page.locator('.archive-entry');
  await expect(entries).toHaveCount(ev.entries.length);
  const dates = await entries.evaluateAll((els) => els.map((e) => e.querySelector('time')?.getAttribute('datetime') ?? ''));
  expect([...dates].sort()).toEqual(dates);
  for (const e of ev.entries) {
    const [y, m, d] = e.date.split('-');
    const card = entries.filter({ hasText: e.title });
    await expect(card).toHaveCount(1);
    await expect(card).toContainText(`${m}/${d}/${y}`);
    await expect(card).toContainText(`Issued by ${e.issuedBy}`);
    await expect(card.locator('a').first()).toHaveAttribute('href', e.url);
    await expect(card.locator('a').first()).toHaveAttribute('target', '_blank');
  }
  // FEMA numbers link to fema.gov.
  for (const n of ev.femaDisasterNumbers) {
    await expect(page.getByRole('link', { name: String(n), exact: true })).toHaveAttribute('href', `https://www.fema.gov/disaster/${n}`);
  }
});

test('a dead link is labeled, and an archived copy is offered when one is recorded', async ({ page }) => {
  const ev = await compiledEvent();
  const dead = { ...ev.entries[0], title: 'Dead link check', linkStatus: 'dead', archiveUrl: 'https://web.archive.org/web/2026/https://example.test/gone' };
  const deadNone = { ...ev.entries[0], title: 'Dead link without copy', linkStatus: 'dead', archiveUrl: null };
  await page.route('**/data/curated/events.json', async (route) => {
    const res = await route.fetch();
    const doc = await res.json();
    doc.items[0].entries = [...doc.items[0].entries, dead, deadNone];
    await route.fulfill({ response: res, json: doc });
  });
  await page.goto(EVENT_PATH);
  const a = page.locator('.archive-entry', { hasText: 'Dead link check' });
  await expect(a).toContainText('This link no longer works.');
  await expect(a.getByRole('link', { name: 'Internet Archive copy' })).toHaveAttribute('href', dead.archiveUrl);
  const b = page.locator('.archive-entry', { hasText: 'Dead link without copy' });
  await expect(b).toContainText('No archived copy is on record.');
  await expect(b.getByRole('link', { name: 'Internet Archive copy' })).toHaveCount(0);
});

test('the provenance footer names its source and a time, and says Stale, never Live', async ({ page }) => {
  await page.goto(EVENT_PATH);
  const footer = page.locator('[data-panel] [data-provenance]');
  await expect(footer).toHaveAttribute('data-source-ids', 'cthd-events');
  await expect(footer).toHaveAttribute('data-status', 'stale');
  await expect(footer.locator('time[datetime]').first()).toBeVisible();
  await expect(footer).toContainText('Archived event, not current');
  await expect(footer).toContainText(/link checked \d\d\/\d\d\/\d{4}/);
});

test('the banner and the footer notes stay in embed mode', async ({ page }) => {
  await page.goto(`${EVENT_PATH}?embed=1`);
  await expect(page.locator('html')).toHaveAttribute('data-embed', '1');
  await expect(page.locator('.archive-banner')).toBeVisible();
  await expect(page.locator('.archive-entry').first()).toBeVisible();
  await expect(page.locator('[data-panel] [data-provenance]')).toBeVisible();
  await expect(page.locator('.site-footer__sovereignty')).toBeVisible();
});

test('if the archive file cannot be read, the page says so and shows no sample entries', async ({ page }) => {
  await page.route('**/data/curated/events.json', (route) => route.fulfill({ status: 404, body: 'gone' }));
  await page.goto(EVENT_PATH);
  await expect(page.locator('[data-panel] [data-provenance]')).toHaveAttribute('data-status', 'unavailable');
  await expect(page.locator('.panel__unavailable')).toContainText('could not be displayed');
  await expect(page.locator('.archive-entry')).toHaveCount(0);
  await expect(page.locator('.archive-banner')).toBeVisible();
});

test('no horizontal scroll at phone width, on either page', async ({ page }) => {
  for (const path of ['archive/', EVENT_PATH]) {
    await page.goto(path);
    await expect(page.locator('[data-panel] [data-provenance] time').first()).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1)).toBe(false);
  }
});
