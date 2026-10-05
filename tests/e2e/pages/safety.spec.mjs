// @ts-check
/**
 * L13 acceptance for the Safety page (blueprint 7.6): ten anchored sections, each with Before, During, and
 * After lists, a "Who Needs Extra Help" list, a Call line rendered from data, cited sources, and a reviewed
 * date; Active Now highlights for the selected Nation's alerts (the heat advisory is a dated real capture,
 * run through the alert engine's own normalizer); `?hz=` scrolls to a section; the kit checklist is saved
 * per viewer. Owner: lane L13.
 */
import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { attachGuards, axeProblems } from '../support/harness.mjs';
import { normalizeNwsCollection } from '../../../site/static/js/alerts/nws.js';
import { toIndexEntry } from '../../../site/static/js/alerts/model.js';

const root = new URL('../../../', import.meta.url);
const SECTIONS = ['flood', 'atmospheric-rivers', 'wind', 'winter', 'heat', 'smoke', 'wildfire', 'tsunami', 'earthquake', 'kit'];
const BIG_VALLEY = 'us-ca-big-valley-band-of-pomo-indians-of-the-big-valley-rancheria-california';

/** The scheduled-copy index a snapshot run would have written for the captured advisory. */
function snapshotEnvelope() {
  const capture = JSON.parse(readFileSync(new URL('tests/fixtures/upstream/nws-alerts-active/2026-10-05-point-big-valley-heat-advisory.json', root), 'utf8'));
  const now = new Date('2026-10-05T10:00:00Z');
  const { alerts } = normalizeNwsCollection(capture, { fetchedAt: '2026-10-05T09:50:00Z', now });
  return {
    schema: 'cthd.live.alerts/1', id: 'alerts', sourceIds: ['nws-alerts-active'], generatedAt: '2026-10-05T09:50:00Z', observedAt: '2026-10-05T09:50:00Z',
    asOf: '2026-10-05T09:50:00Z', asOfBasis: 'issued', completeness: 'complete', carriedForward: false, failure: null,
    perSource: { 'nws-alerts-active': { ok: true, count: alerts.length, asOf: '2026-10-05T09:50:00Z' } }, diagnostics: {},
    items: alerts.map((a) => ({ ...toIndexEntry(a), nationIds: [BIG_VALLEY] })),
  };
}

test.describe('content', () => {
  test('ten anchored sections carry Before, During, After, extra help, a Call line, cited sources, and a checked date', async ({ page }) => {
    await attachGuards(page, { pageId: 'safety' });
    await page.goto('safety/');
    for (const id of SECTIONS) {
      const s = page.locator(`section.safety-section#${id}`);
      await expect(s, id).toHaveCount(1);
      await expect(s.getByRole('heading', { name: 'Who Needs Extra Help' })).toBeVisible();
      await expect(s.locator('[data-call]')).toBeVisible();
      await expect(s.locator('.caption', { hasText: /Sources checked \d{2}\/\d{2}\/\d{4}/ })).toBeVisible();
      expect(await s.locator('.caption a[href^="https://"]').count(), `${id} cites at least one source`).toBeGreaterThan(0);
      if (id !== 'kit') for (const h of ['Before', 'During', 'After']) await expect(s.getByRole('heading', { name: h, exact: true }), `${id} ${h}`).toBeVisible();
    }
    await expect(page.getByText('Turn Around, Don', { exact: false }).first()).toBeVisible();
    await expect(page.locator('[data-review-status="draft"]')).toContainText('Draft');
  });

  test('the hazard anchors used by alert links all resolve to a section', async ({ page }) => {
    await attachGuards(page, { pageId: 'safety' });
    await page.goto('safety/');
    const hazards = JSON.parse(readFileSync(new URL('site/data/ref/hazards.json', root), 'utf8')).categories;
    for (const [key, v] of Object.entries(hazards)) {
      const anchor = /** @type {{ safetyAnchor: string | null }} */ (v).safetyAnchor;
      if (!anchor) continue;
      expect(await page.locator(`[id="${anchor}"]`).count(), `${key} -> #${anchor}`).toBe(1);
    }
  });

  test('Call lines come from the compiled contacts, with tel: links in E.164', async ({ page }) => {
    await attachGuards(page, { pageId: 'safety' });
    await page.goto('safety/?n=us-wa-lummi-tribe-of-the-lummi-reservation');
    const line = page.locator('#flood [data-call]');
    await expect(line.locator('a[href^="tel:+1"]').first()).toBeVisible();
    const hrefs = await line.locator('a[href^="tel:"]').evaluateAll((as) => as.map((a) => a.getAttribute('href')));
    for (const h of hrefs) expect(h).toMatch(/^tel:(911|\+[1-9]\d{6,14})$/);
    await expect(line).toContainText('State Alert and Warning Center');
    await expect(page.locator('[data-panel="safety-call"] [data-panel-body]')).toContainText('800-258-5990');
  });

  test('has no serious accessibility violations', async ({ page }) => {
    await attachGuards(page, { pageId: 'safety' });
    await page.goto('safety/');
    await page.waitForSelector('[data-panel="safety-call"] [data-provenance]');
    expect(await axeProblems(page)).toEqual([]);
  });
});

