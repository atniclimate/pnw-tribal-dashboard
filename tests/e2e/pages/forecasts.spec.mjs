// @ts-check
/**
 * Forecasts page (blueprint 7.3, 8.3, 10.2; lane L12). Upstream payloads are the dated captures in
 * tests/fixtures/upstream (real NWS and ECCC responses); the scheduled files (imagery-stamps.json,
 * gauges-status.json) are produced by the real snapshot tasks and normalizers from real HEAD
 * and gauge captures; image and video bodies are test doubles (a one pixel PNG), so only the requests, labels,
 * and controls are asserted, never imagery. The browser clock is fixed at 10/05/2026 10:00 UTC so the captures
 * are the age they were when taken.
 */
import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import imageryStamps from '../../../scripts/snapshot/tasks/imagery-stamps.mjs';
import { normalizeNwpsGaugeList } from '../../../site/static/js/hydro/nwps.js';
import { attachGuards, axeProblems, horizontalOverflow } from '../support/harness.mjs';

const UP = new URL('../../fixtures/upstream/', import.meta.url);
/** @param {string} p */
const json = async (p) => JSON.parse(await readFile(new URL(p, UP), 'utf8'));
const NOW = new Date('2026-10-05T10:00:00Z');
const LUMMI = 'us-wa-lummi-tribe-of-the-lummi-reservation';
const BC = 'ca-fn-602';
/** One transparent pixel: a stand-in body for image requests. */
const PIXEL = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');

const bundles = ['goes18-star-cdn', 'wpc-images', 'nws-ridge'];
/** @returns {Promise<Record<string, any>>} */
async function scheduledFiles() {
  const heads = (await Promise.all(bundles.map((s) => json(`${s}/2026-10-05-head-probe.json`)))).flatMap((b) => b.results);
  const byUrl = new Map(heads.map((r) => [r.url, r]));
  const http = {
    /** @param {string} id @param {string} url */
    async head(id, url) {
      const r = byUrl.get(url);
      const at = NOW.toISOString();
      return r && r.status === 200 ? { ok: true, data: null, status: 200, fetchedAt: at, lastModified: r.lastModified, sourceId: id } : { ok: false, error: { kind: 'http', status: 404, message: 'HTTP 404' }, fetchedAt: at, sourceId: id };
    },
  };
  const ctx = /** @type {any} */ ({ now: NOW, http, log() {} });
  const stamps = (await imageryStamps.run(ctx))['imagery-stamps.json'];
  const gaugeFixture = await json('nwps-gauges/2026-10-05-bbox-skagit-nooksack.json');
  const items = normalizeNwpsGaugeList(gaugeFixture, { fetchedAt: '2026-10-05T06:25:00.000Z', now: NOW });
  const times = items.map((i) => i.observed?.validTime).filter(Boolean).sort();
  const gauges = { schema: 'cthd.live.gauges-status/1', id: 'gauges', sourceIds: ['nwps-gauges'], generatedAt: NOW.toISOString(), observedAt: NOW.toISOString(), asOf: times.at(-1) ?? null, asOfBasis: 'valid', completeness: 'complete', carriedForward: false, failure: null, perSource: { 'nwps-gauges': { ok: true, count: items.length, asOf: times.at(-1) ?? null } }, diagnostics: {}, items };
  return { 'imagery-stamps.json': stamps, 'gauges-status.json': gauges };
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {{ down?: boolean }} [opts]
 */
async function world(page, opts = {}) {
  const files = await scheduledFiles();
  const nws = {
    '/points/48.792,-122.6262': await json('nws-points/2026-10-05-lummi-hq.json'),
    '/gridpoints/SEW/127,126/forecast': await json('nws-forecast/2026-10-05-sew-lummi-hq.json'),
    '/gridpoints/SEW/127,126': await json('nws-gridpoints/2026-10-05-sew-lummi-hq.json'),
    '/gridpoints/SEW/127,126/stations': await json('nws-stations/2026-10-05-sew-lummi-hq-stations.json'),
    '/stations/KBLI/observations/latest': await json('nws-observations/2026-10-05-kbli-latest.json'),
    '/products/types/AFD/locations/SEW/latest': await json('nws-afd/2026-10-05-sew-latest.json'),
  };
  const city = await json('eccc-citypage-realtime/2026-10-05-bc-cranbrook.json');
  const riverHistory = await json('nwps-gauge-series/2026-10-06-mvew1-stageflow.json');
  const wscHistory = await json('eccc-hydrometric-series/2026-10-06-07ea004-history.json');
  /** @type {string[]} */
  const imageRequests = [];
  /** @param {import('@playwright/test').Route} route */
  const image = (route) => {
    imageRequests.push(route.request().url());
    return route.fulfill({ status: 200, contentType: route.request().url().endsWith('.mp4') ? 'video/mp4' : 'image/png', body: PIXEL });
  };
  const g = await attachGuards(page, {
    pageId: 'forecasts',
    ...(opts.down ? { down: true } : {
      mocks: {
        'api.weather.gov': (route) => {
          const path = new URL(route.request().url()).pathname;
          const body = /** @type {Record<string, unknown>} */ (nws)[path];
          return body ? route.fulfill({ status: 200, contentType: 'application/geo+json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(body) }) : route.fulfill({ status: 404, contentType: 'application/json', body: '{}' });
        },
        'api.weather.gc.ca': (route) => route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(route.request().url().includes('/hydrometric-realtime/') ? wscHistory : city) }),
        'api.water.noaa.gov': (route) => route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(riverHistory) }),
        'cdn.star.nesdis.noaa.gov': image, 'www.wpc.ncep.noaa.gov': image, 'radar.weather.gov': image,
      },
    }),
  });
  if (!opts.down) {
    await page.route('**/data/live/*.json', (route) => {
      const name = new URL(route.request().url()).pathname.split('/').pop() ?? '';
      const body = files[name];
      return body ? route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) }) : route.fulfill({ status: 404, body: '' });
    });
  }
  await page.clock.install({ time: NOW });
  return { g, imageRequests };
}

