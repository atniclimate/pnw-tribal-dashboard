// @ts-check
/**
 * Event Archive pages (blueprint 7.9): `/archive/` (an index of archived events) and each archived event
 * (`/archive/2025-12-atmospheric-river/`, a dated timeline rendered from the compiled event file).
 *
 * The pages make no live requests: they read only `data/curated/events.json` and `data/curated/sources.json`,
 * which are static files of this site, and never `data/live/` or any upstream. Archived content is shown with
 * its original dates and never as current: a persistent banner says so, the status is Stale with a detail line
 * that names the last link check, and a dead link is labeled and points to an Internet Archive copy when one is
 * recorded. Entry titles and links are set as text and through safe URL attributes only.
 *
 * Entry module, loaded by <script type="module">; its static imports are listed in the page's modulepreload
 * block (check:preload). Pure helpers are exported for tests/unit/news. Owner: lane L14.
 */
import { initChrome } from '../ui/chrome.js';
import { initEmbed } from '../core/embed.js';
import { mountPanel } from '../ui/panel.js';
import { clear, h } from '../core/dom.js';
import { fetchLocal } from '../core/net.js';
import { findSource, loadSources } from '../core/sources.js';

/** @typedef {import('../types.js').StatusSnapshot} StatusSnapshot */

/**
 * @typedef {object} ArchiveEntry
 * @property {string} date YYYY-MM-DD
 * @property {string} kind
 * @property {string} title
 * @property {string} issuedBy
 * @property {string} url
 * @property {string} verifiedAt
 * @property {'ok' | 'dead'} linkStatus
 * @property {string | null} archiveUrl
 */

/**
 * @typedef {object} ArchiveEvent
 * @property {string} id
 * @property {string} title
 * @property {{ start: string, end: string }} period
 * @property {string} summary
 * @property {string} archivedAt
 * @property {string} compiledFrom
 * @property {ArchiveEntry[]} entries
 * @property {number[]} femaDisasterNumbers
 * @property {string[]} notes
 */

export const EVENTS_SOURCE_ID = 'cthd-events';
export const ENTRY_KIND_LABELS = Object.freeze(/** @type {Record<string, string>} */ ({
  'tribal-declaration': 'Tribal Declaration',
  'state-declaration': 'State Declaration',
  'county-notice': 'County Notice',
  resolution: 'Resolution',
  shelter: 'Shelter',
  'river-crest': 'River Crest',
  news: 'News Report',
  resource: 'Resource',
}));

// ---------------------------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------------------------

/**
 * 'YYYY-MM-DD' to 'MM/DD/YYYY' by text, with no time zone involved (a calendar date is not an instant).
 * @param {string} isoDate
 * @returns {string}
 */
export function formatCalendarDate(isoDate) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate);
  return m ? `${m[2]}/${m[3]}/${m[1]}` : isoDate;
}

/**
 * The persistent banner sentence, from the event's own period.
 * @param {{ start: string, end: string }} period
 * @returns {string}
 */
export function bannerText(period) {
  return `Archived event: ${formatCalendarDate(period.start)} to ${formatCalendarDate(period.end)}. This information is not current.`;
}

/**
 * Entries oldest first (the order events happened), ties kept in file order.
 * @param {ArchiveEntry[]} entries
 * @returns {ArchiveEntry[]}
 */
export function timelineOrder(entries) {
  return entries.map((e, i) => ({ e, i })).sort((a, b) => (a.e.date < b.e.date ? -1 : a.e.date > b.e.date ? 1 : a.i - b.i)).map((x) => x.e);
}

/**
 * Status of an archived file: Stale by construction (it describes a past event and says so), stamped with the
 * compile time, and naming the newest link check.
 * @param {string} generatedAt
 * @param {ArchiveEntry[]} entries
 * @param {string[]} sourceIds
 * @param {Date} now
 * @returns {StatusSnapshot}
 */
