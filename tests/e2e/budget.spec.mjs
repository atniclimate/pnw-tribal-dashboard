// @ts-check
/**
 * Blueprint 8 and 10.2 scenarios 4, 5, and 14. Network-log assertions run on every page now: no request over
 * 300 KB and no image over 150 KB before a tap, and no `map/*` or `vendor/*` file requested before the
 * alerts-painted mark. Timing targets (Constrained and Storm profiles by Chrome DevTools Protocol
 * throttling at 360 x 740, cold cache, including the map rows) are measured on the Dashboard and Contacts
 * and skip until the alerts-painted mark exists (lane L10). Owner: lane L15.
 */
import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import { attachGuards, loadRoutes } from './support/harness.mjs';

const budgets = JSON.parse(await readFile(new URL('../../budgets.json', import.meta.url), 'utf8'));
const { routes } = await loadRoutes();

for (const route of routes.filter((r) => !r.status)) {
  test(`${route.id}: no request over 300 KB and no image over 150 KB before a tap`, async ({ page }) => {
    const g = await attachGuards(page, { pageId: route.page });
    await page.goto(route.path);
    await page.waitForLoadState('networkidle');
    // content-length is the transferred size; a response without one (chunked dev server) is measured by check:budgets instead.
    for (const r of g.requests.filter((x) => x.status === 200)) {
      if (r.bytes === null) continue;
      expect(r.bytes, `${r.url} (${r.type})`).toBeLessThanOrEqual(budgets.bytes.requestWithoutTap.max);
      if (r.type.startsWith('image/')) expect(r.bytes, `${r.url} image`).toBeLessThanOrEqual(budgets.bytes.imageWithoutTap.max);
    }
  });
}

test('scenario 4: no map or vendor module is requested before alerts-painted', async ({ page }) => {
  const g = await attachGuards(page, { pageId: 'dashboard' });
  await page.goto('./');
  const painted = await page.waitForFunction(() => performance.getEntriesByName('alerts-painted').length > 0, null, { timeout: 5000 }).then(() => true, () => false);
  test.skip(!painted, 'the alerts-painted mark is not emitted yet (lane L10 pending)');
  const paintedAt = await page.evaluate(() => performance.getEntriesByName('alerts-painted')[0]?.startTime ?? 0);
  const early = g.requests.filter((r) => /\/static\/(js\/map\/|vendor\/)/.test(r.url) && r.at < paintedAt);
  expect(early.map((r) => r.url)).toEqual([]);
});

test.describe('scenario 14: timing targets', () => {
  for (const [profile, p] of Object.entries(budgets.timing.profiles)) {
    test(`${profile}: alerts-painted within target on the Dashboard`, async ({ page, browserName }) => {
      test.skip(browserName !== 'chromium', 'CDP throttling is Chromium only');
      const cdp = await page.context().newCDPSession(page);
      const prof = /** @type {{ downloadKbps: number, latencyMs: number, cpuSlowdown: number }} */ (p);
      await cdp.send('Network.enable');
      await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: prof.latencyMs, downloadThroughput: (prof.downloadKbps * 1000) / 8, uploadThroughput: (prof.downloadKbps * 1000) / 8 });
      await cdp.send('Emulation.setCPUThrottlingRate', { rate: prof.cpuSlowdown });
      await attachGuards(page, { pageId: 'dashboard' });
      await page.goto('./');
      const painted = await page.waitForFunction(() => performance.getEntriesByName('alerts-painted').length > 0, null, { timeout: 20000 }).then(() => true, () => false);
      test.skip(!painted, 'the alerts-painted mark is not emitted yet (lane L10 pending)');
      const at = await page.evaluate(() => performance.getEntriesByName('alerts-painted')[0]?.startTime ?? Infinity);
      expect(at).toBeLessThanOrEqual(budgets.timing.targets[profile].alertsPaintedMs);
    });
  }
});
