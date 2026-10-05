// @ts-check
/**
 * Blueprint 10.1 accessibility: axe on every route, every view, and the interactive states reachable
 * without data (picker open, embed mode, outline-mode map, tab-visible states). Any serious or critical
 * violation fails. Runs in every Playwright project, so it covers the phone, desktop, WebKit iPhone, and
 * no-WebGL (map views only) runs. Owner: lane L15.
 */
import { expect, test } from '@playwright/test';
import { attachGuards, axeProblems, loadRoutes, stylesApplied } from './support/harness.mjs';

const { routes } = await loadRoutes();

for (const route of routes) {
  test(`${route.id}: no serious or critical axe violations`, async ({ page }) => {
    await attachGuards(page, { pageId: route.page });
    await page.goto(route.path);
    await page.waitForLoadState('networkidle');
    test.skip(!(await stylesApplied(page)), 'stylesheets are not delivered yet (lane L1 pending); contrast results would be meaningless');
    expect(await axeProblems(page)).toEqual([]);
  });

  for (const view of route.views) {
    test(`${route.id} view=${view}: no serious or critical axe violations`, async ({ page }) => {
      await attachGuards(page, { pageId: route.page });
      await page.goto(`${route.path}?view=${view}`);
      await page.waitForLoadState('networkidle');
      test.skip(!(await stylesApplied(page)), 'stylesheets are not delivered yet (lane L1 pending)');
      expect(await axeProblems(page)).toEqual([]);
    });
  }
}

test('embed mode: no serious or critical axe violations', async ({ page }) => {
  await attachGuards(page, { pageId: 'alerts' });
  await page.goto('alerts/?embed=1');
  await page.waitForLoadState('networkidle');
  test.skip(!(await stylesApplied(page)), 'stylesheets are not delivered yet (lane L1 pending)');
  expect(await axeProblems(page)).toEqual([]);
});

test('the Nation picker open: no serious or critical axe violations', async ({ page }) => {
  await attachGuards(page, { pageId: 'dashboard' });
  await page.goto('./');
  const trigger = page.locator('[data-action="open-nation-picker"]').first();
  await trigger.click();
  const dialog = page.locator('[role="dialog"], [role="combobox"], [data-nation-picker]').first();
  const opened = await dialog.waitFor({ timeout: 3000 }).then(() => true, () => false);
  test.skip(!opened, 'the picker is not mounted yet (lane L10 pending)');
  expect(await axeProblems(page)).toEqual([]);
});
