// @ts-check
/**
 * Blueprint 10.2 scenarios 1 to 3. With every external host aborted and no snapshot, every panel is
 * unavailable with an official link, the banner never reads as an all-clear, and no panel body contains a
 * digit outside <time> or any numeric observation pattern. Scenarios 2 and 3 (stale snapshot with a 503,
 * truncated collection with a malformed item) need the alert engine and its dated fixtures
 * (tests/fixtures/upstream/nws-alerts-active) and skip until lanes L10 and L11 mount the banner on their pages.
 * Owner: lane L15.
 */
import { expect, test } from '@playwright/test';
import { OBSERVATION_PATTERN, PAGE_LANES, attachGuards, loadRoutes, mountedOrSkip } from './support/harness.mjs';

const { routes } = await loadRoutes();
const DATA_PAGES = routes.filter((r) => ['dashboard', 'alerts', 'forecasts', 'contacts', 'resources', 'safety', 'news'].includes(r.id));

test.describe('scenario 1: all upstreams down, no snapshot', () => {
  for (const route of DATA_PAGES) {
    test(`${route.id}: panels are unavailable, with no invented numbers`, async ({ page }) => {
      const g = await attachGuards(page, { pageId: route.page, down: true });
      await page.route('**/data/live/**', (r) => r.fulfill({ status: 404, body: '' }));
      await page.goto(route.path);
      await mountedOrSkip(page, test, '[data-panel] [data-provenance]', PAGE_LANES[route.page] ?? 'page lane');
      await page.waitForLoadState('networkidle');
      const panels = await page.evaluate(() => [...document.querySelectorAll('[data-panel]')].map((p) => ({
        name: p.getAttribute('data-panel') ?? '',
        status: p.querySelector('[data-provenance]')?.getAttribute('data-status') ?? '',
        link: Boolean(p.querySelector('[data-provenance] a[href^="https://"], .panel__official a[href^="https://"]')),
        body: (() => {
          const b = /** @type {HTMLElement | null} */ (p.querySelector('[data-panel-body]'))?.cloneNode(true);
          if (!(b instanceof HTMLElement)) return '';
          b.querySelectorAll('time').forEach((t) => t.remove());
          return b.textContent ?? '';
        })(),
      })));
      for (const p of panels) {
        // Static informational panels (Resources, Safety text, Contacts directory, the News source directory and
        // community links, all from committed files) are not data panels in this sense.
        if (!/^(resources|safety|contacts|news-directory|news-community)/.test(p.name)) {
          expect(['unavailable', 'loading', ''], `${p.name} is "${p.status}" with every upstream down`).toContain(p.status);
        }
        if (p.status === 'unavailable') {
          expect(p.link, `${p.name} names an official link`).toBe(true);
          expect(/\d/.test(p.body), `${p.name} body contains a digit outside <time>: "${p.body.slice(0, 80)}"`).toBe(false);
          expect(OBSERVATION_PATTERN.test(p.body), `${p.name} shows a numeric observation`).toBe(false);
        }
      }
      expect(g.blockedHosts).toEqual([]);
    });
  }

  test('the banner says the status is unknown and never claims an all-clear', async ({ page }) => {
    await attachGuards(page, { pageId: 'dashboard', down: true });
    await page.route('**/data/live/**', (r) => r.fulfill({ status: 404, body: '' }));
    await page.goto('./');
    await mountedOrSkip(page, test, '[data-alert-banner]', 'L10, Wave 3 dashboard');
    const banner = page.locator('[data-alert-banner]').first();
    await expect(banner).toContainText(/Alert status unknown/i);
    await expect(banner).toContainText(/not an all-clear/i);
    await expect(banner).not.toContainText(/no active alerts|all clear(?! is not)/i);
  });
});

test.describe('scenarios 2 and 3: degraded alert feeds', () => {
  test('NWS 503 with a 25-minute-old snapshot shows alerts as stale from a scheduled copy; the zero message never appears', async ({ page }) => {
    await attachGuards(page, { pageId: 'alerts' });
    await page.goto('alerts/');
    await mountedOrSkip(page, test, '[data-alert-banner]', 'L11, Wave 2 alerts page');
    test.skip(true, 'scenario body pending (lane L15, after lane L11 mounts the alerts banner on the Wave 1 L3 engine and L9 snapshot)');
  });
  test('a truncated NWS collection with one malformed item renders the valid alerts as degraded with the partial notice', async ({ page }) => {
    await attachGuards(page, { pageId: 'alerts' });
    await page.goto('alerts/');
    await mountedOrSkip(page, test, '[data-alert-banner]', 'L11, Wave 2 alerts page');
    test.skip(true, 'scenario body pending (lane L15, after lane L11 mounts the alerts banner; fixture 2026-10-05-topup-one-malformed-item.json exists)');
  });
});
