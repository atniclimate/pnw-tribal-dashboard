// @ts-check
/**
 * Snapshot task `news` (blueprint 5.8, 6.4): reads the feeds of data/news-sources.yaml on the scheduled build
 * and writes `news.json`, so no browser ever fetches a feed and no proxy exists.
 *
 * Rules, each proved by tests/unit/news/:
 *   - A feed that declares a DOCTYPE or ENTITY is rejected before parsing; the parser never expands entities.
 *   - Titles and summaries are plain text: markup and scripts removed, entities decoded once, whitespace
 *     collapsed, truncated to 200 and 280 characters. Nothing reaches the page as HTML.
 *   - Links are https only. An http link is upgraded only when the https address answers a HEAD request
 *     (through the registered-origin HTTP client); otherwise the item is dropped. javascript:, data:, and
 *     every other scheme drop the item. Tracking parameters are removed.
 *   - An item without a usable date is dropped; so is one dated more than a day in the future.
 *   - YouTube channels are Atom feeds read for title and link only; no thumbnail address is kept.
 *   - Community sources (kind community, feedFormat none) are never fetched.
 *   - A feed that fails keeps its previous items (inside the age window), flagged carriedForward, and its
 *     per-source status says when it last answered. Every feed failing is a rejected envelope, which the
 *     runner replaces with the previous file.
 *
 * Never throws for upstream failures. Pure helpers are exported for tests; the default export is the task.
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { XMLParser } from 'fast-xml-parser';
import { CORE_SCHEMA, load as loadYaml } from 'js-yaml';

/** @typedef {import('../../../site/static/js/types.js').LiveEnvelope<unknown>} Envelope */
/** @typedef {import('../../../site/static/js/types.js').SnapshotContext} SnapshotContext */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
export const TITLE_MAX = 200;
export const SUMMARY_MAX = 280;
export const DEFAULT_MAX_ITEMS = 10;
export const DEFAULT_MAX_AGE_DAYS = 14;
/** An item dated further ahead than this is a clock or feed error, not news. */
export const FUTURE_SLACK_MS = 24 * 3600 * 1000;
/** At most this many HEAD requests per feed to test an http link's https address. */
export const MAX_UPGRADE_CHECKS = 5;
const DAY_MS = 24 * 3600 * 1000;
const TRACKING_PARAM = /^(?:utm_[a-z0-9_]+|cmp|fbclid|gclid|mc_cid|mc_eid)$/i;

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
 * @typedef {object} RawEntry
 * @property {string} title
 * @property {string} link
 * @property {string} published
 * @property {string} summary
 */

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

// ---------------------------------------------------------------------------------------------
// Safe parsing
// ---------------------------------------------------------------------------------------------

/**
 * Rejects XML that declares a DOCTYPE or ENTITY before any parsing (entity expansion attacks).
 * @param {string} text
 * @returns {string} the text without a byte order mark
 */
export function assertSafeFeed(text) {
  if (/<!DOCTYPE|<!ENTITY/i.test(text)) throw new Error('feed declares a DOCTYPE or ENTITY and was rejected');
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** fast-xml-parser options: attributes kept with an `@_` prefix, entities never expanded, text left as text. */
export const FEED_XML_OPTIONS = Object.freeze({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  processEntities: false,
  htmlEntities: false,
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
  /** @param {string} name @returns {boolean} */
  isArray: (name) => name === 'item' || name === 'entry' || name === 'link',
});

/** @param {unknown} v @returns {v is Record<string, unknown>} */
const isRecord = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * The text of a parsed element: a string, a number, or an element with attributes (`#text`).
 * @param {unknown} v
 * @returns {string}
 */
function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (Array.isArray(v)) return textOf(v[0]);
  if (isRecord(v) && typeof v['#text'] === 'string') return v['#text'];
  return '';
}

/**
 * Parse feed XML safely.
 * @param {string} text
 * @returns {Record<string, unknown>}
 */
export function parseFeedXml(text) {
  const parsed = new XMLParser({ ...FEED_XML_OPTIONS }).parse(assertSafeFeed(text));
  if (!isRecord(parsed)) throw new Error('feed is not XML');
  return parsed;
}

// ---------------------------------------------------------------------------------------------
// Plain text
// ---------------------------------------------------------------------------------------------

const NAMED_ENTITIES = Object.freeze(/** @type {Record<string, string>} */ ({
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', lsquo: '‘', rsquo: '’',
  ldquo: '“', rdquo: '”', hellip: '…', copy: '©', reg: '®', eacute: 'é', egrave: 'è',
  agrave: 'à', ccedil: 'ç', ocirc: 'ô', ntilde: 'ñ', uuml: 'ü', ouml: 'ö',
}));

