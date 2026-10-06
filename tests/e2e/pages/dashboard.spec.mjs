// @ts-check
/** Dashboard behavior against the reviewed registry and dated upstream captures. */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { attachGuards, horizontalOverflow } from '../support/harness.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const CAPTURE_TIME = '2026-10-05T08:30:00Z';
const out = mkdtempSync(path.join(tmpdir(), 'cthd-dashboard-'));
execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'snapshot', 'run.mjs'), '--out', out,
  '--fixtures', path.join(ROOT, 'tests', 'fixtures', 'upstream'), '--tasks', 'alerts,tsunami',
  '--force', '--now', CAPTURE_TIME], { cwd: ROOT, stdio: 'ignore' });

const LUMMI_ID = 'us-wa-lummi-tribe-of-the-lummi-reservation';
const LUMMI_NAME = 'Lummi Tribe of the Lummi Reservation';

/** @param {import('@playwright/test').Page} page @param {{ snapshot?: boolean, now?: string }} [opts] */
async function setup(page, opts = {}) {
  const guards = await attachGuards(page, { pageId: 'dashboard', down: true });
  // Playwright's clock replaces performance.mark with a stub. Keep the real clock for map gating.
  if (opts.snapshot || opts.now) await page.clock.setFixedTime(new Date(opts.now ?? CAPTURE_TIME));
  await page.route('**/data/live/**', (route) => {
    const name = new URL(route.request().url()).pathname.split('/').pop() ?? '';
    if (opts.snapshot) {
      try { return route.fulfill({ status: 200, contentType: 'application/json', body: readFileSync(path.join(out, name)) }); }
      catch { /* A file absent from the real snapshot remains unavailable. */ }
    }
    return route.fulfill({ status: 404, body: '' });
  });
  return guards;
}

test('default view renders each panel and missing alerts remain unknown', async ({ page }) => {
  const guards = await setup(page);
  await page.goto('./');
  await expect(page.locator('h1[data-scope-heading]')).toHaveText('All of Cascadia');
  await expect(page.locator('[data-dashboard-picker]')).toBeVisible();
  const banner = page.locator('[data-panel="alert-banner"] [data-panel-body]');
  await expect(banner).toHaveAttribute('data-banner', 'unknown');
  await expect(banner).toContainText('not an all-clear');
  await expect(banner).not.toContainText('No active');
  for (const id of ['alert-banner', 'nation-alerts', 'jurisdictions', 'nation', 'call', 'rivers', 'rain', 'forecast', 'map', 'declarations', 'official-news']) {
    await expect(page.locator(`[data-panel="${id}"] [data-provenance]`)).toBeAttached();
  }
  expect(await horizontalOverflow(page)).toBe(false);
  expect(guards.pageErrors).toEqual([]);
  expect(guards.blockedHosts).toEqual([]);
});

