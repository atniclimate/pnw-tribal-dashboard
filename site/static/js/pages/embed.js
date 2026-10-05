// @ts-check
/**
 * Embed generator (blueprint 1.5, 7.10): builds copy-and-paste iframe code for a Squarespace Code Block (or any
 * page that accepts HTML), one snippet per page and view, with a live preview. This page is the reference:
 * there is no separate embedding document, and the "All Snippets" table is built by the same function
 * (`buildSnippet`) as the generator output, so the two cannot differ (tests/unit/news/embed-snippets.test.mjs
 * and tests/e2e/pages/embed.spec.mjs check it).
 *
 * Snippets point at the published address (https://atniclimate.github.io/pnw-tribal-dashboard/). The preview
 * loads the same page from this copy of the site, with the same query string, so it works wherever this page is
 * served. Everything is built with h() and textContent; the snippet is shown in a read-only text area and never
 * inserted as HTML.
 *
 * Entry module, loaded by <script type="module">; its static imports are listed in the page's modulepreload
 * block (check:preload). Pure helpers are exported for tests. Owner: lane L14.
 */
import { initChrome } from '../ui/chrome.js';
import { initEmbed } from '../core/embed.js';
import { clear, h } from '../core/dom.js';
import { DASHBOARD_PANELS, PAGES, PRODUCT_NAME } from '../config/pages.js';
import { NATION_ID_PATTERN } from '../data/ids.js';
import { fetchLocal } from '../core/net.js';
import { createLiveRegion } from '../ui/live-region.js';

/** @typedef {import('../types.js').PageConfig} PageConfig */
/** @typedef {import('../types.js').PageId} PageId */

/**
 * @typedef {object} SnippetOptions
 * @property {string} page page id (an embeddable page of config/pages.js)
 * @property {string} [view] one of the page's views
 * @property {string} [panel] Dashboard only: banner, alerts, nation, rivers, contacts, or map
 * @property {string} [n] Nation id, for pages that take one
 * @property {number} [height] pixels
 * @property {boolean} [geolocation] adds allow="geolocation"
 * @property {boolean} [autoHeight] adds the host helper script (default true)
 * @property {boolean} [lazy] loading="lazy" instead of "eager"
 */

/**
 * @typedef {object} Snippet
 * @property {string} src the published address
 * @property {string} query the query string, with its leading "?"
 * @property {string} path the page's path under the site root
 * @property {string} title
 * @property {number} height
 * @property {boolean} autoHeight whether the helper script line is included
 * @property {string} code the full snippet, ASCII only
 * @property {string[]} notes plain-language notes about options that were ignored or adjusted
 */

export const PUBLISHED_BASE = 'https://atniclimate.github.io/pnw-tribal-dashboard/';
export const EMBED_SCRIPT_URL = `${PUBLISHED_BASE}embed.js`;
/** Lowest and highest height the generator writes; the host helper clamps live resizing to 320 to 6000. */
export const HEIGHT_MIN = 96;
export const HEIGHT_MAX = 6000;
/** Pages whose address takes `n=<Nation id>` (blueprint 1.2 page parameters). */
export const NATION_PAGES = Object.freeze(['dashboard', 'alerts', 'forecasts', 'contacts', 'resources']);
/** Starting heights for single-panel Dashboard embeds; `banner` is the blueprint's 96 px header strip. */
export const PANEL_HEIGHTS = Object.freeze(/** @type {Record<string, number>} */ ({
  banner: 96, alerts: 700, nation: 600, rivers: 700, contacts: 800, map: 640,
}));
const TITLE_OVERRIDES = Object.freeze(/** @type {Record<string, string>} */ ({ dashboard: 'Overview', alerts: 'Active Alerts' }));
export const VIEW_LABELS = Object.freeze(/** @type {Record<string, string>} */ ({
  list: 'List', map: 'Map', declarations: 'Declarations', local: 'Local Forecast', precip: 'Precipitation', ar: 'Atmospheric Rivers',
  satellite: 'Satellite', radar: 'Radar', rivers: 'Rivers', directory: 'Directory', 'near-me': 'Near Me', usage: 'Usage',
  sources: 'Sources', status: 'Status', privacy: 'Privacy', accessibility: 'Accessibility',
}));
export const PANEL_LABELS = Object.freeze(/** @type {Record<string, string>} */ ({
  banner: 'Header Strip', alerts: 'Alerts Panel', nation: 'Nation Panel', rivers: 'Rivers Panel', contacts: 'Contacts Panel', map: 'Map Panel',
}));

