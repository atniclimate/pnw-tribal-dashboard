// @ts-check
/**
 * L13 acceptance for the Usage page (blueprint 7.8): the sources table is generated from sources.json, the
 * status legend shows the five states, the Usage view names a correction and removal route for Nations, the
 * sovereignty statement is present, and the privacy host list comes from the registry. Owner: lane L13.
 */
import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { attachGuards, axeProblems } from '../support/harness.mjs';

const root = new URL('../../../', import.meta.url);
const sources = JSON.parse(readFileSync(new URL('site/data/curated/sources.json', root), 'utf8')).items;

test.describe('usage', () => {
  test('the Usage view names the safety notice, the predecessor, a correction route for Nations, and the sovereignty statement', async ({ page }) => {
    await attachGuards(page, { pageId: 'usage' });
    await page.goto('usage/');
    await expect(page.locator('[data-view="usage"] .callout', { hasText: 'This dashboard does not replace official warnings or 911. In an emergency, call 911.' })).toBeVisible();
    await expect(page.getByText('IndigenousACCESS.org', { exact: false }).first()).toBeVisible();
    const route = page.locator('#contact a[href="mailto:climate@atnitribes.org"]');
    await expect(route).toBeVisible();
    await expect(page.locator('#contact')).toContainText('corrected or removed');
    await expect(page.locator('#sovereignty .sovereignty-note')).toContainText('Representation, not jurisdiction.');
    await expect(page.locator('#sovereignty a[href="mailto:climate@atnitribes.org"]')).toBeVisible();
    await expect(page.getByText(/Last reviewed \d{2}\/\d{2}\/\d{4}/)).toBeVisible();
  });

  test('the Sources view is generated from sources.json: one row per source, with licence and verified date', async ({ page }) => {
    await attachGuards(page, { pageId: 'usage' });
    await page.goto('usage/?view=sources');
    const rows = page.locator('[data-panel="usage-sources"] tbody tr');
    await expect(rows).toHaveCount(sources.length);
    const sample = sources[0];
    const row = page.locator(`tr#src-${sample.id}`);
    await expect(row).toContainText(sample.title);
    await expect(row).toContainText(sample.owner);
    await expect(row).toContainText(/\d{2}\/\d{2}\/\d{4}/);
    await expect(page.locator('[data-panel="usage-sources"] [data-provenance] time[datetime]').first()).toBeVisible();
  });

  test('the Status view shows the five-state legend and says plainly when no status table is published', async ({ page }) => {
    await attachGuards(page, { pageId: 'usage' });
    await page.route('**/data/live/health.json', (r) => r.fulfill({ status: 404, body: '' }));
    await page.goto('usage/?view=status');
    for (const label of ['Live', 'Saved on Device', 'Stale', 'Degraded', 'Unavailable']) {
      await expect(page.locator('[data-status-legend] .status-pill__label', { hasText: label })).toBeVisible();
    }
    const panel = page.locator('[data-panel="usage-status"]');
    await expect(panel.locator('[data-provenance]')).toHaveAttribute('data-status', 'unavailable');
    await expect(panel).toContainText('not been published yet');
  });

  test('the Privacy view lists the hosts a browser contacts, from the registry', async ({ page }) => {
    await attachGuards(page, { pageId: 'usage' });
    await page.goto('usage/?view=privacy');
    await expect(page.locator('[data-host-list] li', { hasText: 'api.weather.gov' })).toBeVisible();
    await expect(page.locator('#privacy-h')).toBeVisible();
  });

  test('the Accessibility view states the target and a contact', async ({ page }) => {
    await attachGuards(page, { pageId: 'usage' });
    await page.goto('usage/?view=accessibility');
    await expect(page.locator('#accessibility-h')).toBeVisible();
    await expect(page.locator('[data-view="accessibility"] a[href="mailto:climate@atnitribes.org"]')).toBeVisible();
  });

  test('has no serious accessibility violations on the Sources view', async ({ page }) => {
    await attachGuards(page, { pageId: 'usage' });
    await page.goto('usage/?view=sources');
    await page.waitForSelector('[data-panel="usage-sources"] tbody tr');
    expect(await axeProblems(page)).toEqual([]);
  });
});
