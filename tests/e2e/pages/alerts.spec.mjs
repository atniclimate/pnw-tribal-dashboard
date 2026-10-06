// @ts-check
/**
 * Alerts and Declarations page (lane L11, blueprint 7.2). The scheduled copies the page reads (data/live) are
 * produced by the real snapshot runner from the dated upstream captures of 10/05/2026, and the browser clock
 * is fixed to the capture hour so those alerts are current. Upstream hosts are unreachable, so every
 * assertion is about what the page does with the scheduled copy and says about the failed live top-ups.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { attachGuards, horizontalOverflow } from '../support/harness.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const NOW = '2026-10-05T08:30:00Z';
const out = mkdtempSync(path.join(tmpdir(), 'cthd-l11-'));
execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'snapshot', 'run.mjs'), '--out', out, '--fixtures', path.join(ROOT, 'tests', 'fixtures', 'upstream'),
  '--tasks', 'alerts,tsunami,declarations', '--force', '--now', NOW], { cwd: ROOT, stdio: 'ignore' });
const live = (/** @type {string} */ f) => JSON.parse(readFileSync(path.join(out, f), 'utf8'));
const textItems = live('alerts-text.json').items;
const withInstruction = textItems.find((/** @type {any} */ t) => Object.values(t.sourceLanguage).some((b) => /** @type {any} */ (b).instruction));

/** @param {import('@playwright/test').Page} page */
async function setup(page) {
  const g = await attachGuards(page, { pageId: 'alerts' });
  await page.clock.setFixedTime(new Date(NOW));
  await page.route(/\/data\/live\/[a-z-]+\.json$/, async (route) => {
    const name = new URL(route.request().url()).pathname.split('/').pop() ?? '';
    try { return await route.fulfill({ status: 200, contentType: 'application/json', body: readFileSync(path.join(out, name)) }); } catch { return route.fallback(); }
  });
  return g;
}

test.describe('list view', () => {
  // No selected Nation means viewer time. Fix the zone independently of the host running this suite.
  test.use({ timezoneId: 'UTC' });

  test('paints the scheduled copy with provenance, honest counts, and no horizontal scroll', async ({ page }) => {
    const g = await setup(page);
    await page.goto('alerts/');
    await expect(page.locator('[data-panel="alerts-list"] .alert-card').first()).toBeVisible();
    await expect(page.locator('[data-panel="alerts-summary"] .alert-banner')).toContainText('in effect for Cascadia');
    for (const id of ['alerts-summary', 'alerts-list']) {
      await expect(page.locator(`[data-panel="${id}"] [data-provenance] time[datetime]`).first()).toBeVisible();
    }
    expect(await horizontalOverflow(page)).toBe(false);
    expect(g.pageErrors).toEqual([]);
  });

  test('no all-clear when sources are not live: with no copy at all, the page says unknown', async ({ page }) => {
    await attachGuards(page, { pageId: 'alerts' });
    await page.route(/\/data\/live\/[a-z-]+\.json$/, (route) => route.fulfill({ status: 404, body: 'x' }));
    await page.goto('alerts/');
    await expect(page.locator('[data-panel="alerts-summary"]')).toContainText('Alert status unknown');
    await expect(page.locator('[data-panel="alerts-summary"]')).toContainText('not an all-clear');
    await expect(page.locator('[data-panel="alerts-summary"]')).not.toContainText('No active');
  });

  test('filters use registry fields and round-trip through the URL', async ({ page }) => {
    await setup(page);
    await page.goto('alerts/?j=wa');
    await expect(page.locator('[data-result-count]')).toContainText('alerts shown');
    await expect(page.locator('[data-filters-details]')).toHaveAttribute('open', '');
    await expect(page.locator('[data-filter-key="j"] [data-value="wa"]')).toHaveAttribute('aria-pressed', 'true');
    const wa = await page.locator('[data-panel="alerts-list"] .alert-card').count();
    await page.locator('[data-filter-key="des"] [data-value="advisory"]').click();
    await expect(page).toHaveURL(/des=advisory/);
    await expect(page).toHaveURL(/j=wa/);
    await page.reload();
    await expect(page.locator('[data-filter-key="des"] [data-value="advisory"]')).toHaveAttribute('aria-pressed', 'true');
    expect(await page.locator('[data-panel="alerts-list"] .alert-card').count()).toBeLessThanOrEqual(wa);
    await page.locator('[data-filter-key="des"] [data-value="advisory"]').click();
    await expect(page).not.toHaveURL(/des=/);
  });

  test('summary tiles are pressed-state buttons that set the designation filter', async ({ page }) => {
    await setup(page);
    await page.goto('alerts/');
    const tile = page.locator('.summary-tile[data-designation="advisory"]');
    await expect(tile).toHaveAttribute('aria-pressed', 'false');
    await tile.click();
    await expect(page).toHaveURL(/des=advisory/);
    await expect(page.locator('.summary-tile[data-designation="advisory"]')).toHaveAttribute('aria-pressed', 'true');
  });

  test('a card shows the description verbatim and What to Do, with zone-correct times', async ({ page }) => {
    await setup(page);
    await page.goto('alerts/');
    const first = page.locator('[data-panel="alerts-list"] .alert-card').first();
    const time = first.locator('time').first();
    await expect(time).toBeVisible();
    const instant = new Date(await time.getAttribute('datetime') ?? '');
    const hour = instant.getUTCHours();
    await expect(time).toContainText(` ${hour % 12 || 12}:${String(instant.getUTCMinutes()).padStart(2, '0')} ${hour < 12 ? 'AM' : 'PM'} UTC`);
    const target = withInstruction ?? textItems[0];
    const block = /** @type {any} */ (Object.values(target.sourceLanguage)[0]);
    const card = page.locator(`[data-alert-id="${target.alertId}"]`);
    await card.locator('[data-action="toggle-text"]').click();
    const body = card.locator('.alert-card__body');
    await expect(body).toBeVisible();
    const firstLine = String(block.description).split('\n').find((l) => l.trim().length > 20) ?? '';
    await expect(body).toContainText(firstLine.trim());
    if (block.instruction) await expect(body.locator('.what-to-do')).toContainText((String(block.instruction).split('\n')[0] ?? '').trim());
  });

  test('BC evacuation and River Forecast Centre sections are absent while their sources are candidates', async ({ page }) => {
    await setup(page);
    await page.goto('alerts/');
    await expect(page.locator('[data-panel="alerts-list"] .alert-card').first()).toBeVisible();
    await expect(page.locator('[data-panel="bc-evacuations"]')).toHaveCount(0);
    await expect(page.locator('[data-panel="bc-rfc"]')).toHaveCount(0);
  });
});