/** @returns {readonly PageConfig[]} the pages that may be embedded, in navigation order */
export const embeddablePages = () => PAGES.filter((p) => p.embeddable);

/**
 * Escape text for a double-quoted HTML attribute. The generator only ever writes values from fixed lists,
 * validated ids, and integers, but the escape keeps that true if a label ever gains punctuation.
 * @param {string} s
 * @returns {string}
 */
export function attr(s) {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * The snippet for one set of options. Pure.
 * @param {SnippetOptions} o
 * @returns {Snippet}
 * @throws {Error} when the page is unknown or not embeddable
 */
export function buildSnippet(o) {
  const page = PAGES.find((p) => p.id === o.page);
  if (!page || !page.embeddable) throw new Error(`"${o.page}" is not an embeddable page`);
  /** @type {string[]} */
  const notes = [];

  /** @type {string | null} */
  let view = null;
  if (o.view) {
    if (page.views.includes(o.view)) view = o.view;
    else notes.push(`The ${page.title} page has no "${o.view}" view, so the view was left out.`);
  }
  /** @type {string | null} */
  let panel = null;
  if (o.panel) {
    if (page.id !== 'dashboard') notes.push('Single-panel embeds exist only for the Dashboard, so the panel was left out.');
    else if (!DASHBOARD_PANELS.includes(o.panel)) notes.push(`"${o.panel}" is not a Dashboard panel, so the panel was left out.`);
    else panel = o.panel;
  }
  /** @type {string | null} */
  let nation = null;
  if (o.n) {
    if (!NATION_PAGES.includes(page.id)) notes.push(`The ${page.title} page does not take a Nation, so the Nation was left out.`);
    else if (!NATION_ID_PATTERN.test(o.n)) notes.push('That Nation id is not in the form the dashboard uses, so the Nation was left out.');
    else nation = o.n;
  }

  const base = panel ? (PANEL_HEIGHTS[panel] ?? page.defaultEmbedHeight ?? 1000) : (page.defaultEmbedHeight ?? 1000);
  const requested = Number.isFinite(o.height) && /** @type {number} */ (o.height) > 0 ? Math.round(/** @type {number} */ (o.height)) : base;
  const height = Math.min(HEIGHT_MAX, Math.max(HEIGHT_MIN, requested));
  if (requested !== height) notes.push(`The height was set to ${height} pixels, the nearest allowed value.`);

  let autoHeight = o.autoHeight !== false;
  if (autoHeight && height < 320) {
    autoHeight = false;
    notes.push('A strip shorter than 320 pixels keeps its fixed height: the auto-height helper never sets less than 320 pixels, so its script line is left out.');
  }

  // Keys in sorted order, so equal options give equal addresses (the same rule as the site's own URLs).
  /** @type {[string, string][]} */
  const params = [['embed', '1']];
  if (nation) params.push(['n', nation]);
  if (panel) params.push(['panel', panel]);
  if (view) params.push(['view', view]);
  const query = `?${params.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&')}`;
  const src = `${PUBLISHED_BASE}${page.path}${query}`;

  const label = TITLE_OVERRIDES[page.id] ?? page.title;
  const suffix = panel ? `, ${PANEL_LABELS[panel] ?? panel}` : view ? `, ${VIEW_LABELS[view] ?? view}` : '';
  const title = `${PRODUCT_NAME}: ${label}${suffix}`;

  const lines = [
    '<iframe data-cthd',
    `  src="${attr(src)}"`,
    `  title="${attr(title)}"`,
    ...(o.geolocation ? ['  allow="geolocation"'] : []),
    `  style="width:100%;height:${height}px;border:0;display:block;"`,
    `  loading="${o.lazy ? 'lazy' : 'eager'}"`,
    '  referrerpolicy="strict-origin-when-cross-origin"></iframe>',
    ...(autoHeight ? [`<script src="${EMBED_SCRIPT_URL}" defer></script>`] : []),
  ];
  return { src, query, path: page.path, title, height, autoHeight, code: lines.join('\n'), notes };
}

/**
 * One row per page and view (and per Dashboard panel): the "All Snippets" table. Pure.
 * @returns {{ key: string, pageId: string, pageTitle: string, detail: string, options: SnippetOptions, snippet: Snippet }[]}
 */
export function referenceRows() {
  /** @type {{ key: string, pageId: string, pageTitle: string, detail: string, options: SnippetOptions, snippet: Snippet }[]} */
  const rows = [];
  for (const p of embeddablePages()) {
    /** @param {string} key @param {string} detail @param {SnippetOptions} options */
    const add = (key, detail, options) => rows.push({
      key, pageId: p.id, pageTitle: p.title, detail, options, snippet: buildSnippet({ geolocation: p.id === 'contacts', ...options }),
    });
    if (p.views.length === 0) add(p.id, 'Whole page', { page: p.id });
    else for (const v of p.views) add(`${p.id}:${v}`, VIEW_LABELS[v] ?? v, { page: p.id, view: v });
    if (p.id === 'dashboard') for (const panel of DASHBOARD_PANELS) add(`dashboard#${panel}`, PANEL_LABELS[panel] ?? panel, { page: p.id, panel });
  }
  return rows;
}

/**
 * The address for the live preview: the same page and query from this copy of the site. Pure.
 * @param {Snippet} snippet
 * @returns {string} relative to the embed page (one level below the site root)
 */
export function previewAddress(snippet) {
  return `../${snippet.path}${snippet.query}`;
}

/**
 * Clamp a height message the way site/embed.js does (320 to 6000), for the preview.
 * @param {unknown} h
 * @returns {number}
 */
export function clampHeight(h) {
  return Math.min(Math.max(Math.round(Number(h) || 0), 320), 6000);
}

/**
 * A Nation id from what a person typed: an id as written, or an exact name, preferred name, or alias from the
 * registry index. Pure.
 * @param {string} text
 * @param {{ id: string, name: string, preferredName?: string | null, aliases?: string[] }[]} nations
 * @returns {{ id: string | null, empty: boolean }}
 */
export function resolveNation(text, nations) {
  const t = text.trim();
  if (!t) return { id: null, empty: true };
  if (NATION_ID_PATTERN.test(t)) return { id: t, empty: false };
  const fold = (/** @type {string} */ s) => s.normalize('NFC').toLowerCase();
  const hit = nations.find((n) => [n.name, n.preferredName ?? '', ...(n.aliases ?? [])].some((x) => x && fold(x) === fold(t)));
  return { id: hit?.id ?? null, empty: false };
}

// ---------------------------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------------------------

/**
 * A read-only code block (text only, focusable so it can be scrolled and selected by keyboard).
 * @param {string} code
 * @returns {HTMLElement}
 */
function codeBlock(code) {
  return h('pre', { class: 'embed-code', tabindex: '0' }, h('code', {}, code));
}

/**
 * Start-up.
 * @returns {Promise<void>}
 */
export async function main() {
  const page = 'embed';
  initEmbed({ page });
  initChrome({ page });

  const form = /** @type {HTMLFormElement | null} */ (document.getElementById('embed-form'));
  const previewHost = document.getElementById('embed-preview-host');
  const referenceHost = document.getElementById('embed-reference');
  if (!form || !previewHost || !referenceHost) return;
  form.addEventListener('submit', (e) => e.preventDefault());

  const pages = embeddablePages();
  const pageSel = /** @type {HTMLSelectElement} */ (h('select', { id: 'embed-page', name: 'page' },
    ...pages.map((p) => h('option', { value: p.id }, p.title))));
  const viewSel = /** @type {HTMLSelectElement} */ (h('select', { id: 'embed-view', name: 'view' }));
  const panelSel = /** @type {HTMLSelectElement} */ (h('select', { id: 'embed-panel', name: 'panel' },
    h('option', { value: '' }, 'Whole page'),
    ...DASHBOARD_PANELS.map((p) => h('option', { value: p }, PANEL_LABELS[p] ?? p))));
  const nationIn = /** @type {HTMLInputElement} */ (h('input', {
    id: 'embed-nation', name: 'n', type: 'text', list: 'embed-nation-list', autocomplete: 'off', spellcheck: 'false', maxlength: '120',
    placeholder: 'All of Cascadia',
  }));
  const nationList = h('datalist', { id: 'embed-nation-list' });
  const heightIn = /** @type {HTMLInputElement} */ (h('input', { id: 'embed-height', name: 'height', type: 'number', min: String(HEIGHT_MIN), max: String(HEIGHT_MAX), step: '10', inputmode: 'numeric' }));
  const autoIn = /** @type {HTMLInputElement} */ (h('input', { id: 'embed-auto', name: 'auto', type: 'checkbox', checked: '' }));
  const geoIn = /** @type {HTMLInputElement} */ (h('input', { id: 'embed-geo', name: 'geo', type: 'checkbox' }));
  const lazyIn = /** @type {HTMLInputElement} */ (h('input', { id: 'embed-lazy', name: 'lazy', type: 'checkbox' }));
  const nationNote = h('p', { class: 'caption', id: 'embed-nation-note' }, 'Optional. Choose a Nation by full name, or type its id. Blank shows all of Cascadia.');
  const viewField = h('p', { 'data-field': 'view' }, h('label', { for: 'embed-view' }, 'View'), ' ', viewSel);
  const panelField = h('p', { 'data-field': 'panel' }, h('label', { for: 'embed-panel' }, 'Dashboard Section'), ' ', panelSel);
  const nationField = h('p', { 'data-field': 'nation' }, h('label', { for: 'embed-nation' }, 'Nation'), ' ', nationIn, nationList);

  const textarea = /** @type {HTMLTextAreaElement} */ (h('textarea', {
    id: 'embed-snippet', readonly: '', rows: '9', spellcheck: 'false', 'aria-label': 'Snippet to copy', wrap: 'off',
  }));
  const copyBtn = /** @type {HTMLButtonElement} */ (h('button', { type: 'button', class: 'btn btn--secondary', id: 'embed-copy' }, 'Copy Snippet'));
  const status = h('p', { class: 'caption', id: 'embed-status' });
  const notes = h('ul', { id: 'embed-notes', class: 'caption' });
  const live = createLiveRegion(status);

  form.append(
    h('p', { class: 'caption' }, 'Choose what to embed. The snippet and the preview update as you choose.'),
    h('p', {}, h('label', { for: 'embed-page' }, 'Page'), ' ', pageSel),
    viewField, panelField, nationField, nationNote,
    h('p', {}, h('label', { for: 'embed-height' }, 'Height in Pixels'), ' ', heightIn),
    h('p', {}, autoIn, ' ', h('label', { for: 'embed-auto' }, 'Match the height to the page (adds one script line)')),
    h('p', {}, geoIn, ' ', h('label', { for: 'embed-geo' }, 'Allow location for Near Me (needed on Contacts)')),
    h('p', {}, lazyIn, ' ', h('label', { for: 'embed-lazy' }, 'Load when scrolled into view (for embeds low on a page)')),
    h('h3', { id: 'embed-out-h' }, 'Snippet'),
    textarea,
    h('p', {}, copyBtn),
    status,
    notes,
  );

  // Preview.
  const preview = /** @type {HTMLIFrameElement} */ (h('iframe', {
    id: 'embed-preview', title: 'Preview of the embedded page', loading: 'eager', referrerpolicy: 'strict-origin-when-cross-origin', 'data-cthd': '',
  }));
  preview.style.width = '100%';
  preview.style.border = '0';
  preview.style.display = 'block';
  previewHost.append(preview);

  // The "All Snippets" reference table.
  const rows = referenceRows();
  const table = h('table', { id: 'embed-table' },
    h('caption', { class: 'visually-hidden' }, 'Every embeddable page and view with its address, height, and snippet'),
    h('thead', {}, h('tr', {}, ...['Page', 'View', 'Height', 'Address', 'Snippet'].map((c) => h('th', { scope: 'col' }, c)))),
    h('tbody', {}, ...rows.map((r) => {
      return h('tr', { 'data-row': r.key },
        h('th', { scope: 'row' }, r.pageTitle),
        h('td', {}, r.detail),
        h('td', { class: 'num' }, `${r.snippet.height} px`),
        h('td', {}, h('code', {}, `${r.snippet.path || './'}${r.snippet.query}`)),
        h('td', {}, h('details', { class: 'disclosure' }, h('summary', {}, 'Show snippet'), codeBlock(r.snippet.code)),
          h('button', { type: 'button', class: 'btn btn--link', 'data-use-row': r.key }, 'Use in Generator')));
    })));
  referenceHost.append(h('div', { class: 'table-wrap' }, table));

  /** @type {{ id: string, name: string, preferredName?: string | null, aliases?: string[] }[]} */
  let nations = [];
  let heightTouched = false;
  let lastPreview = '';

  function fillViews() {
    const p = pages.find((x) => x.id === pageSel.value);
    clear(viewSel);
    viewSel.append(h('option', { value: '' }, 'Default'));
    for (const v of p?.views ?? []) viewSel.append(h('option', { value: v }, VIEW_LABELS[v] ?? v));
  }

  function syncFields() {
    const id = pageSel.value;
    const p = pages.find((x) => x.id === id);
    viewField.hidden = !p || p.views.length === 0;
    panelField.hidden = id !== 'dashboard';
    nationField.hidden = !NATION_PAGES.includes(id);
    nationNote.hidden = nationField.hidden;
  }

  function currentOptions() {
    const r = resolveNation(nationIn.value, nations);
    const hv = Number(heightIn.value);
    /** @type {SnippetOptions} */
    const o = { page: pageSel.value, autoHeight: autoIn.checked, geolocation: geoIn.checked, lazy: lazyIn.checked };
    if (!viewField.hidden && viewSel.value) o.view = viewSel.value;
    if (!panelField.hidden && panelSel.value) o.panel = panelSel.value;
    if (!nationField.hidden && r.id) o.n = r.id;
    if (heightTouched && Number.isFinite(hv) && hv > 0) o.height = hv;
    return { o, nation: r };
  }

  function update() {
    syncFields();
    const { o, nation } = currentOptions();
    const s = buildSnippet(o);
    textarea.value = s.code;
    textarea.rows = s.code.split('\n').length + 1;
    if (!heightTouched || !heightIn.value) heightIn.value = String(s.height);
    const msgs = [...s.notes];
    if (!nationField.hidden && !nation.empty && !nation.id) msgs.push('That Nation was not recognized, so the snippet shows all of Cascadia. Choose a name from the list or type a Nation id.');
    clear(notes);
    for (const m of msgs) notes.append(h('li', {}, m));
    const src = previewAddress(s);
    if (src !== lastPreview) { lastPreview = src; preview.src = src; }
    preview.style.height = `${s.autoHeight ? Math.max(preview.offsetHeight, 320) : s.height}px`;
    preview.dataset.autoHeight = s.autoHeight ? '1' : '0';
    preview.dataset.fixedHeight = String(s.height);
  }

  // The preview follows the page's own height messages, the way site/embed.js does on a host page.
  globalThis.addEventListener('message', (event) => {
    const d = event.data;
    if (event.origin !== location.origin || !d || d.source !== 'cthd' || d.type !== 'resize') return;
    if (event.source !== preview.contentWindow || preview.dataset.autoHeight !== '1') return;
    preview.style.height = `${clampHeight(d.height)}px`;
  });

  pageSel.addEventListener('change', () => {
    fillViews();
    panelSel.value = '';
    heightTouched = false;
    geoIn.checked = pageSel.value === 'contacts';
    update();
  });
  panelSel.addEventListener('change', () => { heightTouched = false; update(); });
  viewSel.addEventListener('change', update);
  heightIn.addEventListener('input', () => { heightTouched = heightIn.value !== ''; update(); });
  for (const el of [nationIn, autoIn, geoIn, lazyIn]) el.addEventListener('input', update);
  for (const el of [autoIn, geoIn, lazyIn]) el.addEventListener('change', update);

  copyBtn.addEventListener('click', async () => {
    textarea.focus();
    textarea.select();
    let ok = false;
    try { await navigator.clipboard.writeText(textarea.value); ok = true; } catch {
      try { ok = document.execCommand('copy'); } catch { ok = false; }
    }
    live.announce(ok ? 'Snippet copied. Paste it into a Squarespace Code Block.' : 'The snippet is selected. Press Ctrl+C (Command+C on a Mac) to copy it.');
  });

  referenceHost.addEventListener('click', (e) => {
    const btn = e.target instanceof Element ? e.target.closest('[data-use-row]') : null;
    const row = rows.find((r) => r.key === btn?.getAttribute('data-use-row'));
    if (!row) return;
    pageSel.value = row.pageId;
    fillViews();
    viewSel.value = row.options.view ?? '';
    panelSel.value = row.options.panel ?? '';
    heightTouched = false;
    geoIn.checked = row.options.geolocation ?? row.pageId === 'contacts';
    update();
    form.scrollIntoView({ block: 'start' });
    textarea.focus();
  });

  fillViews();
  geoIn.checked = false;
  update();

  // Nation names for the list; the generator works without them (ids can be typed).
  const idx = await fetchLocal('data/registry/nations-index.json', { priority: 2 });
  const doc = /** @type {{ schema?: string, nations?: import('../types.js').NationIndexEntry[] } | null} */ (idx.ok ? idx.data : null);
  if (doc && doc.schema === 'cthd.nations-index/1' && Array.isArray(doc.nations)) {
    nations = doc.nations.map((n) => ({ id: n.id, name: n.name, preferredName: n.preferredName, aliases: n.aliases }));
    nationList.append(...nations.map((n) => h('option', { value: n.name })));
  } else {
    nationNote.textContent = 'Nation names could not be loaded. Type a Nation id to scope the embed, or leave blank for all of Cascadia.';
  }
  update();
}

if (globalThis.document?.body?.dataset.page === 'embed') void main();
