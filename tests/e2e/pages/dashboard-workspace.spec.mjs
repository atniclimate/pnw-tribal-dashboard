// @ts-check
/** Connected journeys using captured official snapshots; external failures are explicit. */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { attachGuards, horizontalOverflow, axeProblems } from '../support/harness.mjs';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const out = path.join(ROOT, '.cache/dashboard-workspace-fixtures');
mkdirSync(out, { recursive: true });
execFileSync(process.execPath, ['scripts/snapshot/run.mjs', '--out', out, '--fixtures', 'tests/fixtures/upstream', '--tasks', 'alerts,tsunami,gauges,wsc', '--force', '--now', '2026-10-05T08:30:00Z'], { cwd: ROOT, stdio: 'ignore', windowsHide: true });
const LUMMI = 'us-wa-lummi-tribe-of-the-lummi-reservation';
/** @param {import('@playwright/test').Page} page */
async function setup(page) {
  const guards = await attachGuards(page, { pageId: 'dashboard', down: true });
  // Preserve performance.mark, which is the alert-before-map loading boundary.
  await page.addInitScript(({ now }) => {
    const NativeDate = Date;
    window.Date = new Proxy(NativeDate, {
      construct(target, args) { return Reflect.construct(target, args.length ? args : [now]); },
      get(target, key) { return key === 'now' ? () => now : Reflect.get(target, key); },
    });
  }, { now: Date.parse('2026-10-05T08:30:00Z') });
  await page.route('**/data/live/**', route => {
    const name = new URL(route.request().url()).pathname.split('/').pop() ?? '';
    try { return route.fulfill({ status: 200, contentType: 'application/json', body: readFileSync(path.join(out, name)) }); }
    catch { return route.fulfill({ status: 404, body: '' }); }
  });
  return guards;
}
/** @param {import('@playwright/test').Page} page @param {string} query @param {string} name */
async function choose(page, query, name) {
  await page.locator('[data-dashboard-picker]').click();
  const dialog = page.getByRole('dialog', { name: 'Choose a Nation' });
  await dialog.getByRole('combobox', { name: 'Tribal Nation or First Nation' }).fill(query);
  await dialog.getByRole('option', { name: new RegExp(name) }).click();
  await expect(page.locator('[data-scope-heading]')).toHaveText(name);
}
test('Nation changes update one document, map camera, forecast, contacts, and browser history', async ({ page }, testInfo) => {
  test.setTimeout(60000);
  const guards = await setup(page);
  await page.goto('./');
  await expect(page.locator('[data-map-mode]')).toHaveAttribute('data-map-mode', 'interactive');
  const token = await page.evaluate(() => { document.documentElement.dataset.testDocument = 'retained'; return performance.timeOrigin; });
  const regional = await page.locator('[data-map-camera]').getAttribute('data-map-camera');
  await choose(page, 'Lummi', 'Lummi Tribe of the Lummi Reservation');
  await expect(page).toHaveURL(new RegExp('n=' + LUMMI));
  await expect(page.locator('[data-map-camera]')).not.toHaveAttribute('data-map-camera', regional ?? '');
  await expect(page.locator('[data-panel="call"]')).toContainText('Lummi');
  await page.locator('[data-dashboard-tab="forecast"]').click();
  await expect(page.locator('[data-panel="forecast"]')).toBeVisible();
  await expect(page.locator('[data-panel="rivers"]')).toBeHidden();
  await page.locator('[data-dashboard-clear]').click();
  await expect(page.locator('[data-scope-heading]')).toHaveText('All of Cascadia');
  await page.goBack();
  await expect(page.locator('[data-scope-heading]')).toHaveText('Lummi Tribe of the Lummi Reservation');
  expect(await page.evaluate(() => performance.timeOrigin)).toBe(token);
  expect(await page.locator('html').getAttribute('data-test-document')).toBe('retained');
  expect(await horizontalOverflow(page)).toBe(false);
  expect(guards.pageErrors).toEqual([]); expect(guards.blockedHosts).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath('nation-history.png'), fullPage: true });
});
test('archival landscape waits for alerts, map key expands, and the phone label clears zoom controls', async ({ page }, testInfo) => {
  await setup(page); await page.goto('./?n=' + LUMMI);
  await expect(page.locator('.dashboard-landscape img')).toBeVisible();
  const times = await page.evaluate(() => ({
    alert: performance.getEntriesByName('alerts-painted')[0]?.startTime,
    image: performance.getEntriesByType('resource').find((entry) => entry.name.endsWith('/lake-chelan-nps.jpg'))?.startTime,
  }));
  if (times.alert === undefined || times.image === undefined) throw new Error('Missing alert or image timing');
  expect(times.image).toBeGreaterThanOrEqual(times.alert);
  await expect(page.locator('[data-map-mode]')).toHaveAttribute('data-map-mode', 'interactive');
  const key = page.locator('.map-legend-disclosure');
  await expect(key).not.toHaveAttribute('open', '');
  await key.locator('summary').press('Enter');
  await expect(key.locator('.map-legend')).toBeVisible();
  await key.locator('summary').press('Enter');
  await page.getByRole('button', { name: 'Fit Selected Nation', exact: true }).click();
  await expect(page.locator('.map-nation-label')).toContainText('Lummi Tribe of the Lummi Reservation');
  await expect.poll(() => page.evaluate(() => {
    const label = document.querySelector('.map-nation-label')?.getBoundingClientRect();
    const zoom = document.querySelector('.maplibregl-ctrl-zoom-in')?.parentElement?.getBoundingClientRect();
    return label && zoom && label.left < zoom.right && label.right > zoom.left && label.top < zoom.bottom && label.bottom > zoom.top;
  })).toBe(false);
  expect(await horizontalOverflow(page)).toBe(false);
  await page.screenshot({ path: testInfo.outputPath('design-selected-map.png'), fullPage: false });
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: testInfo.outputPath('design-heading.png'), fullPage: false });
  await page.locator('[data-panel="map"]').screenshot({ path: testInfo.outputPath('design-map-key.png') });
});

