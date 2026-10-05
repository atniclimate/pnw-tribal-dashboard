// @ts-check
/**
 * Shared end-to-end harness (blueprint 10.1 to 10.3). Owner: lane L15. Not a spec: Playwright's testMatch
 * ignores it. Provides:
 *
 *   loadRoutes()          tests/fixtures/routes.json
 *   registryHosts(page)   hosts the registry allows for a page id (site/data/curated/sources.json)
 *   attachGuards(page, o) host guard (a request to an unlisted host fails the test), console and page error
 *                         capture, securitypolicyviolation capture, and upstream mocking or aborting
 *   horizontalOverflow    true when the document scrolls sideways
 *   provenanceProblems    blueprint 10.3 check 2, per panel
 *   axeProblems           serious and critical axe violations
 *   mountedOrSkip         skips a test, with the owning lane named, when the page has not been built yet
 *
 * Mocked mode never reaches the network: an allowed external request is fulfilled by a handler passed in
 * `mocks` (host to handler) or aborted, which is how "all upstreams down" is expressed (`down: true`).
 */
import { readFile } from 'node:fs/promises';
import { AxeBuilder } from '@axe-core/playwright';

const root = new URL('../../../', import.meta.url);

/** @typedef {{ id: string, path: string, page: string, nav: string | null, views: string[], status?: number }} Route */

/** @returns {Promise<{ alwaysAllowedHosts: string[], extraHosts: Record<string, string[]>, viewports: Record<string, { width: number, height: number }>, routes: Route[], deepLinks: any[], nearMePositions: any[] }>} */
export async function loadRoutes() {
  return JSON.parse(await readFile(new URL('tests/fixtures/routes.json', root), 'utf8'));
}

/** @param {string} url @returns {string | null} */
function hostOfTemplate(url) {
  const m = /^https?:\/\/([^/?#]+)/i.exec(url);
  return m ? (m[1] ?? '').replace(/\{[^}]*\}/g, '*').toLowerCase() : null;
}

/** @param {string} pattern host with optional leading `*.` @param {string} host */
function hostMatches(pattern, host) {
  if (pattern === host) return true;
  if (pattern.includes('*')) return new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^.]+')}$`).test(host);
  return false;
}

/**
 * Hosts the registry allows a page to reach.
 * @param {string} pageId
 * @returns {Promise<string[]>}
 */
export async function registryHosts(pageId) {
  /** @type {any} */
  let doc;
  try { doc = JSON.parse(await readFile(new URL('site/data/curated/sources.json', root), 'utf8')); } catch { return []; }
  /** @type {Set<string>} */
  const hosts = new Set();
  for (const s of doc.items ?? []) {
    if (!s.usedBy?.includes(pageId)) continue;
    if (!['direct', 'direct+snapshot', 'image', 'tiles', 'video'].includes(s.access?.mode)) continue;
    const h = hostOfTemplate(s.urlTemplate ?? s.url);
    if (h) hosts.add(h);
  }
  return [...hosts];
}

/**
 * @typedef {{ pageId: string, down?: boolean, mocks?: Record<string, (route: import('@playwright/test').Route) => Promise<void> | void> }} GuardOptions
 * @typedef {{
 *   consoleErrors: string[], pageErrors: string[], blockedHosts: string[], requests: { url: string, host: string, bytes: number | null, type: string, status: number, at: number }[],
 *   cspViolations: () => Promise<string[]>,
 * }} Guards
 */

/**
 * Install the guards before the first navigation.
 * @param {import('@playwright/test').Page} page
 * @param {GuardOptions} opts
 * @returns {Promise<Guards>}
 */
export async function attachGuards(page, opts) {
  const routes = await loadRoutes();
  const allowed = [...(await registryHosts(opts.pageId)), ...(routes.extraHosts[opts.pageId] ?? [])];
  /** @type {Guards} */
  const g = { consoleErrors: [], pageErrors: [], blockedHosts: [], requests: [], cspViolations: async () => [] };
  page.on('console', (m) => { if (m.type() === 'error') g.consoleErrors.push(m.text()); });
  page.on('pageerror', (e) => g.pageErrors.push(e.message));
  await page.addInitScript(() => {
    /** @type {any} */ (window).__cspViolations = [];
    document.addEventListener('securitypolicyviolation', (e) => /** @type {any} */ (window).__cspViolations.push(`${e.violatedDirective} ${e.blockedURI}`));
  });
  g.cspViolations = async () => page.evaluate(() => /** @type {any} */ (window).__cspViolations ?? []).catch(() => []);
  const t0 = Date.now();
  page.on('response', async (r) => {
    const u = new URL(r.url());
    if (u.protocol === 'data:') return;
    const len = r.headers()['content-length'];
    g.requests.push({ url: r.url(), host: u.hostname, bytes: len ? Number(len) : null, type: r.headers()['content-type'] ?? '', status: r.status(), at: Date.now() - t0 });
  });
  await page.route('**/*', async (route) => {
    const u = new URL(route.request().url());
    if (u.protocol === 'data:' || u.protocol === 'blob:') return route.continue();
    if (routes.alwaysAllowedHosts.includes(u.hostname)) return route.continue();
    if (!allowed.some((p) => hostMatches(p, u.hostname))) { g.blockedHosts.push(u.hostname); return route.abort('blockedbyclient'); }
    if (opts.down) return route.abort('internetdisconnected');
    const handler = Object.entries(opts.mocks ?? {}).find(([p]) => hostMatches(p, u.hostname))?.[1];
    if (handler) return handler(route);
    return route.abort('failed');
  });
  return g;
}

