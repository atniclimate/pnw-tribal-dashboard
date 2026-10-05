// @ts-check
/**
 * Embed behavior (blueprint 1.4, 1.5). boot/flags.js has already marked <html> with data-embed,
 * data-framed, and data-panel-only before first paint; this module adds what needs script:
 *
 *   - the embed bar's page title and its "Open Full Page" link (the same URL without embed and panel);
 *   - in embed mode, links that leave the current page open in a new tab with rel="noopener", and links
 *     that stay on the page (views, filters, anchors) stay inside the frame and keep embed=1 when the page
 *     was opened with it; in every mode, links to other sites open in a new tab;
 *   - height messages to the host page when framed: { source: 'cthd', type: 'resize', page, height },
 *     target origin '*', height only, at most once per 250 ms, and only when the height changes;
 *   - single-panel embeds (panel=) only on the Dashboard and only for the six known panels.
 *
 * Every page imports this module through its entry module, and the module wires itself on import, so
 * embedding works on every page whether or not the page lane has called initEmbed yet. initEmbed is
 * idempotent. DOM module; it reads no storage and registers no service worker. It imports nothing, so it
 * adds no module to any page's preload list. Owner: lane L1.
 */

/** @typedef {import('../types.js').PageId} PageId */

/**
 * The `panel=` values of blueprint 1.4. A copy of DASHBOARD_PANELS in config/pages.js, kept here so this
 * module stays import-free; tests/unit/embed/core-embed.test.mjs fails if the two lists ever differ.
 */
export const EMBED_PANELS = Object.freeze(['banner', 'alerts', 'nation', 'rivers', 'contacts', 'map']);

export const RESIZE_INTERVAL_MS = 250;
const MESSAGE_SOURCE = 'cthd';

/**
 * True when html[data-embed] is set by boot/flags.js.
 * @returns {boolean}
 */
export function isEmbedMode() {
  return globalThis.document?.documentElement?.getAttribute('data-embed') === '1';
}

/**
 * @returns {boolean}
 */
export function isFramed() {
  const root = globalThis.document?.documentElement;
  if (root?.getAttribute('data-framed') === '1') return true;
  try { return globalThis.self !== globalThis.top; } catch { return true; }
}

/**
 * Decides what a link does inside an embed. Pure; exported for tests.
 *   'stay'     same page (same origin and path): stays in the frame, keeps embed=1
 *   'new-tab'  another page or another site: opens in a new tab
 *   'ignore'   tel:, mailto:, javascript:, and anything that is not http(s)
 * @param {string} href the link's resolved href
 * @param {string} current the page's URL
 * @returns {'stay' | 'new-tab' | 'ignore'}
 */
