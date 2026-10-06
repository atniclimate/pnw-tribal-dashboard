// @ts-check
/**
 * Discrimination checks for the release gate's WebKit diagnostic classifier (support/runtime-diagnostics.mjs).
 *
 * The offline release spec accepts one narrow kind of WebKit pageerror as evidence: the engine's own
 * "Fetch API cannot load <url> due to access control checks." console diagnostic, when its stack proves the
 * fetch came from the guarded call site in js/core/net.js. This spec shows that the classifier
 *   - accepts exactly that shape (synthetic records),
 *   - rejects every near miss (synthetic records),
 *   - does not match real uncaught errors raised in a live page (negative controls: a timer throw, an unhandled
 *     rejection, an uncaught fetch under route.abort), each of which must also reach the window error sink,
 *   - and sees a caught fetch through the real net.js as a clean network result with no window error.
 * Probes run on an uncontrolled page (no service worker), where context.route interception applies.
 */
import { expect, test } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { startServer } from '../../scripts/dev/serve.mjs';
import { classifyPageErrors, installRuntimeErrorSink, isNativeFetchDiagnostic } from './support/runtime-diagnostics.mjs';

const ORIGIN = 'http://localhost:8089';
/** A bare text document on the artifact origin: no scripts, no service worker, nothing that fetches. */
const PROBE_PAGE = 'robots.txt';
const REMOTE_ALERTS = 'https://api.weather.gov/alerts/active';

/** @type {import('node:http').Server | undefined} */
let server;
test.beforeAll(async () => {
  server = /** @type {import('node:http').Server} */ (await startServer({ root: fileURLToPath(new URL('../../_site/', import.meta.url)), port: 8089 }));
});
test.afterAll(async () => {
  const active = server;
  server = undefined;
  active?.closeAllConnections();
  await new Promise((resolve) => active ? active.close(resolve) : resolve(undefined));
});

const NET = `${ORIGIN}/pnw-tribal-dashboard/v/0123456789ab/js/core/net.js:103:28`;
const NET_EXECUTE = `${ORIGIN}/pnw-tribal-dashboard/v/0123456789ab/js/core/net.js:161:16`;

/**
 * A pageerror shaped the way Playwright's WebKit driver builds it: stack = console text + synthesized frames.
 * @param {string} text
 * @param {string[]} frames
 * @returns {{ stack: string }}
 */
function record(text, frames) {
  return { stack: [text, ...frames.map((frame) => `    at ${frame}`)].join('\n') };
}
const diagnostic = (/** @type {string} */ url) => `Fetch API cannot load ${url} due to access control checks.`;

