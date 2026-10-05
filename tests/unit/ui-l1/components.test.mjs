// @ts-check
/**
 * Lane L1 UI modules, the parts that run without a DOM: every L1 module imports cleanly in Node, the five
 * status shapes are distinct and each has a word, and the bottom bar's current-item rule. DOM behavior
 * (tabs keyboard flow, disclosure, toast, live region, pills in place) is exercised in a browser against
 * dev/gallery.html by the lane's Playwright verification. Owner: lane L1.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { itemMatches } from '../../../site/static/js/ui/bottom-bar.js';
import { STATUS_LABELS, STATUS_SHAPES } from '../../../site/static/js/ui/status-pill.js';

describe('L1 UI modules', () => {
  test('every module imports in Node without touching the DOM', async () => {
    for (const m of ['chrome', 'tabs', 'disclosure', 'toast', 'live-region', 'status-pill', 'bottom-bar']) {
      await assert.doesNotReject(import(`../../../site/static/js/ui/${m}.js`), m);
    }
  });

  test('five statuses, five distinct shapes, five words (shape plus word, never color alone)', () => {
    const states = Object.keys(STATUS_SHAPES);
    assert.deepEqual(states.sort(), ['cached', 'degraded', 'live', 'stale', 'unavailable']);
    const signatures = states.map((s) => JSON.stringify(STATUS_SHAPES[/** @type {keyof typeof STATUS_SHAPES} */ (s)]));
    assert.equal(new Set(signatures).size, 5);
    for (const s of states) assert.ok(STATUS_LABELS[/** @type {keyof typeof STATUS_LABELS} */ (s)].length > 0);
  });

  test('bottom bar marks the item for the current page and view', () => {
    const base = 'https://atniclimate.github.io/pnw-tribal-dashboard/';
    assert.equal(itemMatches(`${base}alerts/`, `${base}alerts/`), true);
    assert.equal(itemMatches(`${base}alerts/`, `${base}alerts/?n=ca-fn-602`), true);
    assert.equal(itemMatches(`${base}forecasts/?view=rivers`, `${base}forecasts/?view=rivers`), true);
    assert.equal(itemMatches(`${base}forecasts/?view=rivers`, `${base}forecasts/`), false);
    assert.equal(itemMatches(`${base}contacts/?view=near-me`, `${base}contacts/`), false);
    assert.equal(itemMatches(`${base}contacts/`, `${base}contacts/?view=near-me`), false);
  });
});
