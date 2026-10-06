// @ts-check
/**
 * L13 acceptance for the Contacts page (blueprint 7.4, 10.2 scenario 8): every card shows its verified date,
 * source, and an E.164 tel: link; filtering keeps focus; print and copy carry the filter note; a Nation with
 * no verified line gets the honest notice; Near Me for Washington, Idaho, British Columbia, Southeast Alaska,
 * and a point outside the footprint. Upstream replies are dated real captures (tests/fixtures/upstream).
 * Owner: lane L13.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { attachGuards, axeProblems, loadRoutes } from '../support/harness.mjs';

const root = new URL('../../../', import.meta.url);
const fixture = (/** @type {string} */ rel) => readFileSync(new URL(`tests/fixtures/upstream/${rel}`, root), 'utf8');
const { nearMePositions } = await loadRoutes();

test.describe('directory', () => {
  test('every card shows its verified date, its source, and an E.164 tel: link', async ({ page }) => {
    await attachGuards(page, { pageId: 'contacts' });
    await page.goto('contacts/');
    await page.waitForSelector('[data-contact-list] .contact-card');
    const bad = await page.evaluate(() => [...document.querySelectorAll('[data-contact-list] .contact-card')].flatMap((c) => {
      const problems = [];
      const text = c.textContent ?? '';
      if (!/(Verified|checked) \d{2}\/\d{2}\/\d{4}/.test(text)) problems.push('no verified date');
      if (!c.querySelector('.contact-card__verified a[href^="https://"], .contact-card__verified a[href^="http://"]')) problems.push('no source link');
      for (const a of c.querySelectorAll('a[href^="tel:"]')) if (!/^tel:\+[1-9]\d{6,14}$/.test(a.getAttribute('href') ?? '')) problems.push(`tel ${a.getAttribute('href')}`);
      return problems.map((p) => `${c.getAttribute('data-contact-id')}: ${p}`);
    }));
    expect(bad).toEqual([]);
    await expect(page.locator('[data-static-emergency] a[href="tel:911"]')).toBeVisible();
  });

  test('a past-due or flagged line carries the Verification Due tag', async ({ page }) => {
    await attachGuards(page, { pageId: 'contacts' });
    await page.goto('contacts/');
    await page.waitForSelector('[data-contact-list] .contact-card');
    const due = page.locator('[data-contact-list] .contact-card[data-verification-due="true"]').first();
    await expect(due).toContainText('Verification Due');
  });

  test('filtering keeps focus in the search box and narrows the list', async ({ page }) => {
    await attachGuards(page, { pageId: 'contacts' });
    await page.goto('contacts/');
    await page.waitForSelector('[data-contact-list] .contact-card');
    const search = page.getByLabel('Search Contacts');
    await search.focus();
    const visible = () => page.locator('[data-contact-list] > li:not([hidden])').count();
    const before = await visible();
    await page.keyboard.type('lummi');
    await expect(search).toBeFocused();
    expect(await visible()).toBeLessThan(before);
    await expect(page.locator('[data-filter-note]')).toContainText('Search: "lummi"');
    // A typed space is kept (the URL trims it, the box must not).
    await search.fill('');
    await page.keyboard.type('king county');
    await expect(search).toHaveValue('king county');
    await expect(page.locator('[data-filter-note]')).toContainText('Search: "king county"');
    // Chips toggle without moving focus away from the pressed chip.
    await search.fill('');
    const chip = page.getByRole('button', { name: 'Washington', exact: true });
    await chip.focus();
    await page.keyboard.press('Enter');
    await expect(chip).toBeFocused();
    await expect(chip).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('[data-filter-note]')).toContainText('Jurisdiction: Washington');
    await expect(page).toHaveURL(/jur=WA/);
  });

  test('a Nation with no verified contact gets the notice, the state line, and 911, never a guessed number', async ({ page }) => {
    await attachGuards(page, { pageId: 'contacts' });
    await page.goto('contacts/?n=ca-fn-554');
    await page.waitForSelector('[data-contact-list] .contact-card');
    await expect(page.locator('[data-no-contact-notice]')).toContainText('No verified emergency contact is on file for this Nation yet.');
    await expect(page.locator('[data-static-emergency]')).toBeVisible();
    const own = await page.locator('[data-contact-list] > li:not([hidden]) .contact-card__name', { hasText: /Tla'amin/ }).count();
    expect(own).toBe(0);
    await expect(page.locator('[data-contact-list] > li:not([hidden])').first()).toBeVisible();
  });

  test('Copy List and Print both state the active filter', async ({ page, context, browserName }) => {
    test.skip(browserName !== 'chromium', 'clipboard permissions and page.pdf are Chromium features');
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await attachGuards(page, { pageId: 'contacts' });
    await page.goto('contacts/?jur=OR&type=state');
    await page.waitForSelector('[data-contact-list] .contact-card');
    await page.getByRole('button', { name: 'Copy List' }).focus();
    await page.keyboard.press('Enter');
    const copied = await page.evaluate(() => navigator.clipboard.readText());
    expect((copied.split('\n')[0] ?? '').trim()).toMatch(/^Filter: Jurisdiction: Oregon; Type: State and Provincial\. \d+ of \d+ lines\.$/);
    expect(copied).toContain('Oregon Department of Emergency Management');

    // Print: the note is in the page that the @media print rules keep; verify the PDF text.
    await page.emulateMedia({ media: 'print' });
    await expect(page.locator('[data-filter-note]')).toBeVisible();
    const out = test.info().outputPath('contacts-print.pdf');
    mkdirSync(test.info().outputDir, { recursive: true });
    writeFileSync(out, await page.pdf({ format: 'Letter' }));
    let text = '';
    try { text = execFileSync('pdftotext', ['-layout', out, '-'], { encoding: 'utf8' }); } catch { test.skip(true, 'pdftotext is not installed'); }
    expect(text).toContain('Filter: Jurisdiction: Oregon; Type: State and Provincial.');
    expect(text).toContain('Verified');
  });

  test('has no serious accessibility violations', async ({ page }) => {
    test.setTimeout(120_000);
    await attachGuards(page, { pageId: 'contacts' });
    await page.goto('contacts/');
    await page.waitForSelector('[data-contact-list] .contact-card');
    expect(await axeProblems(page)).toEqual([]);
  });

  test('offline: the saved copy is served and the page says so', async ({ page }) => {
    // The service worker (lane L9, Wave 3) precaches contacts.json; core/net.js reports an offline device
    // without trying, so the page reads Cache Storage. A stub Cache Storage stands in for the worker's cache.
    const saved = readFileSync(new URL('site/data/curated/contacts.json', root), 'utf8');
    await attachGuards(page, { pageId: 'contacts' });
    await page.addInitScript((body) => {
      Object.defineProperty(navigator, 'onLine', { get: () => false });
      Object.defineProperty(window, 'caches', { value: { match: async () => new Response(body, { headers: { 'content-type': 'application/json' } }) } });
    }, saved);
    await page.goto('contacts/');
    await page.waitForSelector('[data-contact-list] .contact-card');
    await expect(page.locator('[data-offline-notice]')).toHaveText('Saved for offline use; contacts verified as listed.');
    await expect(page.locator('[data-panel="contacts-directory"] [data-provenance]')).toHaveAttribute('data-status', 'cached');
    await expect(page.locator('[data-contact-list] .contact-card a[href^="tel:+"]').first()).toBeVisible();
  });

  test('when the contacts file cannot be loaded the panel says so and offers 911 and official links', async ({ page }) => {
    await attachGuards(page, { pageId: 'contacts' });
    await page.route('**/data/curated/contacts.json', (r) => r.fulfill({ status: 404, body: '' }));
    await page.goto('contacts/');
    const panel = page.locator('[data-panel="contacts-directory"]');
    await expect(panel.locator('[data-provenance]')).toHaveAttribute('data-status', 'unavailable');
    await expect(panel.locator('[data-panel-body]')).toContainText('could not be loaded');
    await expect(panel.locator('[data-panel-body] a[href^="https://www.weather.gov"]')).toBeVisible();
  });
});

test.describe('scenario 8: Near Me', () => {
  /** @type {Record<string, { points?: string, alerts?: string, expect: RegExp }>} */
  const cases = {
    Washington: { points: 'nws-points/2026-10-05-lummi-hq.json', alerts: 'nws-alerts-active/2026-10-05-point-lummi-hq-rounded.json', expect: /Whatcom County/ },
    Idaho: { points: 'nws-points/2026-10-05-fort-hall-hq.json', alerts: 'nws-alerts-active/2026-10-05-point-lummi-hq-rounded.json', expect: /Idaho Office of Emergency Management/ },
    'Southeast Alaska': { points: 'nws-points/2026-10-05-kasaan-hq.json', alerts: 'nws-alerts-active/2026-10-05-point-lummi-hq-rounded.json', expect: /Alaska Division of Homeland Security/ },
  };
  for (const pos of nearMePositions.filter((p) => cases[p.region])) {
    test(`${pos.region}: nearest five Nations, county or state lines, alerts, and a readable forecast link`, async ({ page, context }) => {
      const c = cases[pos.region];
      await context.grantPermissions(['geolocation']);
      await context.setGeolocation({ latitude: pos.latitude, longitude: pos.longitude });
      const g = await attachGuards(page, { pageId: 'contacts', mocks: { 'api.weather.gov': (route) => (route.request().url().includes('/alerts/active') ? route.fulfill({ status: 200, contentType: 'application/geo+json', body: fixture(c?.alerts ?? '') }) : route.fulfill({ status: 200, contentType: 'application/geo+json', body: fixture(c?.points ?? '') })) } });
      const requests = /** @type {string[]} */ ([]);
      page.on('request', (r) => { if (r.url().startsWith('https://api.weather.gov')) requests.push(r.url()); });
      await page.goto('contacts/?view=near-me');
      await page.getByRole('button', { name: 'Use My Location' }).click();
      const panel = page.locator('[data-panel="contacts-near-me"]');
      await expect(panel.locator('[data-nearest-nation]')).toHaveCount(5);
      await expect(panel).toContainText(c?.expect ?? /./);
      await expect(panel).toContainText('Representation, not jurisdiction.');
      const link = panel.locator('a[href^="https://forecast.weather.gov/MapClick.php?lat="]');
      await expect(link).toHaveCount(1);
      expect(await link.getAttribute('href')).toMatch(/lat=-?\d+(\.\d{1,3})?&lon=-?\d+(\.\d{1,3})?$/);
      await expect(panel.locator('[data-no-alerts]')).toContainText('This is not an all-clear');
      // Coordinates are rounded to three decimals before any request.
      for (const u of requests) for (const m of u.matchAll(/-?\d+\.\d+/g)) expect((m[0].split('.')[1] ?? '').length).toBeLessThanOrEqual(3);
      expect(requests.some((u) => u.includes('/points/'))).toBe(true);
      expect(await page.evaluate(() => JSON.stringify([localStorage, sessionStorage]))).not.toMatch(/-?\d{2,3}\.\d{3}/);
      expect(g.blockedHosts).toEqual([]);
      await expect(panel.locator('[data-provenance] time[datetime]').first()).toBeVisible();
    });
  }

  test('a point inside an active alert lists the alert, its expiry, and the issuing office', async ({ page, context }) => {
    await context.grantPermissions(['geolocation']);
    await context.setGeolocation({ latitude: 39.022, longitude: -122.887 });
    await page.clock.setFixedTime(new Date('2026-10-05T10:00:00Z'));
    await attachGuards(page, { pageId: 'contacts', mocks: { 'api.weather.gov': (route) => route.fulfill({ status: 200, contentType: 'application/geo+json', body: fixture(route.request().url().includes('/alerts/active') ? 'nws-alerts-active/2026-10-05-point-big-valley-heat-advisory.json' : 'nws-points/2026-10-05-big-valley-rounded.json') }) } });
    await page.goto('contacts/?view=near-me');
    await page.getByRole('button', { name: 'Use My Location' }).click();
    const alerts = page.locator('[data-point-alerts] .alert-card');
    await expect(alerts).toHaveCount(1);
    await expect(alerts.first()).toContainText('Heat Advisory');
    await expect(alerts.first()).toContainText('Expires');
    await expect(alerts.first()).toContainText('Issued by');
  });

  test('British Columbia: the EMCR region comes from a local polygon test, and alerts are honest when the scheduled copy is missing', async ({ page, context }) => {
    const pos = nearMePositions.find((p) => p.region === 'British Columbia');
    await context.grantPermissions(['geolocation']);
    await context.setGeolocation({ latitude: pos?.latitude ?? 0, longitude: pos?.longitude ?? 0 });
    const g = await attachGuards(page, { pageId: 'contacts' });
    await page.route('**/data/live/**', (r) => r.fulfill({ status: 404, body: '' }));
    const hosts = /** @type {string[]} */ ([]);
    page.on('request', (r) => { const u = new URL(r.url()); if (u.hostname !== 'localhost') hosts.push(u.hostname); });
    await page.goto('contacts/?view=near-me');
    await page.getByRole('button', { name: 'Use My Location' }).click();
    const panel = page.locator('[data-panel="contacts-near-me"]');
    await expect(panel.locator('[data-emcr-region]')).toContainText('emergency management region');
    await expect(panel.locator('[data-alerts-unavailable]')).toBeVisible();
    await expect(panel.locator('a[href^="https://weather.gc.ca/en/location/index.html?coords="]')).toHaveCount(1);
    expect(hosts.filter((h) => h === 'api.weather.gov')).toEqual([]);
    expect(g.blockedHosts).toEqual([]);
  });

  test('outside the footprint: the message and national links, and no weather request', async ({ page, context }) => {
    const pos = nearMePositions.find((p) => p.region === 'Outside the footprint');
    await context.grantPermissions(['geolocation']);
    await context.setGeolocation({ latitude: pos?.latitude ?? 0, longitude: pos?.longitude ?? 0 });
    await attachGuards(page, { pageId: 'contacts' });
    const hosts = /** @type {string[]} */ ([]);
    page.on('request', (r) => hosts.push(new URL(r.url()).hostname));
    await page.goto('contacts/?view=near-me');
    await page.getByRole('button', { name: 'Use My Location' }).click();
    const panel = page.locator('[data-panel="contacts-near-me"]');
    await expect(panel.locator('[data-outside-footprint]')).toHaveText('This location is outside the area this dashboard covers.');
    await expect(panel.locator('a[href^="https://www.weather.gov"]').first()).toBeVisible();
    expect(hosts).not.toContain('api.weather.gov');
  });

  test('a refused location permission is stated plainly and offers the Directory', async ({ page, context }) => {
    await context.clearPermissions();
    await attachGuards(page, { pageId: 'contacts' });
    await page.goto('contacts/?view=near-me');
    await page.getByRole('button', { name: 'Use My Location' }).click();
    await expect(page.locator('[data-location-problem]')).toContainText(/permission|not available/i);
    await expect(page.getByRole('button', { name: 'Use My Location' })).toBeVisible();
  });
});