/** @param {import('@playwright/test').Page} page @param {string} name */
const panel = (page, name) => page.locator(`[data-panel="${name}"]`);

test.describe('Local view', () => {
  test('a U.S. Nation shows Current Conditions from an observation, 14 periods labeled 7-Day Forecast, QPF bars, and a collapsed discussion', async ({ page }) => {
    await world(page);
    await page.goto(`forecasts/?n=${LUMMI}`);
    const local = panel(page, 'forecast-local');
    await expect(local.locator('[data-forecast-periods] caption')).toHaveText('7-Day Forecast');
    await expect(local.locator('[data-forecast-periods] tbody tr')).toHaveCount(14);
    await expect(local.getByRole('heading', { name: 'Current Conditions' })).toBeVisible();
    await expect(local).toContainText('Bellingham, Bellingham International Airport');
    await expect(local).toContainText('A station observation, not a forecast');
    const bars = panel(page, 'forecast-qpf').locator('svg[data-chart="qpf-interactive"]');
    await expect(bars).toBeVisible();
    await expect(panel(page, 'forecast-qpf').locator('[data-chart-readout]')).toContainText('Today');
    const toggle = panel(page, 'forecast-afd').locator('[data-afd-toggle]');
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(panel(page, 'forecast-afd').locator('[data-afd-text]')).toBeHidden();
    await toggle.click();
    await expect(panel(page, 'forecast-afd').locator('[data-afd-text]')).toContainText('Area Forecast Discussion');
    for (const name of ['forecast-local', 'forecast-qpf', 'forecast-afd']) await expect(panel(page, name).locator('[data-provenance] time[datetime]').first()).toBeVisible();
  });

  test('a British Columbia Nation shows the city page forecast with its distance, no QPF bars, and no discussion', async ({ page }) => {
    await world(page);
    await page.goto(`forecasts/?n=${BC}`);
    const local = panel(page, 'forecast-local');
    await expect(local).toContainText(/Forecast for Cranbrook, \d+ km from .+ headquarters\./);
    await expect(local.locator('[data-forecast-periods] tbody tr')).toHaveCount(12);
    await expect(local).toContainText('Clear. Fog patches developing overnight. Low plus 5.');
    await expect(panel(page, 'forecast-qpf')).toContainText('no verified source supplies them');
    await expect(panel(page, 'forecast-qpf').locator('svg[data-chart]')).toHaveCount(0);
    await expect(panel(page, 'forecast-afd')).toContainText('do not cover British Columbia');
  });

  test('with no Nation chosen the panel says so, names the official source, and shows no forecast', async ({ page }) => {
    await world(page);
    await page.goto('forecasts/');
    const local = panel(page, 'forecast-local');
    await expect(local).toContainText('No Nation is selected');
    await expect(local.locator('[data-provenance] a[href^="https://"]').first()).toBeVisible();
    await expect(local.locator('[data-forecast-periods]')).toHaveCount(0);
  });

  test('with every upstream down each panel is unavailable with a reason and shows no number', async ({ page }) => {
    await world(page, { down: true });
    await page.goto(`forecasts/?n=${LUMMI}`);
    for (const name of ['forecast-local', 'forecast-qpf', 'forecast-afd']) {
      await expect(panel(page, name).locator('[data-provenance]')).toHaveAttribute('data-status', 'unavailable', { timeout: 30_000 });
      expect(/\d/.test((await panel(page, name).locator('[data-panel-body]').innerText()))).toBe(false);
    }
  });
});

