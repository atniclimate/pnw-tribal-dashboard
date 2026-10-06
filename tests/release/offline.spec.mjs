// @ts-check
import { expect, test } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { mkdir } from 'node:fs/promises';
import { startServer } from '../../scripts/dev/serve.mjs';

/** @type {import('node:http').Server | undefined} */
let server;
async function stopServer() {
  const active = server;
  server = undefined;
  active?.closeAllConnections();
  await new Promise((resolve) => active ? active.close(resolve) : resolve(undefined));
}
test.beforeAll(async () => {
  server = /** @type {import('node:http').Server} */ (await startServer({ root: fileURLToPath(new URL('../../_site/', import.meta.url)), port: 8089 }));
});
test.afterAll(stopServer);

test('the assembled worker preserves saved pages, shows offline status, and falls back for unvisited pages', async ({ page, context }, testInfo) => {
  await context.addInitScript(() => {
    /** @type {string[]} */
    const errors = [];
    Reflect.set(globalThis, '__releaseRuntimeErrors', errors);
    globalThis.addEventListener('error', (event) => errors.push(event.message));
    globalThis.addEventListener('unhandledrejection', (event) => errors.push(String(event.reason)));
  });
  await context.route((url) => url.hostname !== 'localhost' && url.hostname !== '127.0.0.1', (route) => route.abort('failed'));
  const errors = /** @type {{ name: string, message: string }[]} */ ([]);
  page.on('pageerror', (error) => errors.push({ name: error.name, message: error.message }));
  await page.goto('./');
  await expect(page.locator('h1').first()).toContainText(/Cascadia|Dashboard/);
  // Browsers treat loopback as secure. Only this artifact test registers on HTTP;
  // production page code continues to require HTTPS and a top-level context.
  await page.evaluate(async () => {
    if (globalThis.location.hostname !== 'localhost') throw new Error('Manual test registration is loopback-only');
    await globalThis.navigator.serviceWorker.register('./sw.js');
    await globalThis.navigator.serviceWorker.ready;
  });
  await page.waitForFunction(() => Boolean(globalThis.navigator.serviceWorker.controller));
  // A controlled navigation exercises the versioned runtime before going offline.
  await page.reload();
  await expect(page.locator('[data-panel="alert-banner"]')).toContainText(/Alert|Scheduled|Unavailable|unknown|effect/i);
  await expect(page.locator('[data-panel="official-news"] [data-panel-body]')).not.toHaveText('');
  await expect(page.locator('[data-panel="official-news"]')).not.toContainText('Loading');
  await expect(page.locator('[data-panel="declarations"]')).not.toContainText('Loading', { timeout: 15_000 });
  await expect(page.locator('dialog.nation-picker')).not.toBeVisible();
  const reports = fileURLToPath(new URL('../../reports/', import.meta.url));
  await mkdir(reports, { recursive: true });
  await page.screenshot({ path: `${reports}release-${testInfo.project.name}.png`, fullPage: true });
  await page.screenshot({ path: `${reports}release-${testInfo.project.name}-viewport.png` });
  expect(await page.evaluate(() => globalThis.document.documentElement.scrollWidth)).toBeLessThanOrEqual(await page.evaluate(() => globalThis.innerWidth));
  const savedPages = await page.evaluate(async () => {
    const names = await globalThis.caches.keys();
    const shell = await globalThis.caches.open(names.find((name) => name.startsWith('cthd-shell-')) ?? 'absent');
    return (await shell.keys()).map((request) => new URL(request.url).pathname);
  });
  expect(savedPages).toContain('/pnw-tribal-dashboard/contacts/');
  expect(savedPages).toContain('/pnw-tribal-dashboard/safety/');
  const expectedSnapshot = await page.evaluate(async () => {
    const response = await globalThis.fetch('/pnw-tribal-dashboard/data/live/alerts.json');
    return response.ok ? await response.text() : null;
  });
  await context.setOffline(true);
  await expect(page.locator('[data-offline-banner]')).toContainText('Offline.');
  const disconnectedServer = testInfo.project.name === 'webkit-release';
  if (disconnectedServer) {
    // This runner returns an internal navigation error with WebKit offline
    // emulation. Exercise the real worker against a disconnected origin instead;
    // the offline event/UI contract was checked separately above.
    await context.setOffline(false);
    await stopServer();
  }
  for (const [path, heading] of /** @type {[string, RegExp][]} */ ([['./', /Cascadia|Dashboard/], ['contacts/', /Contacts/], ['safety/', /Safety/]])) {
    await page.goto(path);
    await expect(page.locator('h1').first()).toContainText(heading);
    if (!disconnectedServer) await expect(page.locator('[data-offline-banner]')).toContainText('Offline.');
    if (path === 'contacts/') await expect(page.locator('[data-panel="contacts-directory"] a[href^="tel:"]').first()).toBeVisible();
    if (path === './' || path === 'safety/') {
      const snapshot = await page.evaluate(async () => {
        const response = await globalThis.fetch('/pnw-tribal-dashboard/data/live/alerts.json');
        return { status: response.status, cached: response.headers.get('X-CTHD-Cache'), body: await response.text() };
      });
      if (expectedSnapshot !== null) {
        expect(snapshot.status).toBe(200);
        expect(snapshot.cached).toBe('cached');
        expect(snapshot.body).toBe(expectedSnapshot);
      } else expect(snapshot.status).toBe(503);
    }
    expect(await page.evaluate(() => Reflect.get(globalThis, '__releaseRuntimeErrors'))).toEqual([]);
  }
  await page.goto('news/');
  await expect(page.locator('body')).toHaveAttribute('data-page', 'offline');
  expect(await page.evaluate(() => Reflect.get(globalThis, '__releaseRuntimeErrors'))).toEqual([]);
  // Playwright's WebKit _onConsoleMessage promotes native fetch cancellation
  // diagnostics to pageerror (source=javascript), even when fetch is caught.
  // Keep those specific local network diagnostics as evidence; real window
  // error/unhandledrejection events above and all other pageerrors remain fatal.
  const nativeDiagnostics = errors.filter((error) => disconnectedServer && error.name === 'Fetch API cannot load http'
    && /^\/localhost:8089\/pnw-tribal-dashboard\/data\/(?:live|ref|geo|registry|curated)\/[a-z0-9/_-]+\.json due to access control checks\.$/.test(error.message));
  if (nativeDiagnostics.length) await testInfo.attach('webkit-native-network-diagnostics', { body: JSON.stringify(nativeDiagnostics, null, 2), contentType: 'application/json' });
  expect(errors.filter((error) => !nativeDiagnostics.includes(error))).toEqual([]);
});
