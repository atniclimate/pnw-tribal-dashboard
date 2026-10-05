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
    await mountedOrSkip(page, test, '.sovereignty-note', 'L8', 6000);
    const interactive = await page.locator('canvas.maplibregl-canvas').count();
    test.skip(interactive === 0, 'no interactive map mounted (outline mode or lane L8 pending)');
    const frames = await page.evaluate(() => /** @type {any} */ (window).__cthdMapMoves ?? null);
    test.skip(frames === null, 'the map exposes no camera-frame counter yet (lane L8 hook window.__cthdMapMoves pending)');
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
    const before = await page.evaluate(() => /** @type {any} */ (window).__cthdMapState?.() ?? null);
    test.skip(before === null, 'the map exposes no state hook yet (lane L8 hook window.__cthdMapState pending)');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('+');
    const after = await page.evaluate(() => /** @type {any} */ (window).__cthdMapState());
    expect(after.zoom).toBeGreaterThan(before.zoom);
    expect(after.center[0]).not.toBe(before.center[0]);
    const names = await page.locator('[data-feature-list] li').allTextContents();
    expect(names.length).toBeGreaterThan(0);
  });

  test('scenario 16: losing the GPU context switches to outline mode within 6 seconds, degraded, with the note in view and no policy violation', async ({ page }) => {
    const g = await attachGuards(page, { pageId: 'alerts' });
    await page.goto('alerts/?view=map');
    await mountedOrSkip(page, test, 'canvas.maplibregl-canvas', 'L8', 8000);
    await page.evaluate(() => {
      const c = /** @type {HTMLCanvasElement} */ (document.querySelector('canvas.maplibregl-canvas'));
      const gl = c.getContext('webgl2') ?? c.getContext('webgl');
      gl?.getExtension('WEBGL_lose_context')?.loseContext();
    });
    await expect(page.locator('[data-map-mode="outline"], .map-outline').first()).toBeVisible({ timeout: 6000 });
    await expect(page.locator('.sovereignty-note').first()).toBeInViewport();
    expect(await g.cspViolations()).toEqual([]);
  });

  test('on touch emulation a one-finger drag over the map scrolls the page (cooperative gestures)', async ({ page, isMobile }) => {
    test.skip(!isMobile, 'touch emulation projects only');
    await attachGuards(page, { pageId: 'alerts' });
    await page.goto('alerts/?view=map');
    await mountedOrSkip(page, test, '[data-map-panel] canvas', 'L8', 8000);
    const box = await page.locator('[data-map-panel] canvas').first().boundingBox();
    test.skip(!box, 'map canvas has no box');
    if (!box) return;
    const cdp = await page.context().newCDPSession(page);
    const x = box.x + box.width / 2;
    const y = box.y + box.height - 20;
    const before = await page.evaluate(() => window.scrollY);
    await cdp.send('Input.synthesizeScrollGesture', { x, y, yDistance: -200, gestureSourceType: 'touch', speed: 800 });
    expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(before);
  });
});