test.describe('Precipitation view', () => {
  test('WPC and ERO labels are exact, one image loads on open, and each is stamped', async ({ page }) => {
    const { imageRequests } = await world(page);
    await page.goto('forecasts/?view=precip');
    const wpc = panel(page, 'precip-wpc');
    await expect(wpc.getByRole('group', { name: 'Quantitative Precipitation Forecast' }).getByRole('button')).toHaveText(['Day 1', 'Day 2', 'Day 3', 'Days 1 to 3', 'Days 4 and 5', 'Days 6 and 7', '7-Day Total']);
    await expect(wpc.getByRole('group', { name: 'Excessive Rainfall Outlook' }).getByRole('button')).toHaveText(['Day 1', 'Day 2', 'Day 3']);
    await expect(wpc.locator('img')).toHaveAttribute('src', /fill_94qwbg\.gif$/);
    await expect(wpc.locator('img')).toHaveAttribute('width', '800');
    await expect(wpc.locator('.media-viewer__caption time[datetime]')).toHaveCount(1);
    expect(imageRequests.filter((u) => u.includes('wpc.ncep'))).toHaveLength(1);
    await wpc.getByRole('group', { name: 'Excessive Rainfall Outlook' }).getByRole('button', { name: 'Day 2' }).click();
    await expect(wpc.locator('img')).toHaveAttribute('src', /98ewbg\.gif$/);
    await expect(wpc.locator('.media-viewer__caption')).toContainText('Excessive Rainfall Outlook, Day 2');
  });
});