/**
 * Decode the XML and common HTML entities once. Unknown names and invalid code points are left as written.
 * @param {string} s
 * @returns {string}
 */
export function decodeEntities(s) {
  return s.replace(/&(?:#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6})|([a-zA-Z][a-zA-Z0-9]{1,9}));/g, (whole, dec, hex, name) => {
    if (name) return Object.hasOwn(NAMED_ENTITIES, name) ? /** @type {string} */ (NAMED_ENTITIES[name]) : whole;
    const cp = dec ? Number(dec) : parseInt(hex, 16);
    if (!Number.isInteger(cp) || cp < 1 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return whole;
    return String.fromCodePoint(cp);
  });
}

/**
 * Remove markup. Script and style elements go with their content; comments and CDATA wrappers go; other tags
 * become a space so words in neighboring blocks do not run together.
 * @param {string} s
 * @returns {string}
 */
function stripTags(s) {
  return s
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<\/?[a-zA-Z!?][^>]*>/g, ' ');
}

/**
 * Control characters, bidirectional controls, zero-width marks, and the byte order mark have no place in a
 * headline or summary; each becomes a space (collapsed afterward). Works on UTF-16 code units; every range is
 * inside the Basic Multilingual Plane, so surrogate pairs pass through untouched.
 * @param {string} ch one code unit
 * @returns {string}
 */
function cleanChar(ch) {
  const c = ch.charCodeAt(0);
  const bad = c <= 8 || (c >= 0x0b && c <= 0x1f) || (c >= 0x7f && c <= 0x9f) || (c >= 0x200b && c <= 0x200f)
    || (c >= 0x202a && c <= 0x202e) || (c >= 0x2066 && c <= 0x2069) || c === 0xfeff;
  return bad ? ' ' : ch;
}

/**
 * Plain text from feed text that may be escaped or literal HTML: entities decoded, markup removed (twice,
 * so markup that was itself escaped is also removed), entities decoded again, control characters removed,
 * whitespace collapsed, then truncated on a character boundary with an ellipsis.
 * @param {unknown} raw
 * @param {number} max
 * @returns {string}
 */
export function toPlainText(raw, max) {
  let s = typeof raw === 'string' ? raw : textOf(raw);
  s = decodeEntities(stripTags(decodeEntities(stripTags(s))));
  s = stripTags(s)
    .split('').map(cleanChar).join('')
    .replace(/\s+/g, ' ')
    .trim();
  return truncate(s, max);
}

/**
 * Cut to `max` characters (code points), ending in an ellipsis when cut.
 * @param {string} s
 * @param {number} max
 * @returns {string}
 */
export function truncate(s, max) {
  const chars = Array.from(s);
  if (chars.length <= max) return s;
  return `${chars.slice(0, max - 1).join('').trimEnd()}…`;
}

const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;
const PHONE_SOURCE = String.raw`(?<!\d)(?:\+?1[ .-]?)?\(?[2-9]\d{2}\)?[ .-]?\d{3}[ .-]?\d{4}(?!\d)`;
const EMAIL_SOURCE = String.raw`[\w.+-]+@[\w-]+(?:\.[\w-]+)+`;
const PHONE = new RegExp(PHONE_SOURCE, 'g');
const CONTACT_BLOCK = new RegExp(String.raw`(?:media\s+)?contacts?\s*:[\s\S]*?(?:${EMAIL_SOURCE}|${PHONE_SOURCE})`, 'gi');

/**
 * Remove press-contact blocks and any email address or telephone number from a summary. Government press
 * releases open with "Contact: <name> <phone> <email>"; a news summary shows the story, and contacts
 * belong to the reviewed Contacts page, so no person's name or number is published here. The block is cut
 * from the label through the last email address or telephone number that follows it.
 * @param {string} text plain text
 * @returns {string}
 */