test.describe('classifier on synthetic records', () => {
  const accepted = /** @type {[string, { stack: string }][]} */ ([
    ['api.weather.gov alerts with a query', record(diagnostic(`${REMOTE_ALERTS}?area=WA&status=actual`), [`attempt (${NET})`])],
    ['api.weather.gov alerts without a query', record(diagnostic(REMOTE_ALERTS), [`attempt (${NET})`, `execute (${NET_EXECUTE})`])],
    ['www.fema.gov declarations', record(diagnostic('https://www.fema.gov/api/open/v2/DisasterDeclarationsSummaries?$top=1000'), [`attempt (${NET})`])],
    ['local live data', record(diagnostic(`${ORIGIN}/pnw-tribal-dashboard/data/live/alerts.json`), [`attempt (${NET})`])],
    ['local curated data', record(diagnostic(`${ORIGIN}/pnw-tribal-dashboard/data/curated/sources.json`), [`attempt (${NET})`, `execute (${NET_EXECUTE})`])],
  ]);
  for (const [name, error] of accepted) {
    test(`accepts ${name}`, () => {
      expect(isNativeFetchDiagnostic(error, ORIGIN)).toBe(true);
      expect(classifyPageErrors([error], { webkit: true, origin: ORIGIN })).toEqual({ diagnostics: [error], fatal: [] });
    });
    test(`leaves ${name} fatal outside WebKit`, () => {
      expect(classifyPageErrors([error], { webkit: false, origin: ORIGIN })).toEqual({ diagnostics: [], fatal: [error] });
    });
  }

  const rejected = /** @type {[string, { stack?: string | undefined }][]} */ ([
    ['an empty stack', { stack: '' }],
    ['a missing stack', {}],
    ['the right text with no frames', { stack: diagnostic(`${REMOTE_ALERTS}?x=1`) }],
    ['an unregistered host', record(diagnostic('https://example.org/alerts/active'), [`attempt (${NET})`])],
    ['a lookalike host', record(diagnostic('https://api.weather.gov.example.org/alerts/active'), [`attempt (${NET})`])],
    ['a lookalike userinfo host', record(diagnostic('https://api.weather.gov@example.org/alerts/active'), [`attempt (${NET})`])],
    ['plain http for a registered host', record(diagnostic('http://api.weather.gov/alerts/active'), [`attempt (${NET})`])],
    ['an unregistered path on a registered host', record(diagnostic('https://api.weather.gov/points/47.6,-122.3'), [`attempt (${NET})`])],
    ['a non-data local path', record(diagnostic(`${ORIGIN}/pnw-tribal-dashboard/sw.js`), [`attempt (${NET})`])],
    ['a local path outside the data directories', record(diagnostic(`${ORIGIN}/pnw-tribal-dashboard/data/private/x.json`), [`attempt (${NET})`])],
    ['a different local origin', record(diagnostic('http://localhost:9999/pnw-tribal-dashboard/data/live/alerts.json'), [`attempt (${NET})`])],
    ['a different message ending', { stack: `Fetch API cannot load ${REMOTE_ALERTS} due to a network error.\n    at attempt (${NET})` }],
    ['a different message start', { stack: `TypeError: Fetch API cannot load ${REMOTE_ALERTS} due to access control checks.\n    at attempt (${NET})` }],
    ['a trailing unrelated line', { stack: `${diagnostic(REMOTE_ALERTS)}\n    at attempt (${NET})\nextra` }],
    ['an extra frame from another file', record(diagnostic(REMOTE_ALERTS), [`attempt (${NET})`, `unknown (${ORIGIN}/pnw-tribal-dashboard/v/0123456789ab/js/pages/dashboard.js:10:1)`])],
    ['a frame from net.js with another function name', record(diagnostic(REMOTE_ALERTS), [`fetchJson (${NET})`])],
    ['a spoofed attempt frame in another file', record(diagnostic(REMOTE_ALERTS), [`attempt (${ORIGIN}/pnw-tribal-dashboard/v/0123456789ab/js/pages/dashboard.js:10:1)`])],
    ['a net.js frame on another origin', record(diagnostic(REMOTE_ALERTS), [`attempt (https://example.org/pnw-tribal-dashboard/v/0123456789ab/js/core/net.js:1:1)`])],
    ['an uncaught TypeError from net.js', record('TypeError: undefined is not an object (evaluating \'res.ok\')', [`attempt (${NET})`])],
    ['a timer throw', record('Error: boom', [`unknown (${ORIGIN}/pnw-tribal-dashboard/robots.txt:1:1)`])],
  ]);
  for (const [name, error] of rejected) {
    test(`rejects ${name}`, () => {
      expect(isNativeFetchDiagnostic(error, ORIGIN)).toBe(false);
      expect(classifyPageErrors([error], { webkit: true, origin: ORIGIN })).toEqual({ diagnostics: [], fatal: [error] });
    });
  }
});

/**
 * @param {import('@playwright/test').Page} page
 * @returns {Error[]} the live array of pageerrors
 */
function collectPageErrors(page) {
  /** @type {Error[]} */
  const errors = [];
  page.on('pageerror', (error) => errors.push(error));
  return errors;
}

/**
 * Opens the uncontrolled probe page with the runtime error sink and the same nonlocal request abort the offline spec uses.
 * @param {import('@playwright/test').Page} page
 * @param {import('@playwright/test').BrowserContext} context
 */
async function openProbePage(page, context) {
  const sink = await installRuntimeErrorSink(context);
  await context.route((url) => url.hostname !== 'localhost' && url.hostname !== '127.0.0.1', (route) => route.abort('failed'));
  const pageErrors = collectPageErrors(page);
  await page.goto(PROBE_PAGE);
  expect(await page.evaluate(() => Boolean(globalThis.navigator.serviceWorker?.controller))).toBe(false);
  return { sink, pageErrors };
}

test.describe('negative controls: real uncaught errors are not diagnostics', () => {
  const controls = /** @type {[string, () => void, 'error' | 'unhandledrejection', string][]} */ ([
    ['a throw from a timer', () => { setTimeout(() => { throw new Error('release-control-timer'); }, 0); }, 'error', 'release-control-timer'],
    ['an unhandled Promise.reject', () => { void Promise.reject(new Error('release-control-rejection')); }, 'unhandledrejection', 'release-control-rejection'],
    ['an uncaught fetch under route.abort', () => { setTimeout(() => { void globalThis.fetch('https://api.weather.gov/alerts/active?release-control=uncaught'); }, 0); }, 'unhandledrejection', ''],
  ]);
  for (const [name, trigger, kind, needle] of controls) {
    test(`${name} reaches the sink and is not matched`, async ({ page, context }) => {
      const { sink, pageErrors } = await openProbePage(page, context);
      await page.evaluate(trigger);
      await expect.poll(() => sink.length, { message: 'the runtime error sink received the control' }).toBeGreaterThan(0);
      await expect.poll(() => pageErrors.length, { message: 'the browser reported a pageerror for the control' }).toBeGreaterThan(0);
      expect(sink[0]?.kind).toBe(kind);
      expect(sink[0]?.message).toContain(needle);
      expect(await page.evaluate(() => Reflect.get(globalThis, '__releaseRuntimeErrors')?.length)).toBeGreaterThan(0);
      // Matching is by stack shape, so every engine's records are tried against the classifier with WebKit rules on.
      for (const error of pageErrors) expect(isNativeFetchDiagnostic(error, ORIGIN), `${error.name}: ${error.message}\n${error.stack}`).toBe(false);
      expect(classifyPageErrors(pageErrors, { webkit: true, origin: ORIGIN }).fatal).toEqual(pageErrors);
    });
  }

  test('the sink keeps an error from a document that a navigation has torn down', async ({ page, context }) => {
    const { sink } = await openProbePage(page, context);
    await page.evaluate(() => { setTimeout(() => { throw new Error('release-control-before-navigation'); }, 0); });
    await expect.poll(() => sink.length).toBeGreaterThan(0);
    await page.goto('offline.html');
    expect(await page.evaluate(() => Reflect.get(globalThis, '__releaseRuntimeErrors'))).toEqual([]);
    expect(sink).toHaveLength(1);
    expect(sink[0]?.message).toContain('release-control-before-navigation');
    expect(sink[0]?.url).toContain(PROBE_PAGE);
  });
});