test.describe('map view', () => {
  test('explains zone and polygon coverage and carries the sovereignty statement', async ({ page }) => {
    await setup(page);
    await page.goto('alerts/?view=map');
    await expect(page.locator('[data-coverage-legend]')).toHaveText('Dashed areas are forecast zones named in the alert; solid areas were drawn by the forecaster.');
    await expect(page.locator('[data-view="map"]')).toContainText('Representation, not jurisdiction.');
    await expect(page.locator('#alerts-map-twin .alert-card').first()).toBeVisible();
  });

  test('Show on Map focuses the alert: the map view opens on it, its card is current and focused', async ({ page }) => {
    await setup(page);
    await page.goto('alerts/');
    const card = page.locator('[data-panel="alerts-list"] .alert-card').first();
    const id = await card.getAttribute('data-alert-id');
    await card.locator('[data-action="show-on-map"]').click();
    await expect(page).toHaveURL(/view=map/);
    await expect(page).toHaveURL(/alert=/);
    const twin = page.locator(`#alerts-map-twin article[data-alert-id="${id}"]`);
    await expect(twin).toHaveAttribute('aria-current', 'true');
    await expect(twin).toBeFocused();
    await expect(twin.locator('.alert-card__body')).toBeVisible();
  });
});

test.describe('declarations view', () => {
  test('one disaster renders once with every designated area; Tribal requests are flagged; nothing is called active', async ({ page }) => {
    await setup(page);
    await page.goto('alerts/?view=declarations');
    const dr = page.locator('[data-declaration-id="fema:DR-4906-WA"]');
    await expect(dr).toHaveCount(1);
    await expect(dr.locator('[data-designated-areas] li')).toHaveCount(49);
    await expect(dr).toContainText('Major Disaster Declaration');
    await expect(dr).toContainText('not closed out');
    await expect(page.locator('[data-panel="declarations-fema"]')).not.toContainText(/\bactive\b/i);
    await page.locator('[data-filter-key="tribal"] [data-value="tribal"]').click();
    await expect(page).toHaveURL(/tribal=1/);
    await expect(page.locator('[data-panel="declarations-fema"] .tag--sovereignty').first()).toBeVisible();
    await expect(page.locator('[data-declaration-id="fema:DR-4906-WA"]')).toHaveCount(0);
  });

  test('curated declarations show a computed status, source, and verified date', async ({ page }) => {
    await setup(page);
    await page.goto('alerts/?view=declarations');
    const card = page.locator('[data-kind="curated-declaration"]').first();
    await expect(card).toBeVisible();
    await expect(card).toContainText(/In effect \(confirmed|Status not re-confirmed since|Ended/);
    await expect(card).toContainText('Verified');
    await expect(card.locator('a[href^="https://"]')).toHaveCount(1);
    await expect(page.locator('[data-panel="declarations-curated"] [data-provenance]')).toBeVisible();
  });
});