export function scrubContactLines(text) {
  return text.replace(CONTACT_BLOCK, ' ').replace(EMAIL, ' ').replace(PHONE, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Summary text: plain text, contacts scrubbed, then cut to the summary limit.
 * @param {unknown} raw
 * @returns {string}
 */
export function summaryText(raw) {
  return truncate(scrubContactLines(toPlainText(raw, Number.MAX_SAFE_INTEGER)), SUMMARY_MAX);
}

// ---------------------------------------------------------------------------------------------
// Links
// ---------------------------------------------------------------------------------------------

/**
 * Classify one link. Pure.
 *   { url, upgrade: false }  an https link, tracking parameters and fragment removed
 *   { url, upgrade: true }   an http link whose https form still has to answer
 *   { url: null, reason }    dropped: invalid, a non-web scheme, or credentials in the address
 * @param {unknown} raw
 * @returns {{ url: string, upgrade: boolean } | { url: null, reason: 'invalid' | 'scheme' | 'credentials' }}
 */
export function classifyLink(raw) {
  const text = decodeEntities(typeof raw === 'string' ? raw : textOf(raw)).trim();
  let u;
  try { u = new URL(text); } catch { return { url: null, reason: 'invalid' }; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return { url: null, reason: 'scheme' };
  if (u.username || u.password) return { url: null, reason: 'credentials' };
  const upgrade = u.protocol === 'http:';
  u.protocol = 'https:';
  u.hash = '';
  for (const key of [...u.searchParams.keys()]) if (TRACKING_PARAM.test(key)) u.searchParams.delete(key);
  if (u.port === '80' || u.port === '443') u.port = '';
  return { url: u.toString(), upgrade };
}

/**
 * First 16 hex characters of the SHA-256 of the canonical link.
 * @param {string} canonicalUrl
 * @returns {string}
 */
export function itemId(canonicalUrl) {
  return createHash('sha256').update(canonicalUrl).digest('hex').slice(0, 16);
}

/**
 * The https address for one raw link, or null when the item must be dropped. An http link is upgraded only
 * when the https address answers a HEAD request through `head`.
 * @param {unknown} raw
 * @param {(url: string) => Promise<boolean>} head true when the https address answered
 * @returns {Promise<{ url: string | null, upgraded: boolean, reason?: string }>}
 */
export async function resolveLink(raw, head) {
  const c = classifyLink(raw);
  if (c.url === null) return { url: null, upgraded: false, reason: c.reason };
  if (!c.upgrade) return { url: c.url, upgraded: false };
  let answered = false;
  try { answered = await head(c.url); } catch { answered = false; }
  return answered ? { url: c.url, upgraded: true } : { url: null, upgraded: false, reason: 'http-unanswered' };
}

// ---------------------------------------------------------------------------------------------
// Feeds
// ---------------------------------------------------------------------------------------------

/**
 * ISO instant for a feed date (RFC 822 or ISO 8601), or null.
 * @param {unknown} v
 * @returns {string | null}
 */
export function feedDate(v) {
  const s = textOf(v).trim();
  if (!s) return null;
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

/**
 * The alternate link of an Atom entry.
 * @param {unknown} links
 * @returns {string}
 */
function atomLink(links) {
  const list = Array.isArray(links) ? links : [links];
  for (const l of list) {
    if (!isRecord(l)) continue;
    const rel = l['@_rel'];
    if ((rel === undefined || rel === 'alternate') && typeof l['@_href'] === 'string') return l['@_href'];
  }
  return '';
}

/**
 * Raw entries of a parsed feed: title, link, date, and summary text before any cleaning.
 * @param {Record<string, unknown>} tree
 * @param {NewsSource['feedFormat']} format
 * @returns {RawEntry[]}
 * @throws {Error} when the document is not a feed of the declared kind
 */
export function extractEntries(tree, format) {
  if (format === 'rss') {
    const channel = isRecord(tree.rss) ? tree.rss.channel : undefined;
    if (!isRecord(channel)) throw new Error('not an RSS feed');
    const items = /** @type {unknown[]} */ (Array.isArray(channel.item) ? channel.item : []);
    return items.filter(isRecord).map((it) => {
      const guid = isRecord(it.guid) && it.guid['@_isPermaLink'] === 'false' ? '' : textOf(it.guid);
      return {
        title: textOf(it.title),
        link: textOf(it.link) || guid,
        published: textOf(it.pubDate) || textOf(it['dc:date']),
        summary: textOf(it.description) || textOf(it['content:encoded']),
      };
    });
  }
  if (format === 'atom' || format === 'youtube-atom') {
    const feed = tree.feed;
    if (!isRecord(feed)) throw new Error('not an Atom feed');
    const entries = /** @type {unknown[]} */ (Array.isArray(feed.entry) ? feed.entry : []);
    return entries.filter(isRecord).map((e) => ({
      title: textOf(e.title),
      link: atomLink(e.link),
      published: textOf(e.published) || textOf(e.updated),
      // YouTube descriptions are promotion and links; the dashboard shows the title and a link only.
      summary: format === 'youtube-atom' ? '' : textOf(e.summary) || textOf(e.content),
    }));
  }
  throw new Error(`feed format "${format}" is not fetched`);
}

/**
 * Turn raw entries into schema items for one source. Newest first, inside the age window, capped at
 * `maxItems`; links resolved through `head`.
 * @param {RawEntry[]} entries
 * @param {NewsSource} source
 * @param {{ now: Date, head: (url: string) => Promise<boolean> }} ctx
 * @returns {Promise<{ items: NewsItem[], counts: Record<string, number> }>}
 */
export async function buildItems(entries, source, ctx) {
  const maxItems = source.maxItems ?? DEFAULT_MAX_ITEMS;
  const maxAgeMs = (source.maxAgeDays ?? DEFAULT_MAX_AGE_DAYS) * DAY_MS;
  const nowMs = ctx.now.getTime();
  const counts = { entries: entries.length, undated: 0, outsideWindow: 0, noTitle: 0, linksDropped: 0, linksUpgraded: 0, duplicates: 0 };
  /** @type {(RawEntry & { iso: string })[]} */
  const dated = [];
  for (const e of entries) {
    const iso = feedDate(e.published);
    if (!iso) { counts.undated += 1; continue; }
    const t = Date.parse(iso);
    if (t < nowMs - maxAgeMs || t > nowMs + FUTURE_SLACK_MS) { counts.outsideWindow += 1; continue; }
    dated.push({ ...e, iso });
  }
  dated.sort((a, b) => (a.iso < b.iso ? 1 : a.iso > b.iso ? -1 : 0));

  /** @type {NewsItem[]} */
  const items = [];
  const seen = new Set();
  let checks = 0;
  for (const e of dated) {
    if (items.length >= maxItems) break;
    const title = toPlainText(e.title, TITLE_MAX);
    if (!title) { counts.noTitle += 1; continue; }
    const c = classifyLink(e.link);
    if (c.url !== null && c.upgrade && checks >= MAX_UPGRADE_CHECKS) { counts.linksDropped += 1; continue; }
    if (c.url !== null && c.upgrade) checks += 1;
    const link = await resolveLink(e.link, ctx.head);
    if (link.url === null) { counts.linksDropped += 1; continue; }
    if (link.upgraded) counts.linksUpgraded += 1;
    const id = itemId(link.url);
    if (seen.has(id)) { counts.duplicates += 1; continue; }
    seen.add(id);
    items.push({
      id, sourceId: source.id, title, url: link.url, published: e.iso,
      summary: summaryText(e.summary), kind: source.kind, regions: [...source.regions],
    });
  }
  return { items, counts };
}

// ---------------------------------------------------------------------------------------------
// Source lists
// ---------------------------------------------------------------------------------------------

/**
 * data/news-sources.yaml.
 * @param {string} [root]
 * @returns {Promise<NewsSource[]>}
 */
export async function loadNewsSources(root = ROOT) {
  const doc = loadYaml(await readFile(path.join(root, 'data', 'news-sources.yaml'), 'utf8'), { schema: CORE_SCHEMA });
  if (!Array.isArray(doc)) throw new Error('data/news-sources.yaml is not a list');
  return /** @type {NewsSource[]} */ (doc.map((s) => ({ ...s, verifiedAt: String(s.verifiedAt) })));
}

/**
 * Request headers and timeout from the source record, so the record stays the one place they are written.
 * @param {string} id
 * @param {string} [root]
 * @returns {Promise<{ headers?: Record<string, string>, timeoutMs?: number }>}
 */
export async function requestOptionsFor(id, root = ROOT) {
  try {
    const rec = /** @type {any} */ (loadYaml(await readFile(path.join(root, 'data', 'sources', `${id}.yaml`), 'utf8'), { schema: CORE_SCHEMA }));
    /** @type {{ headers?: Record<string, string>, timeoutMs?: number }} */
    const out = {};
    if (isRecord(rec?.access?.headers)) out.headers = /** @type {Record<string, string>} */ (rec.access.headers);
    if (typeof rec?.access?.timeoutMs === 'number') out.timeoutMs = rec.access.timeoutMs;
    return out;
  } catch { return {}; }
}

// ---------------------------------------------------------------------------------------------
// The task
// ---------------------------------------------------------------------------------------------

/**
 * @param {NewsSource[]} sources
 * @returns {NewsSource[]}
 */
export const feedSources = (sources) => sources.filter((s) => s.feed !== null && s.feedFormat !== 'none' && s.kind !== 'community');

/**
 * Build the envelope. Separated from `run` so tests can drive it with a scripted http client.
 * @param {SnapshotContext} ctx
 * @param {NewsSource[]} sources
 * @param {(id: string) => Promise<{ headers?: Record<string, string>, timeoutMs?: number }>} [optionsFor]
 * @returns {Promise<Envelope>}
 */
export async function buildNewsEnvelope(ctx, sources, optionsFor = requestOptionsFor) {
  const at = ctx.now.toISOString();
  const feeds = feedSources(sources);
  const ids = feeds.map((s) => s.id);
  const previous = await ctx.previous('news.json').catch(() => null);
  const previousItems = /** @type {NewsItem[]} */ (Array.isArray(previous?.items) ? previous.items : []);
  const previousStatus = previous?.perSource ?? {};
  /** @type {Record<string, import('../../../site/static/js/types.js').LivePerSource>} */
  const perSource = {};
  /** @type {Record<string, number>} */
  const diagnostics = {};
  /** @type {NewsItem[]} */
  const items = [];
  let okCount = 0;
  /** @type {string | null} */
  let asOf = null;

  await Promise.all(feeds.map(async (source) => {
    const feed = /** @type {string} */ (source.feed);
    const opts = await optionsFor(source.id);
    const res = await ctx.http.getText(source.id, feed, opts);
    /** @type {string | null} */
    let failureText = null;
    /** @type {{ items: NewsItem[], counts: Record<string, number> } | null} */
    let built = null;
    if (!res.ok) {
      failureText = `${res.error.kind}: ${res.error.message}`;
    } else {
      try {
        const entries = extractEntries(parseFeedXml(res.data), source.feedFormat);
        built = await buildItems(entries, source, {
          now: ctx.now,
          head: async (url) => (await ctx.http.head(source.id, url, { timeoutMs: 8000 })).ok,
        });
      } catch (e) {
        failureText = `parse: ${e instanceof Error ? e.message : String(e)}`;
      }
    }
    if (built && res.ok) {
      okCount += 1;
      items.push(...built.items);
      perSource[source.id] = { ok: true, count: built.items.length, asOf: res.fetchedAt, completeness: 'complete', carriedForward: false };
      for (const [k, v] of Object.entries(built.counts)) diagnostics[`${k}:${source.id}`] = v;
      if (!asOf || res.fetchedAt > asOf) asOf = res.fetchedAt;
    } else {
      const cutoff = ctx.now.getTime() - (source.maxAgeDays ?? DEFAULT_MAX_AGE_DAYS) * DAY_MS;
      const kept = previousItems.filter((i) => i.sourceId === source.id && Date.parse(i.published) >= cutoff);
      items.push(...kept);
      const before = previousStatus[source.id];
      perSource[source.id] = {
        ok: false, count: kept.length, asOf: before?.asOf ?? null, completeness: 'rejected', carriedForward: kept.length > 0,
      };
      diagnostics[`failed:${source.id}`] = 1;
      ctx.log(`news: ${source.id} failed (${failureText})`);
    }
  }));

  items.sort((a, b) => (a.published < b.published ? 1 : a.published > b.published ? -1 : a.id < b.id ? -1 : 1));
  const failed = feeds.length - okCount;
  /** @type {Envelope['completeness']} */
  const completeness = okCount === 0 ? 'rejected' : failed > 0 ? 'partial' : 'complete';
  return {
    schema: 'cthd.live.news/1',
    id: 'news',
    sourceIds: ids,
    generatedAt: at,
    observedAt: at,
    asOf: okCount === 0 ? null : asOf,
    asOfBasis: okCount === 0 ? null : 'retrieved',
    completeness,
    carriedForward: false,
    failure: okCount === 0 ? { code: 'upstream', message: 'No news feed could be read.', at } : null,
    perSource,
    diagnostics: { feeds: feeds.length, feedsFailed: failed, ...diagnostics },
    items: okCount === 0 ? [] : items,
  };
}

/** @type {import('../../../site/static/js/types.js').SnapshotTask} */
export default {
  id: 'news',
  sourceIds: ['news-idaho-oem', 'news-opb', 'news-kiro7', 'news-global-bc', 'news-cbc-bc', 'news-youtube-pnwwx'],
  cadenceMin: 30,
  outputs: ['news.json'],
  async run(ctx) {
    const at = ctx.now.toISOString();
    try {
      return { 'news.json': await buildNewsEnvelope(ctx, await loadNewsSources()) };
    } catch (e) {
      return {
        'news.json': {
          schema: 'cthd.live.news/1', id: 'news', sourceIds: ['news-opb'], generatedAt: at, observedAt: at, asOf: null, asOfBasis: null,
          completeness: 'rejected', carriedForward: false,
          failure: { code: 'task', message: e instanceof Error ? e.message : String(e), at },
          perSource: { 'news-opb': { ok: false, count: 0, asOf: null } }, diagnostics: {}, items: [],
        },
      };
    }
  },
};
