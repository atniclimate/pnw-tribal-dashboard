// @ts-check
/**
 * Blueprint 10.2 scenario 9: after one visit, the Dashboard (marked cached), Contacts, and Safety load
 * offline; an unvisited page gets offline.html. The service worker is lane L9's (Wave 3); until site/sw.js
 * exists every test here skips with that reason. Owner: lane L15.
 */
import { expect, test } from '@playwright/test';
import { attachGuards } from './support/harness.mjs';

test.use({ serviceWorkers: 'allow' });

/** @param {import('@playwright/test').Page} page */
async function swAvailable(page) {
  const res = await page.request.get('sw.js').catch(() => null);
  return Boolean(res && res.status() === 200);
}

test('offline after one visit: Dashboard, Contacts, and Safety load; an unvisited page shows the offline page', async ({ page, context }) => {
  test.skip(!(await swAvailable(page)), 'site/sw.js is not delivered yet (lane L9, Wave 3)');
  await attachGuards(page, { pageId: 'dashboard' });
  for (const p of ['./', 'contacts/', 'safety/']) await page.goto(p);
  await page.evaluate(() => navigator.serviceWorker.ready);
  await context.setOffline(true);
  for (const [p, heading] of /** @type {[string, RegExp][]} */ ([['./', /Dashboard|Cascadia/i], ['contacts/', /Contacts/i], ['safety/', /Safety/i]])) {
    await page.goto(p);
    await expect(page.locator('h1').first()).toHaveText(heading);
  }
  await expect(page.locator('[data-status="cached"]').first()).toBeVisible();
  await page.goto('news/');
  await expect(page.locator('body')).toHaveAttribute('data-page', 'offline');
});