/** @param {import('@playwright/test').Page} page */
export async function horizontalOverflow(page) {
  return page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
}

/**
 * Blueprint 10.3 check 2: every [data-panel] contains [data-provenance] whose data-source-ids exist in the
 * registry and that has a time[datetime], or data-status="unavailable" with a reason.
 * @param {import('@playwright/test').Page} page
 * @param {Set<string>} registered
 * @returns {Promise<string[]>}
 */
export async function provenanceProblems(page, registered) {
  const panels = await page.evaluate(() => [...document.querySelectorAll('[data-panel]')].map((p) => {
    const f = p.querySelector('[data-provenance]');
    return {
      panel: p.getAttribute('data-panel') ?? '',
      hasFooter: Boolean(f),
      ids: (f?.getAttribute('data-source-ids') ?? '').split(/\s+/).filter(Boolean),
      hasTime: Boolean(f?.querySelector('time[datetime]')),
      status: f?.getAttribute('data-status') ?? '',
      text: (f?.textContent ?? '').trim(),
    };
  }));
  /** @type {string[]} */
  const out = [];
  for (const p of panels) {
    if (!p.hasFooter || !p.text) { out.push(`${p.panel}: empty or missing provenance footer`); continue; }
    if (!p.ids.length) out.push(`${p.panel}: provenance has no data-source-ids`);
    for (const id of p.ids) if (!registered.has(id)) out.push(`${p.panel}: source id ${id} is not in sources.json`);
    if (!p.hasTime && !(p.status === 'unavailable' && p.text.length > 'Unavailable'.length)) out.push(`${p.panel}: provenance has neither time[datetime] nor an unavailable reason`);
  }
  return out;
}

/** @returns {Promise<Set<string>>} registered ids from the compiled sources file */
export async function registeredSourceIds() {
  try {
    const doc = JSON.parse(await readFile(new URL('site/data/curated/sources.json', root), 'utf8'));
    return new Set((doc.items ?? []).map((/** @type {any} */ i) => String(i.id)));
  } catch { return new Set(); }
}

/**
 * Serious and critical axe violations, one line each.
 * @param {import('@playwright/test').Page} page
 * @returns {Promise<string[]>}
 */
export async function axeProblems(page) {
  const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze();
  return r.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => `${v.id} (${v.impact}): ${v.nodes.length} node(s), first ${v.nodes[0]?.target.join(' ')}`);
}

/**
 * The lane that builds each page's <main> and entry module, for skip reasons that name the owner.
 * @type {Record<string, string>}
 */
export const PAGE_LANES = {
  dashboard: 'L10, Wave 3', alerts: 'L11, Wave 2', forecasts: 'L12, Wave 2',
  contacts: 'L13, Wave 2', resources: 'L13, Wave 2', safety: 'L13, Wave 2', usage: 'L13, Wave 2',
  news: 'L14, Wave 2', archive: 'L14, Wave 2', 'archive-event': 'L14, Wave 2', embed: 'L14, Wave 2',
};

/**
 * Skip a test, naming the lane, when a selector the lane delivers is absent. Returns whether it is present.
 * @param {import('@playwright/test').Page} page
 * @param {import('@playwright/test').TestType<any, any>} test
 * @param {string} selector
 * @param {string} lane
 * @param {number} [timeout]
 */
export async function mountedOrSkip(page, test, selector, lane, timeout = 4000) {
  const present = await page.locator(selector).first().waitFor({ timeout }).then(() => true, () => false);
  test.skip(!present, `${selector} is not present yet (lane ${lane} pending)`);
  return present;
}

/** @param {import('@playwright/test').Page} page whether any stylesheet applied (lane L1 delivers the CSS) */
export async function stylesApplied(page) {
  return page.evaluate(() => [...document.styleSheets].some((s) => { try { return s.cssRules.length > 0; } catch { return true; } }));
}

/** Panel digits outside <time>: scenario 1 forbids a digit in a panel body. */
export const OBSERVATION_PATTERN = /\d\s?(?:in|mm|ft|m|cfs|°\s?[FC]|percent|%|mph|km\/h)\b/i;