test.describe('Satellite view', () => {
  test('the 300 px still loads on its own; 600 px and the MP4 wait for a labeled tap, with a visible Pause', async ({ page }) => {
    const { imageRequests } = await world(page);
    await page.goto('forecasts/?view=satellite');
    const goes = panel(page, 'satellite-goes');
    await expect(goes.locator('img')).toHaveAttribute('src', /GEOCOLOR\/300x300\.jpg$/);
    expect(imageRequests.filter((u) => u.includes('nesdis'))).toEqual([expect.stringMatching(/GEOCOLOR\/300x300\.jpg$/)]);
    expect(imageRequests.some((u) => /600x600|\.mp4|\.gif/.test(u))).toBe(false);
    await expect(goes.getByRole('button', { name: /^Larger Image \(\d+ KB\)$/ })).toBeVisible();
    await expect(goes.getByRole('button', { name: /^Play Animation \(\d+ KB\)$/ })).toBeVisible();
    await goes.getByRole('button', { name: /^Larger Image/ }).click();
    await expect(goes.locator('img')).toHaveAttribute('src', /GEOCOLOR\/600x600\.jpg$/);
    await goes.getByRole('button', { name: /^Play Animation/ }).click();
    await expect(goes.locator('video[preload="none"][playsinline]')).toHaveCount(1);
    await expect(goes.getByRole('button', { name: /Pause|Play/ }).first()).toBeVisible();
    // The page's content security policy gains the media host when the finisher regenerates it (goes18-star-cdn-video), so the request itself is not asserted here.
    await expect(goes.locator('video')).toHaveAttribute('src', /GOES18-PNW-GEOCOLOR-600x600\.mp4$/);
  });

  test('Bands 09 and 10 offer stills only and an Air Mass note cites the NOAA quick guide', async ({ page }) => {
    await world(page);
    await page.goto('forecasts/?view=satellite');
    const goes = panel(page, 'satellite-goes');
    await goes.getByRole('button', { name: 'Mid-Level Water Vapor (Band 09)' }).click();
    await expect(goes.locator('img')).toHaveAttribute('src', /\/09\/300x300\.jpg$/);
    await expect(goes.getByRole('button', { name: /Play Animation/ })).toHaveCount(0);
    await expect(goes).toContainText('still images only');
    await goes.getByRole('button', { name: 'Air Mass' }).click();
    await expect(page.locator('[data-airmass-note]')).toBeVisible();
    await expect(page.locator('[data-airmass-note] a')).toHaveAttribute('href', /QuickGuide_GOESR_AirMassRGB_final\.pdf$/);
  });

  test.describe('with reduced motion', () => {
    test.use({ reducedMotion: 'reduce' });
    test('stills stay; the radar loop is a link to the source, and nothing plays', async ({ page }) => {
      const { imageRequests } = await world(page);
      await page.goto(`forecasts/?view=radar&n=${LUMMI}`);
      const ridge = panel(page, 'radar-ridge');
      await expect(ridge.locator('img')).toHaveAttribute('src', /KATX_0\.gif$/);
      await expect(ridge.getByRole('button', { name: /Play Loop/ })).toHaveCount(0);
      await expect(ridge.getByRole('link', { name: /Open Loop at the Source/ })).toBeVisible();
      expect(imageRequests.some((u) => /_loop\.gif|\.mp4/.test(u))).toBe(false);
    });
  });
});

test.describe('Radar view', () => {
  test('the nearest station by great-circle distance, a still on open, the loop on tap with Pause back to the still', async ({ page }) => {
    const { imageRequests } = await world(page);
    await page.goto(`forecasts/?view=radar&n=${LUMMI}`);
    const ridge = panel(page, 'radar-ridge');
    await expect(ridge).toContainText(/Nearest radar: KATX, about \d+ km from .*Lummi.* headquarters/);
    await expect(ridge.locator('[data-viewer="ridge"] img')).toHaveAttribute('src', /KATX_0\.gif$/);
    expect(imageRequests.some((u) => u.includes('_loop'))).toBe(false);
    await ridge.locator('[data-viewer="ridge"]').getByRole('button', { name: /^Play Loop \(\d+ KB\)$/ }).click();
    await expect(ridge.locator('[data-viewer="ridge"] img')).toHaveAttribute('src', /KATX_loop\.gif$/);
    await ridge.locator('[data-viewer="ridge"]').getByRole('button', { name: 'Pause' }).click();
    await expect(ridge.locator('[data-viewer="ridge"] img')).toHaveAttribute('src', /KATX_0\.gif$/);
    await expect(ridge.locator('[data-viewer="ridge-mosaic"] img')).toHaveCount(0);
  });

  test('in low-data mode the map waits for a tap and the sovereignty statement is on the panel', async ({ page }) => {
    const { g } = await world(page);
    await page.goto('forecasts/?view=radar&lowdata=1');
    const map = panel(page, 'radar-map');
    await expect(map.getByRole('button', { name: /^Show Map \(about \d+ KB\)$/ })).toBeVisible();
    await expect(map.locator('.sovereignty-note').first()).toContainText('Representation, not jurisdiction.');
    expect(g.requests.some((r) => /maplibre|create-map/.test(r.url))).toBe(false);
  });
});

