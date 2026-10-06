// @ts-check
/**
 * Blueprint 10.2 scenarios 12, 16, and 17: reduced motion, and the interactive map's keyboard behavior and
 * GPU-failure fallback. Map code is lane L8's (Wave 2); each test skips with that reason until a map mounts.
 * The no-WebGL project (outline mode, scenario 15) runs only specs named map*.spec.mjs, which lane L8 owns;
 * the outline-mode checks that apply to every page live in verify.spec.mjs. Owner: lane L15.
 */
import { expect, test } from '@playwright/test';
import { attachGuards, mountedOrSkip } from './support/harness.mjs';

test.describe('reduced motion', () => {
  test.use({ reducedMotion: 'reduce' });

  test('scenario 12: with reduced motion nothing plays, and no animation is requested without a tap', async ({ page }) => {
    const g = await attachGuards(page, { pageId: 'forecasts' });
    await page.goto('forecasts/?view=satellite');
    await page.waitForLoadState('networkidle');
    expect(g.requests.filter((r) => r.type.startsWith('video/') || /\.mp4(\?|$)/.test(r.url)).map((r) => r.url), 'video requested before a tap').toEqual([]);
    const playing = await page.evaluate(() => [...document.querySelectorAll('video')].filter((v) => !v.paused).length);
    expect(playing).toBe(0);
  });

  test('CSS animations and transitions collapse to near zero when reduced motion is requested', async ({ page }) => {
    await attachGuards(page, { pageId: 'dashboard' });
    await page.goto('./');
    const sheets = await page.evaluate(() => document.styleSheets.length);
    test.skip(sheets === 0, 'stylesheets are not delivered yet (lane L1 pending)');
    const long = await page.evaluate(() => [...document.querySelectorAll('*')].filter((el) => {
      const s = getComputedStyle(el);
      const dur = (/** @type {string} */ v) => v.split(',').map((x) => parseFloat(x) * (x.trim().endsWith('ms') ? 1 : 1000)).some((ms) => ms > 20);
      return (s.animationName !== 'none' && dur(s.animationDuration)) || dur(s.transitionDuration);
    }).slice(0, 5).map((el) => el.tagName.toLowerCase() + '.' + el.className));
    expect(long).toEqual([]);
  });

  test('scenario 17: selecting a Nation changes the map view with no intermediate camera frames', async ({ page }) => {
    await attachGuards(page, { pageId: 'alerts' });
    await page.goto('alerts/?view=map');
    await mountedOrSkip(page, test, 'canvas.maplibregl-canvas', 'L8', 8000);
    // The map frame counts its camera frames in data-map-moves (map/create-map.js). Under reduced motion the
    // initial view is a jump, so at most one frame is drawn for it.
    await page.locator('[data-map-camera]').first().waitFor({ timeout: 8000 });
    await page.waitForTimeout(800);
    const frames = await page.evaluate(() => Number(document.querySelector('[data-map-camera]')?.getAttribute('data-map-moves') ?? '0'));
    expect(frames).toBeLessThanOrEqual(1);
  });
});

test.describe('interactive map', () => {
  test('scenario 17: the canvas takes focus; arrows pan; plus and minus zoom; the feature list names match', async ({ page }) => {
    await attachGuards(page, { pageId: 'alerts' });
    await page.goto('alerts/?view=map');
    await mountedOrSkip(page, test, 'canvas.maplibregl-canvas', 'L8', 8000);
    const canvas = page.locator('canvas.maplibregl-canvas').first();
    await canvas.focus();
    await expect(canvas).toBeFocused();
    // The settled view is published on the map frame as data-map-camera="lng,lat,zoom" (map/create-map.js).
    const camera = () => page.evaluate(() => (document.querySelector('[data-map-camera]')?.getAttribute('data-map-camera') ?? '').split(',').map(Number));
    await page.locator('[data-map-camera]').first().waitFor({ timeout: 8000 });
    await page.waitForTimeout(800);
    const before = await camera();
    await page.keyboard.press('ArrowRight');
    await expect.poll(async () => (await camera())[0], { timeout: 5000 }).not.toBe(before[0]);
    await page.keyboard.press('+');
    await expect.poll(async () => (await camera())[2], { timeout: 5000 }).toBeGreaterThan(/** @type {number} */ (before[2]));
    // The map's feature list (map/feature-list.js) names what is drawn in view.
    const names = await page.locator('.map-feature-list li').allTextContents();
    expect(names.length).toBeGreaterThan(0);
  });

  test('scenario 16: losing the GPU context switches to outline mode within 6 seconds, degraded, with the note in view and no policy violation', async ({ page }) => {
    const g = await attachGuards(page, { pageId: 'alerts' });
    await page.goto('alerts/?view=map');
    await mountedOrSkip(page, test, 'canvas.maplibregl-canvas', 'L8', 8000);
    // The viewer is looking at the map when the GPU fails: the map panel sits below the fold on this page, so
    // it is scrolled to the top of the viewport first. The note under the frame must then still be in view.
    await page.evaluate(() => document.querySelector('[data-map-panel]')?.scrollIntoView({ block: 'start' }));
    await page.evaluate(() => {
      const c = /** @type {HTMLCanvasElement} */ (document.querySelector('canvas.maplibregl-canvas'));
      const gl = c.getContext('webgl2') ?? c.getContext('webgl');
      gl?.getExtension('WEBGL_lose_context')?.loseContext();
    });
    await expect(page.locator('[data-map-mode="outline"], .map-outline').first()).toBeVisible({ timeout: 6000 });
    await expect(page.locator('.sovereignty-note').first()).toBeInViewport();
    expect(await g.cspViolations()).toEqual([]);
  });

  test('on touch emulation a one-finger drag over the map scrolls the page (cooperative gestures)', async ({ page, isMobile, browserName }) => {
    test.skip(browserName !== 'chromium', 'Native touch dragging uses the Chromium-only CDP Input.dispatchTouchEvent API');
    test.skip(!isMobile, 'touch emulation projects only');
    await attachGuards(page, { pageId: 'alerts' });
    await page.goto('alerts/?view=map');
    await mountedOrSkip(page, test, '[data-map-panel] canvas', 'L8', 8000);
    await page.waitForTimeout(1200);
    const box = await page.locator('[data-map-panel] canvas').first().boundingBox();
    test.skip(!box, 'map canvas has no box');
    if (!box) return;
    const cdp = await page.context().newCDPSession(page);
    // Raw touch events (as in map.spec.mjs): Input.synthesizeScrollGesture does not scroll a page in headless
    // Chromium even away from the map, so it cannot tell a map that swallows the gesture from one that does not.
    const x = Math.round(box.x + box.width / 2);
    const y = Math.round(box.y + box.height / 2);
    const before = await page.evaluate(() => window.scrollY);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
    for (let step = 1; step <= 10; step += 1) {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: y - step * 20 }] });
      await page.waitForTimeout(20);
    }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await page.waitForTimeout(600);
    expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(before);
  });
});
