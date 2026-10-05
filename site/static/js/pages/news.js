// @ts-check
/**
 * News page (blueprint 7.7). Renders `data/live/news.json`, written by the scheduled news snapshot task, so no
 * browser ever fetches a feed and no proxy exists. Latest first across all sources; filters for source kind,
 * jurisdiction, and search; per-source status ("Oregon Public Broadcasting feed has not answered since
 * 3:00 PM PDT"); YouTube items as text links ("Watch on YouTube"), so nothing from YouTube loads until a person
 * follows the link; a separate "Community, Unverified" section whose Reddit communities are labeled links only.
 *
 * The filter controls are built once, outside the panel body, and the headline list is built once per load
 * with every card present; filtering toggles `hidden` on the cards. Nothing the person types or focuses is ever
 * replaced, so the search box keeps focus through typing, filtering, and a background refresh.
 *
 * Entry module, loaded by <script type="module">; its static imports are listed in the page's modulepreload
 * block (check:preload). Pure helpers are exported for tests/unit/news. Owner: lane L14.
 */
import { initChrome } from '../ui/chrome.js';
import { initEmbed } from '../core/embed.js';
import { mountPanel } from '../ui/panel.js';
import { clear, h } from '../core/dom.js';
import { fetchLocal } from '../core/net.js';
import { findSource, getData, loadSources } from '../core/sources.js';
import { deriveStatus } from '../core/status.js';
import { formatAsOf } from '../core/time.js';
import { onStateChange, parseQuery, readState, writeState } from '../core/url-state.js';
import { createLiveRegion } from '../ui/live-region.js';
import { statusPill } from '../ui/status-pill.js';

/** @typedef {import('../types.js').StatusSnapshot} StatusSnapshot */
/** @typedef {import('../types.js').UrlStateSchema} UrlStateSchema */

/**
 * @typedef {object} NewsItem
 * @property {string} id
 * @property {string} sourceId
 * @property {string} title
 * @property {string} url
 * @property {string} published
 * @property {string} summary
 * @property {'official' | 'media' | 'video' | 'community'} kind
 * @property {string[]} regions
 */

/**
 * @typedef {object} NewsSource
 * @property {string} id
 * @property {string} name
 * @property {'official' | 'media' | 'video' | 'community'} kind
 * @property {string[]} regions
 * @property {string} homepage
 * @property {string | null} feed
 * @property {'rss' | 'atom' | 'youtube-atom' | 'none'} feedFormat
 * @property {number} [maxItems]
 * @property {number} [maxAgeDays]
 * @property {string} verifiedAt
 */

/**
 * @typedef {object} NewsEnvelope
 * @property {'complete' | 'partial' | 'rejected'} completeness
 * @property {boolean} carriedForward
 * @property {Record<string, { ok: boolean, count: number, asOf: string | null, carriedForward?: boolean }>} perSource
 * @property {NewsItem[]} items
 */

/**
 * @typedef {object} NewsFilters
 * @property {string[]} kinds empty means every kind
 * @property {string | null} j jurisdiction or null for all
 * @property {string} q search text
 * @property {'latest' | 'official'} sort
 */

export const NEWS_SOURCE_ID = 'cthd-news';
export const KIND_ORDER = Object.freeze(['official', 'media', 'video']);
export const KIND_LABELS = Object.freeze(/** @type {Record<string, string>} */ ({
  official: 'Official', media: 'News Media', video: 'Video', community: 'Community, Unverified',
}));
export const JURISDICTION_LABELS = Object.freeze(/** @type {Record<string, string>} */ ({
  WA: 'Washington', OR: 'Oregon', ID: 'Idaho', BC: 'British Columbia', 'CA-N': 'Northern California',
  'MT-W': 'Western Montana', 'NV-N': 'Northern Nevada', 'AK-SE': 'Southeast Alaska',
}));
export const SORT_LABELS = Object.freeze({ latest: 'Latest First', official: 'Official First' });

/** Page parameters (blueprint 1.2: kind, j, q; sort is an additive parameter of this page). */
export const NEWS_URL_SCHEMA = /** @type {UrlStateSchema} */ (Object.freeze({
  kind: { type: 'enum-list', values: [...KIND_ORDER] },
  j: { type: 'enum', values: Object.keys(JURISDICTION_LABELS) },
  q: { type: 'string' },
  sort: { type: 'enum', values: ['latest', 'official'] },
}));