test.describe('Atmospheric Rivers view', () => {
  test('CW3E and the Total Precipitable Water animation are link-only: a labeled link, the reason, and no request to either provider', async ({ page }) => {
    const { g, imageRequests } = await world(page);
    await page.goto('forecasts/?view=ar');
    const cw = panel(page, 'ar-cw3e');
    const link = cw.getByRole('link', { name: 'Atmospheric river forecasts (CW3E)' });
    await expect(link).toHaveAttribute('href', 'https://cw3e.ucsd.edu/iwv-and-ivt-forecasts/');
    await expect(cw).toContainText('research and not for operational decisions');
    await expect(cw.locator('[data-provenance]')).toContainText('Center for Western Weather and Water Extremes');
    await expect(cw.locator('img, button')).toHaveCount(0);
    const mtpw = panel(page, 'ar-mtpw');
    const link2 = mtpw.getByRole('link', { name: 'Total precipitable water animation (CIMSS, experimental)' });
    await expect(link2).toHaveAttribute('href', 'https://tropic.ssec.wisc.edu/real-time/mtpw2/home.php');
    await expect(mtpw).toContainText('experimental product');
    await expect(mtpw.locator('img, button')).toHaveCount(0);
    expect(imageRequests.some((u) => /cw3e|ssec/.test(u))).toBe(false);
    expect(g.requests.some((r) => /cw3e\.ucsd\.edu|tropic\.ssec\.wisc\.edu/.test(r.url))).toBe(false);
  });
});