export function classifyLink(href, current) {
  let u;
  let c;
  try { u = new URL(href, current); c = new URL(current); } catch { return 'ignore'; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return 'ignore';
  if (u.origin === c.origin && u.pathname === c.pathname) return 'stay';
  return 'new-tab';
}

/**
 * The URL for "Open Full Page": the current URL without the embed and panel parameters or a hash.
 * Pure; exported for tests.
 * @param {string} current
 * @returns {string}
 */
export function fullPageUrl(current) {
  const u = new URL(current);
  u.searchParams.delete('embed');
  u.searchParams.delete('panel');
  u.hash = '';
  return u.toString();
}

/**
 * Adds embed=1 to a same-page URL when the page itself was opened with embed=1. Pure; exported for tests.
 * @param {string} href
 * @param {string} current
 * @returns {string}
 */
export function keepEmbedParam(href, current) {
  const c = new URL(current);
  const u = new URL(href, current);
  if (c.searchParams.get('embed') === '1' && !u.searchParams.has('embed')) u.searchParams.set('embed', '1');
  return u.toString();
}

/**
 * The panel= value to honor, or null. Pure; exported for tests.
 * @param {string | null} value html[data-panel-only]
 * @param {string} page
 * @returns {string | null}
 */
export function panelOnly(value, page) {
  if (!value || page !== 'dashboard') return null;
  return EMBED_PANELS.includes(value) ? value : null;
}

/**
 * The page's own content height, measured on <html> (no height: 100% anywhere, so this shrinks too).
 * @returns {number}
 */
function contentHeight() {
  const root = document.documentElement;
  return Math.ceil(Math.max(root.getBoundingClientRect().height, document.body?.getBoundingClientRect().height ?? 0));
}

/** @type {{ last: number, height: number, timer: ReturnType<typeof setTimeout> | null, page: string }} */
const resize = { last: 0, height: -1, timer: null, page: '' };

function sendHeight() {
  resize.timer = null;
  const height = contentHeight();
  if (height === resize.height) return;
  resize.height = height;
  resize.last = Date.now();
  try {
    globalThis.parent.postMessage({ source: MESSAGE_SOURCE, type: 'resize', page: resize.page, height }, '*');
  } catch { /* a detached frame has no parent to tell */ }
}

/**
 * Posts { source: 'cthd', type: 'resize', page, height } to the parent, at most once per 250 ms.
 * @param {PageId} page
 * @returns {void}
 */
export function postHeight(page) {
  if (!isFramed() || !globalThis.document) return;
  resize.page = page;
  if (resize.timer !== null) return;
  const wait = Math.max(0, resize.last + RESIZE_INTERVAL_MS - Date.now());
  resize.timer = setTimeout(sendHeight, wait);
}

/**
 * @param {HTMLAnchorElement} a
 */
function markNewTab(a) {
  a.target = '_blank';
  const rel = new Set((a.getAttribute('rel') ?? '').split(/\s+/).filter(Boolean));
  rel.add('noopener');
  a.setAttribute('rel', [...rel].join(' '));
}

/**
 * @param {HTMLAnchorElement} a
 */
function prepareLink(a) {
  const href = a.getAttribute('href');
  if (!href || href.startsWith('#') || a.hasAttribute('data-embed-open')) return;
  const kind = classifyLink(a.href, location.href);
  // Outside embed mode only links to other sites open a new tab; the dashboard's own pages navigate in place.
  if (!isEmbedMode()) {
    if (kind === 'new-tab' && new URL(a.href).origin !== location.origin) markNewTab(a);
    return;
  }
  if (kind === 'new-tab') markNewTab(a);
  else if (kind === 'stay' && !a.hasAttribute('download')) {
    const kept = keepEmbedParam(a.href, location.href);
    if (kept !== a.href) a.href = kept;
  }
}

/** @type {{ page: PageId | null, teardown: (() => void) | null }} */
const state = { page: null, teardown: null };

/**
 * Wires embed mode for the page; returns a teardown function. Idempotent: a second call for the same page
 * returns the first call's teardown.
 * @param {{ page: PageId }} opts
 * @returns {() => void}
 */
export function initEmbed(opts) {
  if (state.teardown && state.page === opts.page) return state.teardown;
  state.teardown?.();
  const root = document.documentElement;
  /** @type {(() => void)[]} */
  const undo = [];

  const wanted = panelOnly(root.getAttribute('data-panel-only'), opts.page);
  if (wanted === null) root.removeAttribute('data-panel-only');

  if (isEmbedMode()) {
    const titleSlot = document.querySelector('[data-embed-title]');
    if (titleSlot && !titleSlot.textContent?.trim()) titleSlot.textContent = (document.title.split(' | ')[0] ?? document.title).trim();
    const open = /** @type {HTMLAnchorElement | null} */ (document.querySelector('a[data-embed-open]'));
    if (open) { open.href = fullPageUrl(location.href); markNewTab(open); }
  }

  // Links: in every mode, links to other sites open a new tab with rel="noopener"; in embed mode, links to
  // the dashboard's other pages do too, and same-page links keep embed=1. Links added later are handled
  // when they are clicked.
  for (const a of document.querySelectorAll('a[href]')) prepareLink(/** @type {HTMLAnchorElement} */ (a));
  /** @param {MouseEvent} e */
  const onClick = (e) => {
    const t = /** @type {Element | null} */ (e.target instanceof Element ? e.target : null);
    const a = /** @type {HTMLAnchorElement | null} */ (t?.closest('a[href]') ?? null);
    if (a) prepareLink(a);
  };
  document.addEventListener('click', onClick, true);
  document.addEventListener('auxclick', onClick, true);
  undo.push(() => { document.removeEventListener('click', onClick, true); document.removeEventListener('auxclick', onClick, true); });

  if (isFramed()) {
    const ping = () => postHeight(opts.page);
    if (typeof ResizeObserver === 'function') {
      const ro = new ResizeObserver(ping);
      ro.observe(root);
      if (document.body) ro.observe(document.body);
      undo.push(() => ro.disconnect());
    }
    addEventListener('load', ping);
    undo.push(() => removeEventListener('load', ping));
    document.fonts?.ready.then(ping, () => {});
    ping();
  }

  const teardown = () => {
    for (const fn of undo.splice(0)) fn();
    if (resize.timer !== null) { clearTimeout(resize.timer); resize.timer = null; }
    if (state.teardown === teardown) { state.teardown = null; state.page = null; }
  };
  state.page = opts.page;
  state.teardown = teardown;
  return teardown;
}

/* Self-wiring on import (browser only): the page id comes from <body data-page>. */
if (globalThis.document?.body?.dataset.page) {
  initEmbed({ page: /** @type {PageId} */ (globalThis.document.body.dataset.page) });
}
