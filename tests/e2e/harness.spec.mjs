// @ts-check
/// <reference lib="dom" />
/**
 * Core runtime in a real browser (lane L2): mountPanel always renders a provenance footer (blueprint 3.3,
 * 12.3), h() keeps data inert, safeUrl blocks script schemes, and Intl-backed time helpers give the house
 * format. The harness page lives in dev/ (never deployed), which the site server does not serve, so this
 * spec runs its own static server for site/ plus dev/ on an ephemeral port.
 */
import { expect, test } from '@playwright/test';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BASE, MIME, resolvePath } from '../../scripts/dev/serve.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** @type {import('node:http').Server} */
let server;
let origin = '';

test.beforeAll(async () => {
  server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const decoded = decodeURIComponent(url.pathname);
    let file = null;
    if (decoded.startsWith(`${BASE}dev/`)) {
      const candidate = path.resolve(ROOT, 'dev', decoded.slice(`${BASE}dev/`.length));
      if (candidate.startsWith(path.join(ROOT, 'dev') + path.sep)) file = candidate;
    } else if (decoded.startsWith(BASE)) {
      const found = await resolvePath(decoded);
      if (found && 'file' in found) file = found.file;
    }
    const body = file ? await readFile(file).catch(() => null) : null;
    if (!file || !body) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(body);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)));
  const addr = /** @type {import('node:net').AddressInfo} */ (server.address());
  origin = `http://127.0.0.1:${addr.port}`;
});

test.afterAll(async () => {
  await new Promise((resolve) => server.close(() => resolve(undefined)));
});

/** @param {import('@playwright/test').Page} page */
async function open(page) {
  /** @type {string[]} */
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(`${origin}${BASE}dev/harness.html`);
  await page.waitForFunction(() => /** @type {any} */ (window).harnessReady === true);
  return errors;
}

