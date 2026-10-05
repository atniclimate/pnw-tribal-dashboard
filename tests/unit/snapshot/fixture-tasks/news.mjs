// @ts-check
/**
 * Test-only snapshot task: a deliberately small news task over the dated OPB RSS capture
 * (tests/fixtures/upstream/news-opb/2026-10-05-rss.xml), so the runner can be proven before lane L14's
 * real news task lands. Items come from the capture; nothing is invented. Owner: lane L9.
 */
import { createHash } from 'node:crypto';
import { XMLParser } from 'fast-xml-parser';

export const FEED_URL = 'https://www.opb.org/arc/outboundfeeds/rss/?outputType=xml';

/** @param {unknown} v */
const plain = (v) => String(v ?? '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();

/** @type {import('../../../../site/static/js/types.js').SnapshotTask} */
export default {
  id: 'news',
  sourceIds: ['news-opb'],
  cadenceMin: 30,
  outputs: ['news.json'],
  async run(ctx) {
    const r = await ctx.http.getText('news-opb', FEED_URL);
    const base = { schema: /** @type {const} */ ('cthd.live.news/1'), id: 'news', sourceIds: ['news-opb'], generatedAt: ctx.now.toISOString(),
      carriedForward: false, diagnostics: {} };
    if (!r.ok) {
      return { 'news.json': { ...base, observedAt: r.fetchedAt, asOf: null, asOfBasis: null, completeness: 'rejected',
        failure: { code: r.error.kind, message: r.error.message, at: r.fetchedAt }, perSource: { 'news-opb': { ok: false, count: 0, asOf: null } }, items: [] } };
    }
    const feed = new XMLParser({ processEntities: true }).parse(r.data);
    const raw = /** @type {Record<string, unknown>[]} */ ([feed?.rss?.channel?.item ?? []].flat());
    const items = raw.flatMap((it) => {
      const url = String(it.link ?? '');
      const published = new Date(String(it.pubDate ?? ''));
      if (!url.startsWith('https://') || Number.isNaN(published.getTime())) return [];
      return [{ id: createHash('sha256').update(url).digest('hex').slice(0, 16), sourceId: 'news-opb', title: plain(it.title).slice(0, 200) || url,
        url, published: published.toISOString(), summary: plain(it.description).slice(0, 280), kind: /** @type {const} */ ('media'), regions: ['OR'] }];
    }).slice(0, 20);
    const asOf = items.map((i) => i.published).sort().pop() ?? null;
    return { 'news.json': { ...base, observedAt: r.fetchedAt, asOf, asOfBasis: asOf ? 'issued' : null, completeness: 'complete', failure: null,
      perSource: { 'news-opb': { ok: true, count: items.length, asOf } }, diagnostics: { dropped: raw.length - items.length }, items } };
  },
};
