// @ts-check
/**
 * L0 acceptance: every route served by the dev server renders its static chrome with JavaScript off
 * (blueprint 1.3, 12.3). Owner: lane L0.
 */
import { expect, test } from '@playwright/test';

const ROUTES = [
  { path: './', page: 'dashboard', current: 'Dashboard' },
  { path: 'alerts/', page: 'alerts', current: 'Alerts' },
  { path: 'forecasts/', page: 'forecasts', current: 'Forecasts' },
  { path: 'contacts/', page: 'contacts', current: 'Contacts' },
  { path: 'resources/', page: 'resources', current: 'Resources' },
  { path: 'safety/', page: 'safety', current: 'Safety' },
  { path: 'news/', page: 'news', current: 'News' },
  { path: 'usage/', page: 'usage', current: 'Usage' },
  { path: 'archive/', page: 'archive', current: null },
  { path: 'archive/2025-12-atmospheric-river/', page: 'archive-event', current: null },
  { path: 'embed/', page: 'embed', current: null },
  { path: 'offline.html', page: 'offline', current: null },
  { path: 'no-such-page/deeper/', page: 'not-found', current: null, status: 404 },
];
const NAV = ['Dashboard', 'Alerts', 'Forecasts', 'Contacts', 'Resources', 'Safety', 'News', 'Usage'];

test.describe('with JavaScript on', () => {
  test('every page module graph loads from the same origin without script errors', async ({ page }) => {
    /** @type {string[]} */
    const errors = [];
    /** @type {string[]} */
    const badModules = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('requestfailed', (r) => { if (r.url().includes('/static/js/')) badModules.push(`${r.url()} ${r.failure()?.errorText ?? ''}`); });
    page.on('response', (r) => { if (r.url().includes('/static/js/') && r.status() !== 200) badModules.push(`${r.url()} ${r.status()}`); });
    for (const route of ROUTES.filter((r) => !r.status)) {
      await page.goto(route.path);
      await page.waitForLoadState('load');
      await expect(page.locator('html')).not.toHaveAttribute('data-embed', '1');
    }
    expect(errors).toEqual([]);
    expect(badModules).toEqual([]);
  });

  // panel= is honored on the Dashboard only (blueprint 1.4); core/embed.js clears it on every other page.
  test('boot flags apply before paint: embed=1 marks the document', async ({ page }) => {
    await page.goto('./?embed=1&lowdata=1&panel=banner');
    await expect(page.locator('html')).toHaveAttribute('data-embed', '1');
    await expect(page.locator('html')).toHaveAttribute('data-lowdata', '1');
    await expect(page.locator('html')).toHaveAttribute('data-panel-only', 'banner');
  });
});

test.describe('static chrome with JavaScript off', () => {
  test.use({ javaScriptEnabled: false });

  for (const route of ROUTES) {
    test(`${route.page} renders chrome`, async ({ page }) => {
      const res = await page.goto(route.path);
      expect(res?.status()).toBe(route.status ?? 200);
      await expect(page.locator('body')).toHaveAttribute('data-page', route.page);
      await expect(page.locator('header.site-header')).toBeVisible();
      await expect(page.locator('header.site-header')).toContainText('Cascadia Tribal Hazard Dashboard');
      const nav = page.getByRole('navigation', { name: 'Primary' });
      await expect(nav).toBeVisible();
      await expect(nav.getByRole('link')).toHaveText(NAV);
      if (route.current) await expect(nav.getByRole('link', { name: route.current })).toHaveAttribute('aria-current', 'page');
      else await expect(nav.locator('[aria-current="page"]')).toHaveCount(0);
      await expect(page.locator('footer.site-footer')).toBeVisible();
      await expect(page.locator('footer.site-footer')).toContainText('Representation, not jurisdiction.');
      await expect(page.locator('footer.site-footer')).toContainText('In an emergency, call 911.');
      // The Quick Actions bar is phone-only (hidden at 720 px and wider), so it is read with hidden elements included.
      const quick = page.getByRole('navigation', { name: 'Quick Actions', includeHidden: true });
      await expect(quick.getByRole('link', { includeHidden: true })).toHaveText(['Alerts', 'Rivers', 'Call', 'Near Me']);
      if ((page.viewportSize()?.width ?? 0) < 720) await expect(quick).toBeVisible();
      await expect(page.locator('main#main h1')).toHaveCount(1);
      // Every navigation link resolves to a page the server has.
      for (const href of await nav.getByRole('link').evaluateAll((els) => els.map((a) => String(a.getAttribute('href') ? new URL(a.getAttribute('href') ?? '', a.baseURI).href : '')))) {
        const r = await page.request.get(href);
        expect(r.status(), href).toBe(200);
      }
    });
  }

  test('panels name registered-looking source ids and carry no digits in skeletons', async ({ page }) => {
    for (const route of ROUTES.filter((r) => !r.status)) {
      await page.goto(route.path);
      const panels = page.locator('[data-panel]');
      for (const p of await panels.all()) {
        await expect(p).toHaveAttribute('data-sources', /^[a-z0-9]+(?:-[a-z0-9]+)*(?: [a-z0-9]+(?:-[a-z0-9]+)*)*$/);
        expect(await p.locator('[data-panel-body]').innerText()).not.toMatch(/\d/);
      }
    }
  });

  // Playwright's script-disabled emulation parses <noscript> as text, so the notice is checked in the
  // served markup rather than in the rendering.
  test('pages with live data carry the noscript notice', async ({ page }) => {
    for (const path of ['./', 'alerts/', 'forecasts/', 'contacts/', 'resources/', 'news/']) {
      await page.goto(path);
      const notice = await page.locator('main noscript').first().innerHTML();
      expect(notice).toContain('call 911');
      expect(notice).toContain('https://www.weather.gov/');
      expect(notice).toContain('https://weather.gc.ca/');
    }
  });
});
