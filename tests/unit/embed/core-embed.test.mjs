// @ts-check
/**
 * core/embed.js decisions (blueprint 1.4) and the embed rules in layout.css. The DOM behavior (framed
 * default, resize messages, new-tab links, panel=) is exercised in a browser by the lane's Playwright
 * verification; these tests pin the pure decisions and the stylesheet's promise that embed mode hides
 * only chrome. Owner: lane L1.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { DASHBOARD_PANELS } from '../../../site/static/js/config/pages.js';
import {
  EMBED_PANELS, RESIZE_INTERVAL_MS, classifyLink, fullPageUrl, isEmbedMode, keepEmbedParam, panelOnly, postHeight,
} from '../../../site/static/js/core/embed.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const PAGE = 'https://atniclimate.github.io/pnw-tribal-dashboard/alerts/?embed=1&n=us-wa-lummi';

describe('core/embed.js decisions', () => {
  test('imports in Node without a DOM and does nothing there', () => {
    assert.equal(isEmbedMode(), false);
    assert.doesNotThrow(() => postHeight('alerts'));
    assert.equal(RESIZE_INTERVAL_MS, 250);
  });

  test('links to another page or site open in a new tab; same-page links stay; tel and mailto are left alone', () => {
    assert.equal(classifyLink('https://atniclimate.github.io/pnw-tribal-dashboard/contacts/', PAGE), 'new-tab');
    assert.equal(classifyLink('https://www.weather.gov/', PAGE), 'new-tab');
    assert.equal(classifyLink('https://atniclimate.github.io/pnw-tribal-dashboard/alerts/?view=map', PAGE), 'stay');
    assert.equal(classifyLink('https://atniclimate.github.io/pnw-tribal-dashboard/alerts/#list', PAGE), 'stay');
    assert.equal(classifyLink('tel:911', PAGE), 'ignore');
    assert.equal(classifyLink('mailto:climate@atnitribes.org', PAGE), 'ignore');
    assert.equal(classifyLink('javascript:void(0)', PAGE), 'ignore');
  });

  test('view and filter links keep embed=1 only when the page was opened with it', () => {
    assert.equal(keepEmbedParam('?view=map', PAGE), 'https://atniclimate.github.io/pnw-tribal-dashboard/alerts/?view=map&embed=1');
    assert.equal(keepEmbedParam('?view=map&embed=0', PAGE), 'https://atniclimate.github.io/pnw-tribal-dashboard/alerts/?view=map&embed=0');
    const framedDefault = 'https://atniclimate.github.io/pnw-tribal-dashboard/alerts/';
    assert.equal(keepEmbedParam('?view=map', framedDefault), 'https://atniclimate.github.io/pnw-tribal-dashboard/alerts/?view=map');
  });

  test('"Open Full Page" drops embed, panel, and the hash and keeps everything else', () => {
    assert.equal(fullPageUrl('https://atniclimate.github.io/pnw-tribal-dashboard/?embed=1&panel=banner&n=ca-fn-602#map'),
      'https://atniclimate.github.io/pnw-tribal-dashboard/?n=ca-fn-602');
  });

  test('the import-free panel list matches config/pages.js DASHBOARD_PANELS', () => {
    assert.deepEqual([...EMBED_PANELS], [...DASHBOARD_PANELS]);
  });

  test('panel= is honored only on the Dashboard and only for the six known panels', () => {
    for (const p of ['banner', 'alerts', 'nation', 'rivers', 'contacts', 'map']) assert.equal(panelOnly(p, 'dashboard'), p);
    assert.equal(panelOnly('banner', 'alerts'), null);
    assert.equal(panelOnly('bogus', 'dashboard'), null);
    assert.equal(panelOnly(null, 'dashboard'), null);
  });
});

describe('layout.css embed rules', async () => {
  const css = (await readFile(path.join(ROOT, 'site', 'static', 'css', 'layout.css'), 'utf8')).replace(/\/\*[\s\S]*?\*\//g, '');
  /** Selectors of every rule that sets display: none under html[data-embed='1']. */
  const hidden = [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)]
    .filter((m) => /display:\s*none/.test(m[2] ?? '') && /data-embed='1'/.test(m[1] ?? ''))
    .flatMap((m) => (m[1] ?? '').split(',').map((s) => s.trim()));

  test('embed mode hides the header, primary nav, bottom bar, and footer extras', () => {
    for (const sel of ['.site-header', '.site-nav', '.bottom-bar', '.site-footer__links', '.site-footer__credit']) {
      assert.ok(hidden.some((h) => h.endsWith(sel)), `${sel} hidden in embed mode`);
    }
    assert.match(css, /html\[data-embed='1'\] \[data-embed-only\] \{ display: flex; \}/);
  });

  test('embed mode never hides provenance, status, the banner, the selector, the sovereignty note, or the 911 line', () => {
    for (const keep of ['provenance', 'data-provenance', 'status-pill', 'alert-banner', 'nation-picker', 'sovereignty', 'site-footer__safety', 'data-panel', 'site-footer {']) {
      assert.ok(!hidden.some((h) => h.includes(keep)), `${keep} is never hidden by an embed rule`);
    }
  });
});