test.describe('mountPanel always renders a provenance footer', () => {
  test('the footer exists before the first load completes, and names the source', async ({ page }) => {
    await open(page);
    await page.evaluate(() => {
      const h = /** @type {any} */ (window).harness;
      h.mountPanel(document.querySelector('[data-panel="harness-a"]'), {
        title: 'Harness Panel A', sourceIds: ['harness-source'], statusId: 'e2e-a', load: () => new Promise(() => {}), render() {},
      });
    });
    const panel = page.locator('[data-panel="harness-a"]');
    await expect(panel.locator('[data-provenance]')).toHaveAttribute('data-status', 'loading');
    await expect(panel.locator('.panel__body')).toHaveText('Loading Harness Agency');
    await expect(panel.locator('.provenance a')).toHaveAttribute('href', 'https://www.weather.gov/');
  });

  test('after a load: pill, linked source, stamp with its verb and zone abbreviation, checked age', async ({ page }) => {
    const errors = await open(page);
    await page.evaluate(() => {
      const h = /** @type {any} */ (window).harness;
      h.mountPanel(document.querySelector('[data-panel="harness-a"]'), {
        title: 'Harness Panel A', sourceIds: ['harness-source'], statusId: 'e2e-a',
        load: async () => ({
          data: 'Harness body',
          status: { state: 'live', asOf: new Date(Date.now() - 120_000).toISOString(), asOfBasis: 'observed', sourceIds: ['harness-source'], origin: 'direct', completeness: 'complete', checkedAt: new Date().toISOString() },
        }),
        render(/** @type {any} */ body, /** @type {any} */ data) { body.append(h.h('p', {}, data)); },
      });
    });
    const panel = page.locator('[data-panel="harness-a"]');
    await expect(panel.locator('.panel__body')).toHaveText('Harness body');
    const footer = panel.locator('[data-provenance]');
    await expect(footer).toHaveAttribute('data-status', 'live');
    await expect(footer.locator('.status-pill')).toHaveText('Live');
    await expect(footer.locator('.status-pill svg')).toHaveCount(1);
    await expect(footer.locator('.provenance__asof')).toHaveText(/^Observed as of \d{2}\/\d{2}\/\d{4} \d{1,2}:\d{2} [AP]M [A-Z]{2,5}$/);
    await expect(footer.locator('.provenance__checked')).toHaveText(/^Checked (just now|\d+ min ago)$/);
    expect(errors).toEqual([]);
  });

  test('a throwing loader and a throwing renderer both still leave a footer', async ({ page }) => {
    await open(page);
    await page.evaluate(() => {
      const h = /** @type {any} */ (window).harness;
      h.mountPanel(document.querySelector('[data-panel="harness-a"]'), {
        title: 'A', sourceIds: ['harness-source'], statusId: 'e2e-a', load: async () => { throw new Error('boom'); }, render() {},
      });
      h.mountPanel(document.querySelector('[data-panel="harness-b"]'), {
        title: 'B', sourceIds: ['harness-source', 'harness-other'], statusId: 'e2e-b',
        load: async () => ({ data: 1, status: { state: 'live', asOf: new Date().toISOString(), asOfBasis: 'issued', sourceIds: ['harness-source', 'harness-other'], origin: 'direct', completeness: 'complete', checkedAt: new Date().toISOString() } }),
        render() { throw new Error('bad render'); },
      });
    });
    const a = page.locator('[data-panel="harness-a"]');
    await expect(a.locator('[data-provenance]')).toHaveAttribute('data-status', 'unavailable');
    await expect(a.locator('.panel__body')).toContainText('could not be loaded');
    const b = page.locator('[data-panel="harness-b"]');
    await expect(b.locator('[data-provenance]')).toHaveAttribute('data-status', 'degraded');
    await expect(b.locator('.provenance__src')).toHaveText('Sources: Harness Agency, Other Harness Agency');
    await expect(b.locator('.panel__body')).toContainText('could not be displayed');
  });

  test('a superseded load never paints', async ({ page }) => {
    await open(page);
    const painted = await page.evaluate(async () => {
      const h = /** @type {any} */ (window).harness;
      const mk = (/** @type {string} */ label) => ({ data: label, status: { state: 'live', asOf: new Date().toISOString(), asOfBasis: 'issued', sourceIds: ['harness-source'], origin: 'direct', completeness: 'complete', checkedAt: new Date().toISOString() } });
      /** @type {Array<(v: any) => void>} */
      const resolvers = [];
      /** @type {string[]} */
      const seen = [];
      const handle = h.mountPanel(document.querySelector('[data-panel="harness-a"]'), {
        title: 'A', sourceIds: ['harness-source'], statusId: 'e2e-a', load: () => new Promise((r) => { resolvers.push(r); }),
        render(/** @type {HTMLElement} */ _b, /** @type {string} */ d) { seen.push(d); },
      });
      const second = handle.refresh();
      resolvers[1]?.(mk('second'));
      await second;
      resolvers[0]?.(mk('first, superseded'));
      await new Promise((r) => setTimeout(r, 50));
      return seen;
    });
    expect(painted).toEqual(['second']);
  });

  test('phone width: the panel and footer do not scroll the page sideways', async ({ page }) => {
    await open(page);
    await page.evaluate(() => {
      const h = /** @type {any} */ (window).harness;
      h.mountPanel(document.querySelector('[data-panel="harness-b"]'), {
        title: 'B', sourceIds: ['harness-source', 'harness-other'], statusId: 'e2e-b',
        load: async () => ({ data: 'x', status: { state: 'degraded', asOf: new Date().toISOString(), asOfBasis: 'issued', sourceIds: ['harness-source', 'harness-other'], origin: 'snapshot', completeness: 'partial', checkedAt: new Date().toISOString(), detail: 'Direct request failed (timed out after 12 s); showing the scheduled copy' } }),
        render(/** @type {any} */ b, /** @type {any} */ d) { b.append(h.h('p', {}, d)); },
      });
    });
    await expect(page.locator('[data-panel="harness-b"] .provenance__detail')).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
  });
});