export function archiveStatus(generatedAt, entries, sourceIds, now) {
  const checked = entries.map((e) => e.verifiedAt).sort().pop();
  return {
    state: 'stale',
    asOf: generatedAt,
    asOfBasis: 'issued',
    detail: `Archived event, not current. Entries keep their original dates${checked ? ` and were last link checked ${formatCalendarDate(checked)}` : ''}`,
    sourceIds,
    origin: 'snapshot',
    completeness: 'complete',
    checkedAt: now.toISOString(),
  };
}

/**
 * The address of fema.gov's own page for one disaster number. The host comes from the registered OpenFEMA
 * source record (core/sources.js), never from a literal; null when that record is not loaded or not https.
 * @param {number} n
 * @param {string | null | undefined} registeredUrl any https address on the FEMA host, from the registry
 * @returns {string | null}
 */
export function femaUrl(n, registeredUrl) {
  if (!registeredUrl || !Number.isInteger(n) || n < 1) return null;
  try {
    const u = new URL(registeredUrl);
    return u.protocol === 'https:' ? new URL(`/disaster/${n}`, u.origin).toString() : null;
  } catch { return null; }
}

// ---------------------------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------------------------

/**
 * @param {AbortSignal} [signal]
 * @returns {Promise<{ ok: true, generatedAt: string, items: ArchiveEvent[] } | { ok: false, reason: string }>}
 */
async function loadEvents(signal) {
  const res = await fetchLocal('data/curated/events.json', signal ? { signal, priority: 1 } : { priority: 1 });
  if (!res.ok) return { ok: false, reason: res.error.message };
  const doc = /** @type {any} */ (res.data);
  if (!doc || doc.schema !== 'cthd.curated.events/1' || !Array.isArray(doc.items)) return { ok: false, reason: 'unexpected format' };
  return { ok: true, generatedAt: String(doc.generatedAt), items: doc.items };
}

/**
 * @param {string} reason
 * @returns {StatusSnapshot}
 */
const unavailable = (reason) => ({
  state: 'unavailable', asOf: null, asOfBasis: null, detail: `The archive file could not be read (${reason})`,
  sourceIds: [EVENTS_SOURCE_ID], origin: 'snapshot', completeness: 'partial', checkedAt: new Date().toISOString(),
});

// ---------------------------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------------------------

/**
 * @param {ArchiveEntry} e
 * @returns {HTMLElement}
 */
export function renderEntry(e) {
  const dead = e.linkStatus === 'dead';
  return h('li', { class: 'archive-entry', 'data-kind': e.kind, 'data-link-status': e.linkStatus },
    h('p', { class: 'caption' },
      h('time', { datetime: e.date }, formatCalendarDate(e.date)), ' · ',
      h('strong', {}, ENTRY_KIND_LABELS[e.kind] ?? e.kind)),
    h('h3', { class: 'archive-entry__title' }, h('a', { href: e.url, target: '_blank', rel: 'noopener noreferrer' }, e.title)),
    h('p', { class: 'archive-entry__issuer' }, `Issued by ${e.issuedBy}.`),
    dead
      ? h('p', { class: 'panel-note' }, 'This link no longer works.', ' ',
        e.archiveUrl
          ? h('a', { href: e.archiveUrl, target: '_blank', rel: 'noopener noreferrer' }, 'Internet Archive copy')
          : 'No archived copy is on record.')
      : null,
    h('p', { class: 'caption' }, `Link checked ${formatCalendarDate(e.verifiedAt)}.`));
}

/**
 * @param {HTMLElement} body
 * @param {ArchiveEvent} ev
 */