test.describe('Rivers view', () => {
  test('interactive WSC history shows real observed level and discharge without forecast or flood categories', async ({ page }, testInfo) => {
    await world(page);
    await page.goto('forecasts/?view=rivers&g=wsc%3A07EA004&units=metric');
    const river = panel(page, 'rivers-gauges');
    await expect(river.locator('svg[data-chart="time-series"]')).toBeVisible();
    await river.getByRole('slider').focus(); await river.getByRole('slider').press('End');
    const source = await json('eccc-hydrometric-series/2026-10-06-07ea004-history.json');
    const latest = source.features[0].properties;
    const format = (/** @type {number} */ value) => new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(value);
    await expect(river.locator('[data-chart-readout]')).toContainText(`Observed: ${format(latest.LEVEL)} m`);
    await river.getByRole('combobox', { name: 'Measurement', exact: true }).selectOption('secondary');
    await river.getByRole('slider').focus(); await river.getByRole('slider').press('End');
    await expect(river.locator('[data-chart-readout]')).toContainText(`Observed: ${format(latest.DISCHARGE)} m³/s`);
    await expect(river.locator('.chart-line--forecast')).toHaveCount(0);
    await expect(river.locator('.chart-threshold')).toHaveCount(0);
    await expect(river).toContainText('No flood category is inferred');
    expect(await horizontalOverflow(page)).toBe(false);
    await river.locator('.gauge-detail__chart').screenshot({ path: testInfo.outputPath('real-wsc-interaction.png') });
  });

  test('interactive river history failure has an explicit fallback and retry recovers without reload', async ({ page }) => {
    await world(page);
    await page.route('https://api.water.noaa.gov/**', (route) => route.abort('failed'));
    await page.goto('forecasts/?view=rivers&g=nwps%3AMVEW1');
    const river = panel(page, 'rivers-gauges');
    await expect(river.getByRole('button', { name: 'Refresh River Data' })).toBeVisible({ timeout: 20_000 });
    await expect(river.locator('.gauge-detail__chart')).toContainText('could not be reached');
    await expect(river.locator('svg[data-chart="time-series"]')).toHaveCount(0);
    await page.unroute('https://api.water.noaa.gov/**');
    await river.getByRole('button', { name: 'Refresh River Data' }).click();
    await expect(river.locator('svg[data-chart="time-series"]')).toBeVisible();
  });

  test('interactive river chart inspects real samples and changes history, measurement, and units', async ({ page }, testInfo) => {
    await world(page);
    await page.goto('forecasts/?view=rivers&g=nwps%3AMVEW1');
    const river = panel(page, 'rivers-gauges');
    const chart = river.locator('svg[data-chart="time-series"]');
    await expect(chart).toBeVisible();
    const source = await json('nwps-gauge-series/2026-10-06-mvew1-stageflow.json');
    const slider = river.getByRole('slider');
    await slider.focus();
    await slider.press('End');
    const end = source.forecast.data.at(-1);
    await expect(river.locator('[data-chart-readout]')).toContainText(`Forecast: ${end.primary} ft`);
    const total = Number(await slider.getAttribute('max'));
    await river.getByRole('combobox', { name: 'Observed History' }).selectOption('24');
    expect(Number(await river.getByRole('slider').getAttribute('max'))).toBeLessThan(total);
    await expect(page).toHaveURL(/grange=24/);
    await river.getByRole('combobox', { name: 'Measurement', exact: true }).selectOption('secondary');
    await river.getByRole('combobox', { name: 'River Units' }).selectOption('metric');
    await river.getByRole('slider').focus();
    await river.getByRole('slider').press('End');
    const flow = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(end.secondary * 28.316846592);
    await expect(river.locator('[data-chart-readout]')).toContainText(`Forecast: ${flow} m³/s`);
    await chart.scrollIntoViewIfNeeded();
    const bounds = await chart.boundingBox();
    if (!bounds) throw new Error('The river chart has no visible bounds');
    if (testInfo.project.name.includes('phone')) await page.touchscreen.tap(bounds.x + bounds.width * 0.12, bounds.y + bounds.height * 0.4);
    else await chart.click({ position: { x: bounds.width * 0.12, y: bounds.height * 0.4 } });
    await expect(river.locator('[data-chart-readout]')).toContainText('Observed:');
    const drag = await chart.evaluate((element) => {
      const svg = /** @type {SVGSVGElement} */ (element);
      const matrix = svg.getScreenCTM();
      if (!matrix) throw new Error('The chart has no screen transform');
      const start = new DOMPoint(80, 120).matrixTransform(matrix);
      const end = new DOMPoint(svg.viewBox.baseVal.width - 1, 120).matrixTransform(matrix);
      return { start: { x: start.x, y: start.y }, end: { x: end.x, y: end.y } };
    });
    await page.mouse.move(drag.start.x, drag.start.y); await page.mouse.down();
    await page.mouse.move(drag.end.x, drag.end.y, { steps: 12 }); await page.mouse.up();
    await expect(river.locator('[data-chart-readout]')).toContainText(`Forecast: ${flow} m³/s`);
    await river.getByText('View Every Chart Value as a Table', { exact: true }).click();
    await expect(river.locator('.chart-data tbody tr').first()).toBeVisible();
    expect(await horizontalOverflow(page)).toBe(false);
    await chart.screenshot({ path: testInfo.outputPath('real-river-interaction.png') });
  });

  test('composes the gauge list and gauge detail from the committed hydrology components', async ({ page }) => {
    await world(page);
    await page.goto('forecasts/?view=rivers');
    const rivers = panel(page, 'rivers-gauges');
    const cards = rivers.locator('.gauge-card');
    await expect(cards.first()).toBeVisible();
    await rivers.locator('.gauge-card a[href*="g="]').first().click();
    await expect(rivers.locator('.gauge-detail')).toBeVisible();
    await expect(rivers.getByRole('link', { name: 'Back to the Gauge List' })).toBeVisible();
  });
});

