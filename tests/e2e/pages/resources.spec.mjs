// @ts-check
/**
 * L13 acceptance for the Resources page (blueprint 7.5): every item shows its publisher, a tel: link when it
 * has a phone, and its verified date and source; filters apply live without losing focus; British Columbia
 * is a jurisdiction (and says plainly when nothing is on file); Print and Copy List carry the filter note.
 * Owner: lane L13.
 */
import { expect, test } from '@playwright/test';
import { attachGuards, axeProblems } from '../support/harness.mjs';

test.describe('resources', () => {
  test('every item names its publisher, its verified date and source, and any phone as a tel: link', async ({ page }) => {
    await attachGuards(page, { pageId: 'resources' });
    await page.goto('resources/');
    await page.waitForSelector('[data-resource-id].contact-card');
    const bad = await page.evaluate(() => [...document.querySelectorAll('article[data-resource-id]')].flatMap((c) => {
      const p = [];
      const text = c.textContent ?? '';
      if (!/Verified \d{2}\/\d{2}\/\d{4}\. Source: /.test(text)) p.push('no verified date and source');
      if (!c.querySelector('.contact-card__role')?.textContent) p.push('no publisher');
      for (const a of c.querySelectorAll('a[href^="tel:"]')) if (!/^tel:(\d{3}|\+[1-9]\d{6,14})$/.test(a.getAttribute('href') ?? '')) p.push(`tel ${a.getAttribute('href')}`);
      return p.map((x) => `${c.getAttribute('data-resource-id')}: ${x}`);
    }));
    expect(bad).toEqual([]);
    await expect(page.locator('section[data-category]').first().getByRole('heading', { level: 3 })).toBeVisible();
  });

  test('filtering keeps focus, and the note and URL follow the filter', async ({ page }) => {
    await attachGuards(page, { pageId: 'resources' });
    await page.goto('resources/');
    await page.waitForSelector('[data-resource-id].contact-card');
    const search = page.getByLabel('Search Resources');
    await search.focus();
    const visible = () => page.locator('li[data-resource-id]:not([hidden])').count();
    const before = await visible();
    await page.keyboard.type('red cross');
    await expect(search).toBeFocused();
    expect(await visible()).toBeLessThan(before);
    await expect(page.locator('[data-filter-note]')).toContainText('Search: "red cross"');
    await expect(page).toHaveURL(/q=red\+cross|q=red%20cross/);
  });

  test('British Columbia is a jurisdiction, and an empty result says so plainly', async ({ page }) => {
    await attachGuards(page, { pageId: 'resources' });
    await page.goto('resources/?jur=BC');
    await page.waitForSelector('[data-no-matches]:not([hidden]), li[data-resource-id]:not([hidden])');
    const bcChip = page.getByRole('button', { name: 'British Columbia', exact: true });
    await expect(bcChip).toHaveAttribute('aria-pressed', 'true');
    const shown = await page.locator('li[data-resource-id]:not([hidden])').count();
    if (shown === 0) await expect(page.locator('[data-no-matches]')).toContainText('No British Columbia resources are on file yet');
  });

  test('Copy List and Print carry the filter note', async ({ page, context, browserName }) => {
    test.skip(browserName !== 'chromium', 'clipboard permissions are a Chromium feature');
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await attachGuards(page, { pageId: 'resources' });
    await page.goto('resources/?cat=rivers');
    await page.waitForSelector('li[data-resource-id]:not([hidden])');
    await page.getByRole('button', { name: 'Copy List' }).focus();
    await page.keyboard.press('Enter');
    const copied = await page.evaluate(() => navigator.clipboard.readText());
    expect((copied.split('\n')[0] ?? '').trim()).toMatch(/^Filter: Category: Rivers and Flood Information\. \d+ of \d+ resources\.$/);
    await page.emulateMedia({ media: 'print' });
    await expect(page.locator('[data-filter-note]')).toBeVisible();
    await expect(page.locator('[data-filter-note]')).toContainText('Category: Rivers and Flood Information');
  });

  test('a seasonal item is hidden out of season and shown in season (pure filter, dated)', async () => {
    const { filterResources } = await import('../../../site/static/js/data/resources.js');
    const item = /** @type {any} */ ({ id: 'x', title: 'Seasonal', url: 'https://a', publisher: 'P', description: 'd', category: 'preparedness', hazards: ['other'], scope: { level: 'federal', region: null }, nationId: null, phone: null, status: 'seasonal', validFrom: '2026-06-01', validUntil: '2026-09-30', verifiedAt: '2026-10-05', sourceUrl: 'https://a' });
    expect(filterResources([item], {}, new Date('2026-10-05T12:00:00Z'))).toHaveLength(0);
    expect(filterResources([item], {}, new Date('2026-09-30T23:00:00Z'))).toHaveLength(1);
  });

  test('has no serious accessibility violations', async ({ page }) => {
    await attachGuards(page, { pageId: 'resources' });
    await page.goto('resources/');
    await page.waitForSelector('[data-resource-id].contact-card');
    expect(await axeProblems(page)).toEqual([]);
  });
});