for (const query of ['lowdata=1', 'embed=1', 'panel=banner']) {
  test(`decorative landscape is not requested with ${query}`, async ({ page }) => {
    await setup(page);
    /** @type {string[]} */
    const requested = [];
    page.on('request', (request) => { if (request.url().includes('lake-chelan-nps.jpg')) requested.push(request.url()); });
    await page.goto('./?' + query);
    await expect(page.locator('.dashboard-banner__headline')).toBeVisible();
    await expect(page.locator('[data-panel="alert-banner"] [data-provenance]')).toBeAttached();
    await page.waitForTimeout(750);
    expect(requested).toEqual([]);
    await expect(page.locator('.dashboard-landscape')).toBeHidden();
  });
}

test('map layers change actual rendering and restore through history', async ({ page }, testInfo) => {
  await setup(page); await page.goto('./');
  await expect(page.locator('[data-map-mode]')).toHaveAttribute('data-map-mode', 'interactive');
  const layers = page.locator('.map-controls__disclosure');
  await layers.locator('summary').click();
  const gauges = layers.getByRole('checkbox', { name: /River Gauges/ });
  await gauges.uncheck(); await expect(page).toHaveURL(/layers=/);
  await expect(gauges).not.toBeChecked();
  await page.goBack(); await expect(gauges).toBeChecked();
  await gauges.uncheck();
  await gauges.check(); await expect(gauges).toBeChecked();
  await page.goBack(); await expect(gauges).not.toBeChecked();
  await page.reload();
  await expect(page.locator('[data-map-mode]')).toHaveAttribute('data-map-mode', 'interactive');
  await page.locator('.map-controls__disclosure summary').click();
  await expect(page.locator('.map-controls__disclosure').getByRole('checkbox', { name: /River Gauges/ })).not.toBeChecked();
  expect(await horizontalOverflow(page)).toBe(false);
  await page.screenshot({ path: testInfo.outputPath('map-layer-history.png'), fullPage: true });
});
test('gauge list opens the in-workspace detail and close preserves the Nation', async ({ page }, testInfo) => {
  await setup(page); await page.goto('./?n=' + LUMMI + '&view=rivers');
  const rivers = page.locator('[data-panel="rivers"]');
  await expect(rivers.locator('.gauge-card').first()).toBeVisible();
  const button = rivers.locator('[data-action="select-gauge"]').first();
  await button.click();
  await expect(page).toHaveURL(/[?&]g=/);
  await expect(page.locator('[data-dashboard-detail]')).toContainText('Latest Observation');
  await expect(page.locator('[data-dashboard-detail] .gauge-detail__chart')).toContainText(/River Hydrograph|history|History|Loading/);
  await page.getByRole('button', { name: 'Close Details', exact: true }).click();
  await expect(page.locator('[data-dashboard-detail]')).toBeHidden();
  await expect(page).toHaveURL(new RegExp('n=' + LUMMI));
  await expect(button).toBeFocused();
  expect(await horizontalOverflow(page)).toBe(false);
  await page.screenshot({ path: testInfo.outputPath('gauge-return.png'), fullPage: true });
});
test('changing Area clears the selected Nation and gauge detail', async ({ page }) => {
  await setup(page); await page.goto('./?n=' + LUMMI + '&view=rivers&g=nwps:NRKW1');
  await expect(page).toHaveURL(/[?&]g=/);
  await expect(page.locator('[data-dashboard-detail]')).toBeVisible();
  await page.locator('[data-dashboard-more-filters]').locator('..').locator('summary').click();
  await page.locator('#dashboard-filter-j').selectOption('bc');
  await expect(page).toHaveURL(/[?&]j=bc/);
  await expect(page).not.toHaveURL(/[?&](n|g)=/);
  await expect(page.locator('[data-dashboard-detail]')).toBeHidden();
});

test('filtered alerts preserve unfiltered warning status and map detail follows selection', async ({ page }, testInfo) => {
  await setup(page); await page.goto('./');
  await expect(page.locator('.dashboard-banner__headline')).toContainText('advisories in effect');
  const headline = await page.locator('.dashboard-banner__headline').textContent();
  await page.locator('#dashboard-filter-hz').selectOption('wind');
  await expect(page).toHaveURL(/hz=wind/);
  await expect(page.locator('.dashboard-banner__headline')).toHaveText(headline ?? '');
  const action = page.locator('[data-panel="nation-alerts"]').getByRole('button', { name: 'Show on Map' }).first();
  await expect(action).toBeVisible();
  await action.click();
    await expect(page.locator('[data-dashboard-detail]')).toBeVisible();
    await expect(page).toHaveURL(/[?&]a=/);
    await page.getByRole('button', { name: 'Close Details', exact: true }).click();
    await expect(page.locator('#dashboard-filter-hz')).toHaveValue('wind');
  expect(await axeProblems(page)).toEqual([]);
  expect(await horizontalOverflow(page)).toBe(false);
  await page.screenshot({ path: testInfo.outputPath('alerts-filter.png'), fullPage: true });
});
