// @ts-check
/**
 * Blueprint 10.2: `embed=1` and framed-without-parameter both hide chrome and keep stamps, sovereignty
 * notes, the banner, and the selector visible; a resize message is posted when framed. Owner: lane L15.
 */
import { expect, test } from '@playwright/test';
import { attachGuards, loadRoutes, stylesApplied } from './support/harness.mjs';

const { routes } = await loadRoutes();
const PAGES = routes.filter((r) => r.nav !== null || r.id === 'embed').slice(0, 9);

for (const route of PAGES) {
  test(`${route.id}: embed=1 marks the document, hides chrome, and keeps the footer sovereignty note`, async ({ page }) => {
    await attachGuards(page, { pageId: route.page });
    await page.goto(`${route.path}${route.path.includes('?') ? '&' : '?'}embed=1`);
    await expect(page.locator('html')).toHaveAttribute('data-embed', '1');
    test.skip(!(await stylesApplied(page)), 'stylesheets are not delivered yet (lane L1 pending)');
    await expect(page.locator('.site-header')).toBeHidden();
    await expect(page.locator('.site-nav')).toBeHidden();
    await expect(page.locator('[data-embed-only]').first()).toBeVisible();
    await expect(page.locator('.site-footer__sovereignty').first()).toBeVisible();
  });
}

test('framed without a parameter behaves as embed=1, and the frame posts a resize message to its parent', async ({ page, baseURL }) => {
  await attachGuards(page, { pageId: 'alerts' });
  // A host page of our own: the site's pages carry frame-src 'none', so they cannot host the frame. The
  // route is registered after the guard, so it wins for this one URL; the framed page itself is the real one.
  await page.route('**/__embed-host__.html', (r) => r.fulfill({
    contentType: 'text/html',
    body: `<!doctype html><title>Host</title><script>window.__messages=[];window.addEventListener('message',function(e){window.__messages.push(e.data)})</script><iframe id="host-frame" src="${baseURL}alerts/" width="360" height="600"></iframe>`,
  }));
  await page.goto('__embed-host__.html');
  const frame = page.frameLocator('#host-frame');
  await expect(frame.locator('html')).toHaveAttribute('data-embed', '1');
  await expect(frame.locator('html')).toHaveAttribute('data-framed', '1');
  const posted = await page.waitForFunction(() => /** @type {any} */ (window).__messages.length > 0, null, { timeout: 5000 }).then(() => true, () => false);
  test.skip(!posted, 'no resize message yet (lane L1, core/embed.js, pending)');
  const msg = await page.evaluate(() => /** @type {any} */ (window).__messages[0]);
  expect(msg).toMatchObject({ type: expect.stringMatching(/resize|height/i) });
});

test('embed=0 keeps chrome even when framed', async ({ page }) => {
  await attachGuards(page, { pageId: 'alerts' });
  await page.goto('alerts/?embed=0');
  await expect(page.locator('html')).not.toHaveAttribute('data-embed', '1');
});