test.describe('caught fetches through the real net.js', () => {
  /**
   * Loads the real sources.js and net.js from the candidate onto the probe page.
   * @param {import('@playwright/test').Page} page
   */
  async function loadNet(page) {
    const sha12 = await page.evaluate(async () => (await (await globalThis.fetch('/pnw-tribal-dashboard/build-info.json')).json()).sha12);
    expect(sha12).toMatch(/^[0-9a-f]{12}$/);
    await page.evaluate(async (hash) => {
      const base = `/pnw-tribal-dashboard/v/${hash}/js/core/`;
      Reflect.set(globalThis, '__releaseNet', await import(`${base}net.js`));
      await (await import(`${base}sources.js`)).loadSources();
    }, sha12);
  }
  /** @param {import('@playwright/test').TestInfo} testInfo @param {string} name @param {Error[]} pageErrors */
  async function attachPageErrors(testInfo, name, pageErrors) {
    await testInfo.attach(name, { body: JSON.stringify(pageErrors.map((error) => ({ name: error.name, message: error.message, stack: error.stack })), null, 2), contentType: 'application/json' });
  }

  test('a fetch aborted by the route resolves as a network result, never as a window error', async ({ page, context }, testInfo) => {
    const webkit = testInfo.project.name === 'webkit-release';
    const { sink, pageErrors } = await openProbePage(page, context);
    await loadNet(page);
    const result = await page.evaluate(() => Reflect.get(globalThis, '__releaseNet').fetchJson('nws-alerts-active', { retries: 0, params: { area: 'WA' } }));
    expect(result.ok).toBe(false);
    expect(result.error.kind).toBe('network');
    await page.waitForTimeout(750);
    expect(sink, 'a caught fetch must not raise a window error or unhandled rejection').toEqual([]);
    expect(await page.evaluate(() => Reflect.get(globalThis, '__releaseRuntimeErrors'))).toEqual([]);
    await attachPageErrors(testInfo, 'abort-pageerrors', pageErrors);
    // Whatever the engine reports for the caught fetch must be a matched diagnostic, never an unexplained pageerror.
    const { diagnostics, fatal } = classifyPageErrors(pageErrors, { webkit, origin: ORIGIN });
    expect(fatal.map((error) => `${error.name}: ${error.message}\n${error.stack}`)).toEqual([]);
    if (!webkit) expect(diagnostics).toEqual([]);
  });

  test('a fetch cancelled by navigation is a caught fetch: matched diagnostics only, no window error', async ({ page, context }, testInfo) => {
    const webkit = testInfo.project.name === 'webkit-release';
    const { sink, pageErrors } = await openProbePage(page, context);
    await loadNet(page);
    // Hold the request open (a later, more specific route wins over the abort) so navigation cancels it in flight.
    let held = 0;
    await context.route(`${REMOTE_ALERTS}*`, () => { held += 1; });
    await page.evaluate(() => { void Reflect.get(globalThis, '__releaseNet').fetchJson('nws-alerts-active', { retries: 0, params: { area: 'WA' } }); });
    await expect.poll(() => held, { message: 'the cancelled fetch reached the route' }).toBeGreaterThan(0);
    await page.goto('offline.html');
    await page.waitForTimeout(1000);
    expect(sink, 'a cancelled caught fetch must not raise a window error or unhandled rejection').toEqual([]);
    await attachPageErrors(testInfo, 'cancelled-pageerrors', pageErrors);
    const { diagnostics, fatal } = classifyPageErrors(pageErrors, { webkit, origin: ORIGIN });
    expect(fatal.map((error) => `${error.name}: ${error.message}\n${error.stack}`)).toEqual([]);
    if (!webkit) expect(diagnostics).toEqual([]);
  });
});