test('Nation search selects the canonical URL and scoped links stay under the Pages subpath', async ({ page }) => {
  await setup(page);
  await page.goto('./?j=bc&utm_source=dashboard-test');
  await page.locator('[data-dashboard-picker]').click();
  const picker = page.getByRole('dialog', { name: 'Choose a Nation' });
  const input = picker.getByRole('combobox', { name: 'Tribal Nation or First Nation' });
  await input.fill('Lummi');
  await expect(picker.getByRole('option', { name: new RegExp(LUMMI_NAME) })).toBeVisible();
  await input.press('ArrowDown');
  await input.press('Enter');
  await expect(page).toHaveURL(new RegExp(`n=${LUMMI_ID}`));
  await expect(page).not.toHaveURL(/[?&]j=/);
  await expect(page).toHaveURL(/utm_source=dashboard-test/);
  await expect(page.locator('h1[data-scope-heading]')).toHaveText(LUMMI_NAME);
  await expect(page.locator('[data-nation-chip-name]')).toHaveText(LUMMI_NAME);
  await expect(page.locator('[data-panel="jurisdictions"]')).toBeHidden();
  const contacts = page.locator('[data-panel="nation"]').getByRole('link', { name: 'Nation Contacts' });
  await expect(contacts).toBeVisible();
  const target = new URL(await contacts.getAttribute('href') ?? '', page.url());
  expect(target.pathname).toBe('/pnw-tribal-dashboard/contacts/');
  expect(target.searchParams.get('n')).toBe(LUMMI_ID);
  const alerts = page.locator('[data-panel="alert-banner"]').getByRole('link', { name: 'All Alerts', exact: true });
  const alertTarget = new URL(await alerts.getAttribute('href') ?? '', page.url());
  expect(alertTarget.pathname).toBe('/pnw-tribal-dashboard/alerts/');
  expect(alertTarget.searchParams.get('n')).toBe(LUMMI_ID);
  await page.locator('[data-dashboard-picker]').click();
  await page.getByRole('dialog').getByRole('button', { name: 'All of Cascadia', exact: true }).click();
  await expect(page).not.toHaveURL(/[?&]n=/);
  await expect(page.locator('h1[data-scope-heading]')).toHaveText('All of Cascadia');
});

test('British Columbia scope requires the Canadian source when alert data is missing', async ({ page }) => {
  await setup(page);
  await page.goto('./?j=bc');
  await expect(page.locator('h1[data-scope-heading]')).toHaveText('British Columbia');
  const banner = page.locator('[data-panel="alert-banner"] [data-panel-body]');
  await expect(banner).toHaveAttribute('data-banner', 'unknown');
  await expect(banner).toContainText('Environment and Climate Change Canada');
  await expect(banner).not.toContainText('National Weather Service');
});

test('an old scheduled copy never becomes an all-clear when the live sources fail', async ({ page }) => {
  await setup(page, { snapshot: true, now: '2026-10-05T09:00:00Z' });
  await page.goto('./');
  const panel = page.locator('[data-panel="alert-banner"]');
  await expect(panel.locator('[data-provenance]')).toHaveAttribute('data-status', /stale|degraded/);
  await expect(panel.locator('[data-panel-body]')).not.toHaveAttribute('data-banner', 'none');
  await expect(panel.locator('[data-panel-body]')).not.toContainText('No active');
  await expect(panel.locator('time[datetime]').first()).toBeVisible();
});

test('map modules load only after Show Map and the fallback keeps its sovereignty note', async ({ page }) => {
  const guards = await setup(page);
  await page.addInitScript(() => {
    const original = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (type, ...rest) {
      return /webgl/i.test(String(type)) ? null : /** @type {any} */ (original).call(this, type, ...rest);
    };
  });
  await page.goto('./');
  const map = page.locator('[data-panel="map"]');
  await expect(map.getByRole('button', { name: 'Show Map', exact: true })).toBeVisible();
  expect(guards.requests.filter((request) => /\/static\/(?:js\/map\/|vendor\/)/.test(request.url))).toEqual([]);
  await map.getByRole('button', { name: 'Show Map', exact: true }).click();
  await expect(map.locator('svg.map-outline')).toBeVisible();
  await expect(map.locator('.sovereignty-note')).toContainText('Representation, not jurisdiction');
  expect(guards.requests.some((request) => /\/map\/adapter\.js$/.test(request.url))).toBe(true);
  expect(guards.pageErrors).toEqual([]);
});

test('an unavailable Nation returns to Cascadia with an explicit explanation', async ({ page }) => {
  await setup(page);
  await page.goto('./?n=us-wa-no-such-nation');
  await expect(page.locator('[data-scope-notice]')).toContainText('The requested Nation could not be loaded');
  await expect(page).not.toHaveURL(/[?&]n=/);
  await expect(page.locator('h1[data-scope-heading]')).toHaveText('All of Cascadia');
  await expect(page.locator('[data-panel="alert-banner"] [data-panel-body]')).toHaveAttribute('data-banner', 'unknown');
});