test.describe('active alerts and links', () => {
  test('with no Nation selected, Active Now says so and names an official link', async ({ page }) => {
    await attachGuards(page, { pageId: 'safety' });
    await page.goto('safety/');
    const panel = page.locator('[data-panel="safety-active"]');
    await expect(panel.locator('[data-provenance]')).toHaveAttribute('data-status', 'unavailable');
    await expect(panel).toContainText('Choose a Nation');
    await expect(panel.locator('a[href^="https://www.weather.gov"]').first()).toBeVisible();
  });

  test('a Nation with an active heat advisory highlights the Extreme Heat section and links to it', async ({ page }) => {
    await page.clock.setFixedTime(new Date('2026-10-05T10:00:00Z'));
    await attachGuards(page, { pageId: 'safety' });
    await page.route('**/data/live/alerts.json', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(snapshotEnvelope()) }));
    await page.route('**/data/live/tsunami.json', (r) => r.fulfill({ status: 404, body: '' }));
    await page.goto(`safety/?n=${BIG_VALLEY}`);
    const label = page.locator('#heat [data-active-now]');
    await expect(label).toBeVisible({ timeout: 20_000 });
    await expect(label).toContainText('Active Now: Heat Advisory');
    await expect(page.locator('#flood [data-active-now]')).toBeHidden();
    const link = page.locator('[data-active-list] a[href="#heat"]');
    await expect(link).toContainText('Active Now: Heat Advisory');
    await expect(page.locator('[data-panel="safety-active"] [data-provenance] time[datetime]').first()).toBeVisible();
  });

  test('?hz=flood scrolls to and marks the flood section; a hazard category from an alert link works too', async ({ page }) => {
    await attachGuards(page, { pageId: 'safety' });
    await page.goto('safety/?hz=rain-landslide');
    await expect(page.locator('#atmospheric-rivers')).toHaveAttribute('data-linked', 'true');
    await expect(page.locator('#atmospheric-rivers h2')).toBeFocused();
    await page.goto('safety/?hz=flood');
    await expect(page.locator('#flood')).toHaveAttribute('data-linked', 'true');
  });
});

test.describe('kit checklist', () => {
  test('real checkboxes are saved on this device and survive a reload', async ({ page }) => {
    await attachGuards(page, { pageId: 'safety' });
    await page.goto('safety/');
    const water = page.locator('input[data-kit="water"]');
    await water.check();
    await page.reload();
    await expect(page.locator('input[data-kit="water"]')).toBeChecked();
    await expect(page.locator('input[data-kit="food"]')).not.toBeChecked();
    expect(await page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('cthd:v1:safety-kit')))).toHaveLength(1);
  });
});
