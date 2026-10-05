// @ts-check
/**
 * Blueprint 10.2, every page at 360 x 740 and 1280 x 800 (the phone and desktop projects): no console
 * errors, no securitypolicyviolation, no horizontal scroll, links that leave the page open in a new tab,
 * robots noindex until Gate V, and the 404 status. Any request to a host outside routes.json and the
 * registry fails. Owner: lane L15.
 */
import { expect, test } from '@playwright/test';
import { attachGuards, horizontalOverflow, loadRoutes, stylesApplied } from './support/harness.mjs';

const { routes, viewports } = await loadRoutes();

for (const route of routes) {
  test.describe(`${route.id}`, () => {
    test('loads without console errors, policy violations, unlisted hosts, or sideways scroll', async ({ page }) => {
      const g = await attachGuards(page, { pageId: route.page });
      // Chromium logs a route's own expected non-200 document status (the 404 page) as a console error;
      // only that one message, located at the document URL, is excused. Subresource failures still fail.
      /** @type {string[]} */
      const documentStatus = [];
      if (route.status) {
        page.on('console', (m) => {
          if (m.type() === 'error' && /^Failed to load resource/.test(m.text()) && m.location().url.endsWith(route.path)) documentStatus.push(m.text());
        });
      }
      // Chromium also logs every failed subresource. Two kinds are failures by design here and are excused, one
      // message each: upstream requests that the guard aborts (no upstream is called in this test), and
      // data/live/ files, which only the snapshot deploy writes (absence is shown as status on the page).
      // A missing same-origin asset (script, style, font, image, committed data) still fails.
      page.on('console', (m) => {
        if (m.type() !== 'error' || !/^Failed to load resource/.test(m.text())) return;
        const at = m.location().url;
        if (!at) return;
        let upstream = false;
        try { upstream = new URL(at).origin !== new URL(String(test.info().project.use.baseURL)).origin; } catch { /* unparsable location */ }
        if (upstream || /\/data\/live\//.test(at)) documentStatus.push(m.text());
      });
      const res = await page.goto(route.path);
      expect(res?.status()).toBe(route.status ?? 200);
      await page.waitForLoadState('networkidle');
      const consoleErrors = [...g.consoleErrors];
      for (const t of documentStatus) {
        const i = consoleErrors.indexOf(t);
        if (i >= 0) consoleErrors.splice(i, 1);
      }
      expect(g.pageErrors, 'uncaught page errors').toEqual([]);
      expect(consoleErrors, 'console errors').toEqual([]);
      expect(await g.cspViolations(), 'securitypolicyviolation events').toEqual([]);
      expect(g.blockedHosts, 'requests to hosts outside routes.json and the registry').toEqual([]);
      if (await stylesApplied(page)) expect(await horizontalOverflow(page), 'horizontal scroll').toBe(false);
    });

    test('keeps noindex until Gate V, and every outward link opens in a new tab', async ({ page }) => {
      await attachGuards(page, { pageId: route.page });
      await page.goto(route.path);
      await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', /noindex/);
      const bad = await page.evaluate(() => [...document.querySelectorAll('a[href]')].filter((a) => {
        const u = new URL(/** @type {HTMLAnchorElement} */ (a).href);
        return u.origin !== location.origin && /^https?:$/.test(u.protocol);
      }).filter((a) => a.getAttribute('target') !== '_blank' || !/noopener/.test(a.getAttribute('rel') ?? '')).map((a) => /** @type {HTMLAnchorElement} */ (a).href));
      expect(bad, 'outward links without target=_blank and rel=noopener').toEqual([]);
    });
  });
}

test('320 px wide: no horizontal scroll on the dashboard and contacts', async ({ page }) => {
  const narrow = /** @type {{ width: number, height: number }} */ (viewports.narrow);
  await page.setViewportSize(narrow);
  for (const p of ['./', 'contacts/']) {
    await attachGuards(page, { pageId: p === './' ? 'dashboard' : 'contacts' });
    await page.goto(p);
    test.skip(!(await stylesApplied(page)), 'stylesheets are not delivered yet (lane L1 pending)');
    expect(await horizontalOverflow(page), `${p} at 320 px`).toBe(false);
  }
});
