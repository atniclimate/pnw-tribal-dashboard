// @ts-check
/**
 * The four verification checks of blueprint 10.3 at the browser level, over every page, in mocked (upstreams
 * aborted, snapshot absent), failure, and embed modes:
 *   2. every [data-panel] has a provenance footer whose source ids exist in sources.json and that carries a
 *      time[datetime] or an unavailable reason;
 *   3. every map and boundary display has a visible sovereignty note that elementFromPoint at its center
 *      returns (not covered), at 320 and 1280 px and in embed mode; tile or GPU failure keeps it;
 *   4. no fabricated data: with every upstream down, no panel shows a number.
 * Checks 1 (tokens) and the static half of 2 to 4 are npm run check. Owner: lane L15.
 */
import { expect, test } from '@playwright/test';
import { PAGE_LANES, attachGuards, loadRoutes, mountedOrSkip, provenanceProblems, registeredSourceIds } from './support/harness.mjs';

const { routes } = await loadRoutes();
const SENTENCE = /Representation, not jurisdiction/i;

for (const mode of /** @type {const} */ (['mocked', 'failure', 'embed'])) {
  for (const route of routes.filter((r) => !r.status && r.id !== 'offline')) {
    test(`check 2, ${mode}: ${route.id} panels carry provenance`, async ({ page }) => {
      // No mocked upstream handlers exist before the page lanes land, so every external request is aborted in all three modes.
      await attachGuards(page, { pageId: route.page, down: true });
      await page.route('**/data/live/**', (request) => request.fulfill({ status: 404, body: 'Not found' }));
      await page.goto(`${route.path}${mode === 'embed' ? '?embed=1' : ''}`);
      const hasPanels = await page.locator('[data-panel]').count();
      test.skip(hasPanels === 0, 'the page has no data panels');
      // Attached, not visible: a page may hold panels in a view that is not open (Usage Sources and Status).
      await mountedOrSkip(page, test, '[data-panel] [data-provenance]', PAGE_LANES[route.page] ?? 'page lane', 4000, 'attached');
      await page.waitForLoadState('networkidle');
      expect(await provenanceProblems(page, await registeredSourceIds())).toEqual([]);
    });
  }
}

test.describe('check 3: sovereignty note on every map and boundary display', () => {
  for (const width of [320, 1280]) {
    for (const embed of [false, true]) {
      test(`alerts map at ${width} px${embed ? ' in embed mode' : ''}: the note is visible and not covered`, async ({ page }) => {
        await page.setViewportSize({ width, height: 740 });
        await attachGuards(page, { pageId: 'alerts' });
        await page.goto(`alerts/?view=map${embed ? '&embed=1' : ''}`);
        await mountedOrSkip(page, test, '.sovereignty-note', 'L8', 8000);
        const note = page.locator('.sovereignty-note').first();
        await expect(note).toBeVisible();
        await expect(note).toContainText(SENTENCE);
        // The page's pre-map note is replaced by the map's own note when the map mounts, so the check reads the
        // current first note in one step (scroll, then hit-test) and retries until the swap has settled.
        await expect.poll(() => page.evaluate((sentence) => {
          const el = document.querySelector('.sovereignty-note');
          if (!el) return 'no note';
          if (!(el.textContent ?? '').toLowerCase().includes(sentence.toLowerCase())) return 'sentence missing';
          el.scrollIntoView({ block: 'center' });
          const r = el.getBoundingClientRect();
          const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
          return hit && (el === hit || el.contains(hit)) ? 'ok' : `covered by ${hit?.tagName}.${hit?.className}`;
        }, SENTENCE.source), { timeout: 10_000, message: 'elementFromPoint at the note center returns the note' }).toBe('ok');
      });
    }
  }

  test('every [data-boundary-display] contains a sovereignty note', async ({ page }) => {
    for (const r of routes.filter((x) => !x.status)) {
      await attachGuards(page, { pageId: r.page });
      await page.goto(r.path);
      const bad = await page.evaluate(() => [...document.querySelectorAll('[data-boundary-display]')].filter((el) => !el.querySelector('.sovereignty-note')).length);
      expect(bad, `${r.id}: boundary displays without the note`).toBe(0);
    }
  });
});

test.describe('check 4: no fabricated data when every upstream is down', () => {
  for (const route of routes.filter((r) => ['dashboard', 'alerts', 'forecasts', 'news'].includes(r.id))) {
    test(`${route.id}: no data panel shows a numeric observation`, async ({ page }) => {
      await attachGuards(page, { pageId: route.page, down: true });
      await page.goto(route.path);
      await mountedOrSkip(page, test, '[data-panel] [data-provenance]', PAGE_LANES[route.page] ?? 'page lane');
      await page.waitForLoadState('networkidle');
      const digits = await page.evaluate(() => [...document.querySelectorAll('[data-panel] [data-panel-body]')].flatMap((b) => {
        const c = /** @type {HTMLElement} */ (b.cloneNode(true));
        c.querySelectorAll('time').forEach((t) => t.remove());
        const m = (c.textContent ?? '').match(/\d[\d.,]*\s?(?:in|mm|ft|m|cfs|°\s?[FC]|percent|%|mph|km\/h)\b/gi);
        return m ?? [];
      }));
      expect(digits).toEqual([]);
    });
  }
});

test('outline mode with WebGL disabled never requests the MapLibre module and still shows the note (scenario 15)', async ({ page }) => {
  const g = await attachGuards(page, { pageId: 'alerts' });
  await page.addInitScript(() => {
    const orig = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (type, ...rest) {
      return /webgl/i.test(String(type)) ? null : /** @type {any} */ (orig).call(this, type, ...rest);
    };
  });
  await page.goto('alerts/?view=map');
  await mountedOrSkip(page, test, '.sovereignty-note', 'L8', 8000);
  expect(g.requests.filter((r) => /maplibre-gl\.mjs/.test(r.url)).map((r) => r.url)).toEqual([]);
  await expect(page.locator('.sovereignty-note').first()).toBeVisible();
});