function renderEvent(body, ev) {
  clear(body);
  const entries = timelineOrder(ev.entries);
  const fema = ev.femaDisasterNumbers.length > 0
    ? [h('p', {}, h('strong', {}, 'FEMA disaster numbers: '),
      ...ev.femaDisasterNumbers.flatMap((n, i) => {
        const href = femaUrl(n, findSource('openfema-declarations')?.humanUrl);
        return [i ? ', ' : '', href ? h('a', { href, target: '_blank', rel: 'noopener noreferrer' }, String(n)) : String(n)];
      }))]
    : [];
  body.append(
    h('p', { class: 'lede' }, ev.summary),
    ...fema,
    h('ol', { class: 'archive-timeline plain' }, ...entries.map(renderEntry)),
    h('p', { class: 'caption' }, `Compiled ${formatCalendarDate(ev.archivedAt)}. ${ev.compiledFrom}`));
}

/**
 * @param {HTMLElement} body
 * @param {ArchiveEvent[]} events
 */
function renderIndex(body, events) {
  clear(body);
  const sorted = [...events].sort((a, b) => (a.period.start < b.period.start ? 1 : -1));
  body.append(
    sorted.length === 0
      ? h('p', { class: 'panel-note' }, 'No archived events are listed.')
      : h('ul', { class: 'archive-list' }, ...sorted.map((ev) => h('li', {},
        h('h3', {}, h('a', { href: `./${ev.id}/` }, ev.title)),
        h('p', { class: 'caption' }, `${formatCalendarDate(ev.period.start)} to ${formatCalendarDate(ev.period.end)}`),
        h('p', {}, ev.summary)))));
}

// ---------------------------------------------------------------------------------------------
// Start-up
// ---------------------------------------------------------------------------------------------

/**
 * Page start-up.
 * @returns {Promise<void>}
 */
export async function main() {
  const page = /** @type {'archive' | 'archive-event'} */ (document.body.dataset.page === 'archive-event' ? 'archive-event' : 'archive');
  initEmbed({ page });
  try { await loadSources(); } catch { /* panels still render; their footers name the ids */ }
  /** @type {Record<string, string>} */
  const names = {};
  const rec = findSource(EVENTS_SOURCE_ID);
  if (rec) names[EVENTS_SOURCE_ID] = rec.attribution || rec.owner;
  initChrome({ page, sources: names });

  const slot = /** @type {HTMLElement | null} */ (document.querySelector('[data-panel]'));
  if (!slot) return;
  const eventId = page === 'archive-event' ? (location.pathname.split('/').filter(Boolean).pop() ?? '') : '';

  mountPanel(slot, {
    title: slot.querySelector('.panel__title')?.textContent ?? 'Archive',
    sourceIds: [EVENTS_SOURCE_ID],
    statusId: page,
    load: async (signal) => {
      const res = await loadEvents(signal);
      if (!res.ok) return { data: null, status: unavailable(res.reason) };
      const events = res.items;
      const ev = page === 'archive-event' ? events.find((x) => x.id === eventId) : null;
      if (page === 'archive-event' && !ev) return { data: null, status: unavailable('this event is not in the archive file') };
      const data = page === 'archive-event' ? ev : events;
      const all = page === 'archive-event' && ev ? ev.entries : events.flatMap((x) => x.entries);
      return { data, status: archiveStatus(res.generatedAt, all, [EVENTS_SOURCE_ID], new Date()) };
    },
    render: (body, data) => {
      if (page === 'archive-event') {
        const ev = /** @type {ArchiveEvent} */ (data);
        const banner = document.querySelector('.archive-banner');
        if (banner) banner.textContent = bannerText(ev.period);
        renderEvent(body, ev);
      } else {
        renderIndex(body, /** @type {ArchiveEvent[]} */ (data));
      }
    },
    renderUnavailable: (body, status) => {
      clear(body);
      body.append(h('p', { class: 'panel__unavailable' },
        `This archived event could not be displayed${status.detail ? ` (${status.detail})` : ''}. No substitute text is shown in its place. Return to the `,
        h('a', { href: page === 'archive-event' ? '../' : './' }, 'Event Archive'), ' or the ',
        h('a', { href: page === 'archive-event' ? '../../' : '../' }, 'Dashboard'), '.'));
    },
  });
}

if (globalThis.document?.body && /^archive/.test(globalThis.document.body.dataset.page ?? '')) void main();