test('interactive local charts synchronize period, day, range, and unit selection', async ({ page }, testInfo) => {
  await world(page);
  await page.goto(`forecasts/?n=${LUMMI}`);
  const local = panel(page, 'forecast-local');
  const qpf = panel(page, 'forecast-qpf');
  await expect(local.locator('.forecast-period')).toHaveCount(14);
  await expect(local.locator('.chart-period-point')).toHaveCount(14);
  await expect(local.locator('.chart-line')).toHaveCount(0);
  const selected = local.locator('.forecast-period').nth(1);
  const selectedName = await selected.locator('strong').innerText();
  await selected.click();
  await expect(local.locator('[data-forecast-selected] h3')).toHaveText(selectedName);
  await expect(page).toHaveURL(/period=/);
  await local.getByRole('combobox', { name: 'Forecast Units' }).selectOption('metric');
  await expect(qpf.getByRole('combobox', { name: 'Precipitation Units' })).toHaveValue('metric');
  await local.getByRole('slider').focus();
  await local.getByRole('slider').press('End');
  await expect(local.locator('[data-chart-readout]')).toContainText('°C');
  const date = await qpf.getByRole('combobox', { name: 'Inspect Forecast Day' }).locator('option').nth(1).getAttribute('value');
  await qpf.getByRole('combobox', { name: 'Inspect Forecast Day' }).selectOption(date ?? '');
  await expect(local.locator('.forecast-period[aria-pressed="true"]')).toHaveCount(1);
  await expect(page).toHaveURL(new RegExp(`day=${date}`));
  await qpf.getByRole('combobox', { name: 'Precipitation Time Range' }).selectOption('3');
  await expect(local.getByRole('combobox', { name: 'Forecast Time Range' })).toHaveValue('3');
  expect(await local.locator('.forecast-period').count()).toBeLessThanOrEqual(6);
  expect(await horizontalOverflow(page)).toBe(false);
  await local.locator('[data-forecast-explorer]').screenshot({ path: testInfo.outputPath('real-forecast-interaction.png') });
});

test.describe('Accessibility and layout with data', () => {
  for (const view of ['local', 'precip', 'ar', 'satellite', 'radar', 'rivers']) {
    test(`view=${view}: no serious or critical axe violations and no sideways scroll`, async ({ page }) => {
      await world(page);
      await page.goto(`forecasts/?view=${view}&n=${LUMMI}`);
      await expect(panel(page, view === 'local' ? 'forecast-local' : { precip: 'precip-wpc', ar: 'ar-cw3e', satellite: 'satellite-goes', radar: 'radar-ridge', rivers: 'rivers-gauges' }[view] ?? '').locator('[data-provenance] time[datetime], [data-provenance][data-status="unavailable"]').first()).toBeVisible();
      await page.waitForTimeout(500);
      expect(await axeProblems(page)).toEqual([]);
      expect(await horizontalOverflow(page)).toBe(false);
    });
  }
});

test.describe('Network discipline', () => {
  test('opening a view requests nothing from another view, and no image over the budget loads on its own', async ({ page }) => {
    const { imageRequests } = await world(page);
    await page.goto('forecasts/?view=satellite');
    await expect(panel(page, 'satellite-goes').locator('img')).toBeVisible();
    expect(imageRequests.some((u) => /wpc\.ncep|cw3e|ssec|radar\.weather/.test(u))).toBe(false);
  });

  test('every panel carries a provenance footer from the first paint, including views not yet opened', async ({ page }) => {
    await world(page);
    await page.goto('forecasts/');
    await expect(page.locator('[data-panel]')).toHaveCount(11);
    for (const p of await page.locator('[data-panel]').all()) await expect(p.locator('[data-provenance]')).toHaveCount(1);
    await expect(panel(page, 'precip-wpc').locator('[data-provenance]')).toContainText('Not loaded yet');
  });
});