// ---------------------------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------------------------

/**
 * Lowercase, accent-folded, whitespace-collapsed search text.
 * @param {unknown} text
 * @returns {string}
 */
export function normalizeQuery(text) {
  return String(text ?? '').normalize('NFD').replace(/\p{M}+/gu, '').toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * @param {Record<string, unknown>} parsed result of parseQuery(search, NEWS_URL_SCHEMA)
 * @returns {NewsFilters}
 */
export function filtersFromState(parsed) {
  return {
    kinds: Array.isArray(parsed.kind) ? parsed.kind.map(String) : [],
    j: typeof parsed.j === 'string' ? parsed.j : null,
    q: typeof parsed.q === 'string' ? parsed.q : '',
    sort: parsed.sort === 'official' ? 'official' : 'latest',
  };
}

/**
 * Newest first; with 'official', official items come first and each group is newest first. Ties break on id so
 * equal data always gives the same order. Returns a new array.
 * @param {NewsItem[]} items
 * @param {'latest' | 'official'} sort
 * @returns {NewsItem[]}
 */
export function sortItems(items, sort) {
  const rank = (/** @type {NewsItem} */ i) => (sort === 'official' && i.kind === 'official' ? 0 : 1);
  return [...items].sort((a, b) => rank(a) - rank(b) || (a.published < b.published ? 1 : a.published > b.published ? -1 : a.id < b.id ? -1 : 1));
}

/**
 * Whether a headline passes the filters: kind (any of), jurisdiction, and every search word.
 * @param {NewsItem} item
 * @param {NewsFilters} f
 * @param {string} [sourceName] searched along with the title and summary
 * @returns {boolean}
 */
export function itemMatches(item, f, sourceName = '') {
  if (f.kinds.length > 0 && !f.kinds.includes(item.kind)) return false;
  if (f.j && !item.regions.includes(f.j)) return false;
  const words = normalizeQuery(f.q).split(' ').filter(Boolean);
  if (words.length === 0) return true;
  const hay = normalizeQuery(`${item.title} ${item.summary} ${sourceName}`);
  return words.every((w) => hay.includes(w));
}

/**
 * One line of per-source status. The "since" time is the last time the feed answered, which is the only
 * time known; the snapshot never claims when the outage began.
 * @param {NewsSource} source
 * @param {{ ok: boolean, count: number, asOf: string | null, carriedForward?: boolean } | undefined} st
 * @param {string} [timeZone]
 * @returns {{ state: 'live' | 'stale' | 'unavailable', text: string }}
 */
export function sourceStatusLine(source, st, timeZone) {
  const days = source.maxAgeDays ?? 14;
  if (!st) return { state: 'unavailable', text: `${source.name} was not part of the latest update.` };
  if (st.ok) {
    const when = st.asOf ? formatAsOf(st.asOf, timeZone) : 'a time not recorded';
    return st.count > 0
      ? { state: 'live', text: `${source.name} feed answered ${when}: ${st.count} ${st.count === 1 ? 'headline' : 'headlines'}.` }
      : { state: 'live', text: `${source.name} feed answered ${when}: no headlines in the last ${days} days.` };
  }
  const since = st.asOf ? `has not answered since ${formatAsOf(st.asOf, timeZone)}` : 'has not answered in any update on record';
  const kept = st.count > 0 ? ` Showing ${st.count} earlier ${st.count === 1 ? 'headline' : 'headlines'}.` : ' No earlier headlines are held.';
  return { state: st.asOf ? 'stale' : 'unavailable', text: `${source.name} feed ${since}.${kept}` };
}

/**
 * Status for a curated, build-time list (the source directory and community links): its age is the age of the
 * compiled file, and the detail names the verification date. Pure.
 * @param {{ generatedAt: string, items: NewsSource[] }} doc
 * @param {Date} now
 * @returns {StatusSnapshot}
 */
export function curatedListStatus(doc, now) {
  const newest = doc.items.map((s) => s.verifiedAt).sort().pop() ?? null;
  const status = deriveStatus({
    sourceIds: [NEWS_SOURCE_ID],
    policy: { freshForMs: 45 * 86_400_000, usableForMs: 180 * 86_400_000 },
    now,
    snapshot: { asOf: doc.generatedAt, asOfBasis: 'issued', carriedForward: false },
  });
  const [y, m, d] = (newest ?? '').split('-');
  return { ...status, detail: newest ? `Links last checked ${m}/${d}/${y}` : 'Link check date not recorded' };
}

/**
 * Jurisdictions that appear in the headlines or the source list, in the registry's order.
 * @param {NewsItem[]} items
 * @param {NewsSource[]} sources
 * @returns {string[]}
 */
export function jurisdictionsPresent(items, sources) {
  const seen = new Set([...items.flatMap((i) => i.regions), ...sources.flatMap((s) => s.regions)]);
  return Object.keys(JURISDICTION_LABELS).filter((j) => seen.has(j));
}

// ---------------------------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------------------------

/**
 * data/curated/news-sources.json (compiled from data/news-sources.yaml).
 * @param {AbortSignal} [signal]
 * @returns {Promise<{ ok: true, doc: { generatedAt: string, items: NewsSource[] } } | { ok: false, reason: string }>}
 */
async function loadSourceList(signal) {
  const res = await fetchLocal('data/curated/news-sources.json', signal ? { signal, priority: 2 } : { priority: 2 });
  const doc = /** @type {any} */ (res.ok ? res.data : null);
  if (!res.ok) return { ok: false, reason: res.error.message };
  if (!doc || doc.schema !== 'cthd.curated.news-sources/1' || !Array.isArray(doc.items)) return { ok: false, reason: 'unexpected format' };
  return { ok: true, doc };
}

/**
 * @param {AbortSignal} signal
 * @returns {Promise<{ data: { env: NewsEnvelope, sources: NewsSource[] } | null, status: StatusSnapshot }>}
 */
async function loadNews(signal) {
  const [res, list] = await Promise.all([getData(NEWS_SOURCE_ID, {}, { signal }), loadSourceList(signal)]);
  const env = /** @type {NewsEnvelope | null} */ (res.data);
  if (!env || !Array.isArray(env.items)) return { data: null, status: res.status };
  let status = res.status;
  const names = list.ok ? list.doc.items : [];
  const failed = Object.values(env.perSource ?? {}).filter((s) => !s.ok).length;
  if (env.completeness === 'partial' && status.state !== 'unavailable') {
    status = {
      ...status,
      state: status.state === 'live' ? 'degraded' : status.state,
      completeness: 'partial',
      detail: `${failed} of ${Object.keys(env.perSource).length} news feeds are not answering; see Source Status below`,
    };
  }
  return { data: { env, sources: names }, status };
}

// ---------------------------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------------------------

/** Filter and sort state, shared by the controls and the list. */
/** @type {NewsFilters} */
const view = { kinds: [], j: null, q: '', sort: 'latest' };
/** @type {{ announce(message: string): void } | null} */
let live = null;

/**
 * @param {NewsItem} item
 * @param {string} sourceName
 * @returns {HTMLElement}
 */
export function renderItem(item, sourceName) {
  const isVideo = item.kind === 'video';
  const title = h('h3', { class: 'news-item__title' },
    isVideo ? item.title : h('a', { href: item.url, target: '_blank', rel: 'noopener noreferrer' }, item.title));
  return h('li', {
    class: 'news-item', 'data-news-item': item.id, 'data-kind': item.kind,
  },
  h('p', { class: 'news-item__meta caption' },
    h('strong', {}, KIND_LABELS[item.kind] ?? item.kind), ' · ', sourceName, ' · ',
    h('time', { datetime: item.published }, formatAsOf(item.published))),
  title,
  item.summary ? h('p', { class: 'news-item__summary' }, item.summary) : null,
  isVideo
    ? h('p', { class: 'news-item__link' },
      h('a', { href: item.url, target: '_blank', rel: 'noopener noreferrer' }, 'Watch on YouTube', h('span', { class: 'visually-hidden' }, `: ${item.title}`)),
      ' (opens YouTube in a new tab)')
    : null);
}

/**
 * Apply the current filters to the cards already on the page: toggles `hidden`, never rebuilds. Announces the
 * count politely when it changes.
 * @param {HTMLElement} root
 * @param {Map<string, NewsItem>} byId
 * @param {Map<string, string>} names source id to display name
 * @returns {number} cards shown
 */
export function applyFilters(root, byId, names) {
  let shown = 0;
  const cards = /** @type {NodeListOf<HTMLElement>} */ (root.querySelectorAll('[data-news-item]'));
  for (const card of cards) {
    const item = byId.get(card.getAttribute('data-news-item') ?? '');
    const ok = item ? itemMatches(item, view, names.get(item.sourceId) ?? '') : false;
    card.hidden = !ok;
    if (ok) shown += 1;
  }
  const empty = root.querySelector('[data-news-empty]');
  if (empty instanceof HTMLElement) empty.hidden = shown > 0 || cards.length === 0;
  live?.announce(cards.length === 0 ? '' : `${shown} of ${cards.length} headlines shown`);
  return shown;
}

/**
 * Put the cards in the current sort order (moves existing nodes; builds none).
 * @param {HTMLElement} list
 * @param {Map<string, NewsItem>} byId
 */
function reorder(list, byId) {
  const cards = new Map(Array.from(list.querySelectorAll('[data-news-item]')).map((c) => [c.getAttribute('data-news-item') ?? '', c]));
  for (const item of sortItems([...byId.values()], view.sort)) {
    const card = cards.get(item.id);
    if (card) list.append(card);
  }
}

/**
 * @param {HTMLElement} body
 * @param {{ env: NewsEnvelope, sources: NewsSource[] }} data
 */
function renderNews(body, data) {
  clear(body);
  const { env, sources } = data;
  const sourceById = new Map(sources.map((s) => [s.id, s]));
  const names = new Map([...sourceById].map(([id, s]) => [id, s.name]));
  const byId = new Map(env.items.map((i) => [i.id, i]));

  const list = h('ul', { class: 'news-list plain', 'data-news-list': '' });
  for (const item of sortItems(env.items, view.sort)) list.append(renderItem(item, names.get(item.sourceId) ?? item.sourceId));
  const empty = h('p', { class: 'panel-note', 'data-news-empty': '' },
    'No headlines match these filters. Clear the search or choose another source kind or place.');
  empty.hidden = true;

  body.append(
    env.items.length === 0
      ? h('p', { class: 'panel-note' }, 'The news feeds answered, but none carried a headline inside its time window. Source Status below lists each feed.')
      : list,
    empty,
    renderStatusList(env, sources),
  );
  applyFilters(body, byId, names);
}

/**
 * @param {NewsEnvelope} env
 * @param {NewsSource[]} sources
 * @returns {HTMLElement}
 */
function renderStatusList(env, sources) {
  const rows = [];
  for (const [id, st] of Object.entries(env.perSource)) {
    const source = sources.find((s) => s.id === id) ?? { id, name: id, kind: 'media', regions: [], homepage: '', feed: null, feedFormat: 'none', verifiedAt: '' };
    const line = sourceStatusLine(/** @type {NewsSource} */ (source), st);
    rows.push(h('li', { class: 'news-status__row' }, statusPill(line.state), ' ', line.text, ' ',
      source.homepage ? h('a', { href: source.homepage, target: '_blank', rel: 'noopener noreferrer' }, 'Open site') : null));
  }
  return h('details', { class: 'disclosure news-status', open: '' },
    h('summary', {}, 'Source Status'),
    h('ul', { class: 'plain' }, ...rows),
    h('p', { class: 'caption' }, 'Headlines come from each publisher’s own public feed, read by a scheduled update about every thirty minutes. This page is not an alert source: use Alerts for warnings.'));
}

/**
 * Source directory: every source with a homepage link, grouped by kind.
 * @param {HTMLElement} body
 * @param {NewsSource[]} sources
 */
function renderDirectory(body, sources) {
  clear(body);
  body.append(h('p', {}, 'Publishers and agencies that cover Cascadia. Links open the publisher’s own site in a new tab; nothing from these sites loads here.'));
  for (const kind of ['official', 'media', 'video']) {
    const group = sources.filter((s) => s.kind === kind).sort((a, b) => a.name.localeCompare(b.name));
    if (group.length === 0) continue;
    body.append(
      h('h3', {}, KIND_LABELS[kind]),
      h('ul', { class: 'bullets' }, ...group.map((s) => h('li', {},
        h('a', { href: s.homepage, target: '_blank', rel: 'noopener noreferrer' }, s.name),
        ` (${s.regions.map((r) => JURISDICTION_LABELS[r] ?? r).join(', ')}) `,
        h('span', { class: 'caption' }, s.feedFormat === 'none' ? 'Link only' : 'Headlines above')))),
    );
  }
}

/**
 * Community links: labeled links only, never fetched.
 * @param {HTMLElement} body
 * @param {NewsSource[]} sources
 */
function renderCommunity(body, sources) {
  clear(body);
  const group = sources.filter((s) => s.kind === 'community').sort((a, b) => a.name.localeCompare(b.name));
  body.append(
    h('p', {}, 'Posts on these community pages are not checked or verified by ATNI Climate or anyone else. Do not rely on them for warnings. Each link opens Reddit in a new tab; nothing from Reddit loads on this page.'),
    group.length === 0
      ? h('p', { class: 'panel-note' }, 'No community links are listed.')
      : h('ul', { class: 'bullets' }, ...group.map((s) => h('li', {},
        h('a', { href: s.homepage, target: '_blank', rel: 'noopener noreferrer' }, s.name), ' (',
        s.regions.map((r) => JURISDICTION_LABELS[r] ?? r).join(', '), ') ',
        h('strong', {}, KIND_LABELS.community)))),
  );
}

/**
 * The controls, built once. They live outside the panel body, so a refresh never replaces them.
 * @param {HTMLElement} host
 * @param {string[]} jurisdictions
 * @param {() => void} onChange called after the shared `view` changes
 * @param {typeof import('../ui/filter-chips.js').createFilterChips} createFilterChips lazily loaded, so this entry's static graph fits budgets.json jsStaticGraph
 * @returns {{ sync(): void }}
 */
function buildControls(host, jurisdictions, onChange, createFilterChips) {
  clear(host);
  const search = /** @type {HTMLInputElement} */ (h('input', {
    type: 'search', id: 'news-q', name: 'q', autocomplete: 'off', spellcheck: 'false', enterkeyhint: 'search', maxlength: '200',
  }));
  const place = /** @type {HTMLSelectElement} */ (h('select', { id: 'news-j', name: 'j' },
    h('option', { value: '' }, 'All of Cascadia'),
    ...jurisdictions.map((j) => h('option', { value: j }, JURISDICTION_LABELS[j] ?? j))));
  const sort = /** @type {HTMLSelectElement} */ (h('select', { id: 'news-sort', name: 'sort' },
    ...Object.entries(SORT_LABELS).map(([v, label]) => h('option', { value: v }, label))));
  const chipsHost = h('div', { 'data-news-kinds': '' });
  const region = h('div', { class: 'visually-hidden', 'data-news-count': '' });
  live = createLiveRegion(region);

  const form = h('form', { class: 'news-filters', role: 'search', 'aria-label': 'Filter headlines' },
    h('p', {}, h('label', { for: 'news-q' }, 'Search headlines'), ' ', search),
    chipsHost,
    h('p', {}, h('label', { for: 'news-j' }, 'Place'), ' ', place, ' ', h('label', { for: 'news-sort' }, 'Order'), ' ', sort),
    region);
  form.addEventListener('submit', (e) => e.preventDefault());
  host.append(form);

  const chips = createFilterChips(chipsHost, {
    key: 'kind',
    label: 'Source kind',
    options: KIND_ORDER.map((k) => ({ value: k, label: KIND_LABELS[k] ?? k })),
    selected: view.kinds,
    onChange: (values) => { view.kinds = values; push(); },
  });

  function push() {
    writeState({
      kind: view.kinds.length ? view.kinds : undefined,
      j: view.j ?? undefined,
      q: normalizeQuery(view.q) ? view.q.trim() : undefined,
      sort: view.sort === 'latest' ? undefined : view.sort,
    });
    onChange();
  }

  search.addEventListener('input', () => { view.q = search.value; push(); });
  place.addEventListener('change', () => { view.j = place.value || null; push(); });
  sort.addEventListener('change', () => { view.sort = sort.value === 'official' ? 'official' : 'latest'; push(); });

  /** Controls follow the shared state without touching what the person is typing. */
  function sync() {
    if (normalizeQuery(search.value) !== normalizeQuery(view.q)) search.value = view.q;
    place.value = view.j ?? '';
    sort.value = view.sort;
    chips.set(view.kinds);
  }
  sync();
  return { sync };
}

// ---------------------------------------------------------------------------------------------
// Start-up
// ---------------------------------------------------------------------------------------------

/**
 * Page start-up.
 * @returns {Promise<void>}
 */
export async function main() {
  const page = 'news';
  initEmbed({ page });
  const chipsLoading = import('../ui/filter-chips.js');
  try { await loadSources(); } catch { /* panels still render; their footers name the ids */ }
  /** @type {Record<string, string>} */
  const names = {};
  const rec = findSource(NEWS_SOURCE_ID);
  if (rec) names[NEWS_SOURCE_ID] = rec.attribution || rec.owner;
  initChrome({ page, sources: names });

  Object.assign(view, filtersFromState(readState(NEWS_URL_SCHEMA)));

  const newsSlot = /** @type {HTMLElement | null} */ (document.querySelector('[data-panel="news"]'));
  const dirSlot = /** @type {HTMLElement | null} */ (document.querySelector('[data-panel="news-directory"]'));
  const communitySlot = /** @type {HTMLElement | null} */ (document.querySelector('[data-panel="news-community"]'));
  const controlsHost = /** @type {HTMLElement | null} */ (document.querySelector('[data-news-controls]'));

  /** @type {Map<string, NewsItem>} */
  let byId = new Map();
  /** @type {Map<string, string>} */
  let nameById = new Map();
  /** @type {{ sync(): void } | null} */
  let controls = null;

  const refreshView = () => {
    const body = newsSlot?.querySelector('[data-panel-body]');
    if (!(body instanceof HTMLElement)) return;
    const list = body.querySelector('[data-news-list]');
    if (list instanceof HTMLElement) reorder(list, byId);
    applyFilters(body, byId, nameById);
  };

  if (controlsHost) controls = buildControls(controlsHost, Object.keys(JURISDICTION_LABELS), refreshView, (await chipsLoading).createFilterChips);

  onStateChange(() => {
    const next = filtersFromState(parseQuery(globalThis.location.search, NEWS_URL_SCHEMA));
    const same = next.j === view.j && next.sort === view.sort && next.kinds.join() === view.kinds.join() && normalizeQuery(next.q) === normalizeQuery(view.q);
    if (same) return;
    Object.assign(view, next);
    controls?.sync();
    refreshView();
  });

  if (newsSlot) {
    mountPanel(newsSlot, {
      title: 'Latest News',
      sourceIds: [NEWS_SOURCE_ID],
      statusId: 'news',
      poll: { visibleMs: 10 * 60_000, minMs: 5 * 60_000 },
      load: loadNews,
      render: (body, data, status) => {
        void status;
        const d = /** @type {{ env: NewsEnvelope, sources: NewsSource[] }} */ (data);
        byId = new Map(d.env.items.map((i) => [i.id, i]));
        nameById = new Map(d.sources.map((s) => [s.id, s.name]));
        renderNews(body, d);
      },
      renderUnavailable: (body) => {
        clear(body);
        byId = new Map();
        // The reason (which can carry an HTTP status number) is in the provenance footer, not in the body.
        body.append(h('p', { class: 'panel__unavailable' },
          `Headlines are unavailable right now. No older or substitute headlines are shown in their place. The publishers listed under Source Directory have their own sites, and official alerts are always at weather.gov and weather.gc.ca.`));
      },
    });
  }

  /**
   * A curated-list panel: same file, status from its compile date.
   * @param {HTMLElement | null} slot
   * @param {string} statusId
   * @param {string} title
   * @param {(body: HTMLElement, sources: NewsSource[]) => void} draw
   */
  const listPanel = (slot, statusId, title, draw) => {
    if (!slot) return;
    mountPanel(slot, {
      title,
      sourceIds: [NEWS_SOURCE_ID],
      statusId,
      load: async (signal) => {
        const list = await loadSourceList(signal);
        if (!list.ok) {
          return { data: null, status: { state: 'unavailable', asOf: null, asOfBasis: null, detail: `The source list could not be read (${list.reason})`, sourceIds: [NEWS_SOURCE_ID], origin: 'snapshot', completeness: 'partial', checkedAt: new Date().toISOString() } };
        }
        return { data: list.doc.items, status: curatedListStatus(list.doc, new Date()) };
      },
      render: (body, data) => draw(body, /** @type {NewsSource[]} */ (data)),
    });
  };
  listPanel(dirSlot, 'news-directory', 'Source Directory', renderDirectory);
  listPanel(communitySlot, 'news-community', 'Community, Unverified', renderCommunity);
}

if (globalThis.document?.body?.dataset.page === 'news') void main();