test.describe('DOM helpers in a real browser', () => {
  test('h() keeps data inert: markup is text and nothing runs', async ({ page }) => {
    await open(page);
    const result = await page.evaluate(() => {
      const { h } = /** @type {any} */ (window).harness;
      const payload = '<img src=x onerror="window.__pwned=1"><script>window.__pwned=2</script>';
      const el = h('p', {}, payload);
      document.getElementById('sandbox')?.append(el);
      return { text: el.textContent, imgs: el.querySelectorAll('img').length, scripts: el.querySelectorAll('script').length, children: el.childNodes.length };
    });
    await page.waitForTimeout(100);
    expect(result.imgs).toBe(0);
    expect(result.scripts).toBe(0);
    expect(result.children).toBe(1);
    expect(result.text).toContain('<img src=x');
    expect(await page.evaluate(() => /** @type {any} */ (window).__pwned)).toBeUndefined();
  });

  test('h() rejects on* attributes and drops unsafe href; clicking a dropped link runs nothing', async ({ page }) => {
    await open(page);
    const r = await page.evaluate(() => {
      const { h } = /** @type {any} */ (window).harness;
      let threw = '';
      try { h('button', { onclick: 'window.__pwned=3' }, 'x'); } catch (e) { threw = String(e); }
      const link = h('a', { href: 'javascript:window.__pwned=4' }, 'unsafe');
      const data = h('a', { href: 'data:text/html,<script>window.__pwned=5</script>' }, 'data');
      const ok = h('a', { href: 'https://www.weather.gov/' }, 'safe');
      document.getElementById('sandbox')?.append(link, data, ok);
      link.click();
      data.click();
      return { threw, linkHref: link.getAttribute('href'), dataHref: data.getAttribute('href'), okHref: ok.getAttribute('href') };
    });
    expect(r.threw).toMatch(/event handler/);
    expect(r.linkHref).toBeNull();
    expect(r.dataHref).toBeNull();
    expect(r.okHref).toBe('https://www.weather.gov/');
    expect(await page.evaluate(() => /** @type {any} */ (window).__pwned)).toBeUndefined();
  });

  test('safeUrl blocks javascript:, data:, and vbscript:', async ({ page }) => {
    await open(page);
    const out = await page.evaluate(() => {
      const { safeUrl } = /** @type {any} */ (window).harness;
      return ['javascript:alert(1)', 'java\tscript:alert(1)', 'data:text/html,x', 'vbscript:x', 'https://www.weather.gov/', '/alerts/'].map((u) => safeUrl(u));
    });
    expect(out).toEqual(['', '', '', '', 'https://www.weather.gov/', '/alerts/']);
  });

  test('on() delegates clicks by data-action in a real browser', async ({ page }) => {
    await open(page);
    const hits = await page.evaluate(() => {
      const { h, on } = /** @type {any} */ (window).harness;
      const inner = h('span', {}, 'x');
      const btn = h('button', { 'data-action': 'save' }, inner);
      const root = h('div', {}, btn);
      document.getElementById('sandbox')?.append(root);
      /** @type {(string | null)[]} */
      const log = [];
      const off = on(root, 'save', (/** @type {Event} */ _e, /** @type {HTMLElement} */ t) => log.push(t.getAttribute('data-action')));
      inner.click();
      off();
      inner.click();
      return log;
    });
    expect(hits).toEqual(['save']);
  });
});

test.describe('time and URL helpers in a real browser', () => {
  test('formatAsOf returns "10/04/2026 3:15 PM PDT"', async ({ page }) => {
    await open(page);
    const s = await page.evaluate(() => /** @type {any} */ (window).harness.formatAsOf('2026-10-04T22:15:00Z', 'America/Los_Angeles'));
    expect(s).toBe('10/04/2026 3:15 PM PDT');
  });

  test('zoned day keys differ from the viewer zone and survive the fall-back day', async ({ page }) => {
    await open(page);
    const r = await page.evaluate(() => {
      const { zonedDayKey, splitByZonedDay } = /** @type {any} */ (window).harness;
      const t = new Date('2026-11-01T06:30:00Z');
      const start = new Date('2026-11-01T07:00:00Z');
      const split = splitByZonedDay(start, new Date(start.getTime() + 48 * 3_600_000), 48, 'America/Los_Angeles');
      return { la: zonedDayKey(t, 'America/Los_Angeles'), ny: zonedDayKey(t, 'America/New_York'), day1: split.get('2026-11-01'), day2: split.get('2026-11-02') };
    });
    expect(r).toEqual({ la: '2026-10-31', ny: '2026-11-01', day1: 25, day2: 23 });
  });

  test('URL state round-trips, preserves unknown keys and embed, and writes with replaceState', async ({ page }) => {
    await open(page);
    await page.goto(`${origin}${BASE}dev/harness.html?embed=1&utm_source=sms&view=list`);
    await page.waitForFunction(() => /** @type {any} */ (window).harnessReady === true);
    const r = await page.evaluate(() => {
      const { writeState, readState } = /** @type {any} */ (window).harness;
      const schema = { view: { type: 'enum', values: ['list', 'map'] }, embed: { type: 'flag' }, n: { type: 'nation-id' } };
      const before = history.length;
      writeState({ view: 'map', n: 'us-wa-lummi-nation' });
      return { search: location.search, state: readState(schema), pushed: history.length - before };
    });
    expect(r.search).toBe('?embed=1&n=us-wa-lummi-nation&utm_source=sms&view=map');
    expect(r.state).toEqual({ view: 'map', embed: true, n: 'us-wa-lummi-nation' });
    expect(r.pushed).toBe(0);
  });
});
