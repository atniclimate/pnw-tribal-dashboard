// @ts-check
/**
 * Snapshot task `tsunami` (blueprint 3.7.2, 6.4): the National Tsunami Warning Center Atom feed, which has
 * no CORS header, normalized into `DashboardAlert` items in `tsunami.json`.
 *
 * Hardened XML: a feed that declares a DOCTYPE or ENTITY is rejected before parsing, and the parser never
 * expands entities. Never throws for upstream failures; returns a rejected envelope instead so the runner
 * carries the previous copy forward.
 *
 * `asOf` is the retrieval time (`asOfBasis: 'retrieved'`): the feed's own `updated` stamp is the issue time
 * of its latest product, which can be days old in quiet times, so it says nothing about whether the feed
 * is current. Each item keeps its issue time in `sent`.
 */
import { XMLParser } from 'fast-xml-parser';
import { assertSafeXml, normalizeNtwcFeed, NTWC_SOURCE_ID, NTWC_XML_OPTIONS } from '../../../site/static/js/alerts/ntwc.js';

/** @typedef {import('../../../site/static/js/types.js').LiveEnvelope<unknown>} Envelope */

export const NTWC_URL = 'https://www.tsunami.gov/events/xml/PAAQAtom.xml';

/**
 * Parse the Atom text with the hardened options.
 * @param {string} text
 * @returns {unknown}
 */
export function parseNtwcXml(text) {
  assertSafeXml(text);
  return new XMLParser({ ...NTWC_XML_OPTIONS }).parse(text);
}

/** @type {import('../../../site/static/js/types.js').SnapshotTask} */
export default {
  id: 'tsunami',
  sourceIds: [NTWC_SOURCE_ID],
  cadenceMin: 10,
  outputs: ['tsunami.json'],
  async run(ctx) {
    const at = ctx.now.toISOString();
    /** @param {string} code @param {string} message @returns {Record<string, Envelope>} */
    const rejected = (code, message) => ({
      'tsunami.json': {
        schema: 'cthd.live.tsunami/1', id: 'tsunami', sourceIds: [NTWC_SOURCE_ID], generatedAt: at, observedAt: at,
        asOf: null, asOfBasis: null, completeness: 'rejected', carriedForward: false, failure: { code, message, at },
        perSource: { [NTWC_SOURCE_ID]: { ok: false, count: 0, asOf: null } }, diagnostics: {}, items: [],
      },
    });
    const res = await ctx.http.getText(NTWC_SOURCE_ID, NTWC_URL, { timeoutMs: 20000 });
    if (!res.ok) return rejected('upstream', `${res.error.kind}: ${res.error.message}`);
    /** @type {unknown} */
    let parsed;
    try {
      parsed = parseNtwcXml(res.data);
    } catch (e) {
      return rejected('parse', e instanceof Error ? e.message : String(e));
    }
    const { alerts, diagnostics } = normalizeNtwcFeed(parsed, { fetchedAt: res.fetchedAt, now: ctx.now });
    if (Number(diagnostics.collectionRejected ?? 0) > 0) return rejected('parse', 'the response is not an Atom feed');
    const failed = diagnostics.itemsFailed > 0;
    /** @type {Record<string, number>} */
    const diag = {};
    for (const [k, v] of Object.entries(diagnostics)) diag[k] = typeof v === 'boolean' ? Number(v) : v;
    const asOf = res.fetchedAt;
    return {
      'tsunami.json': {
        schema: 'cthd.live.tsunami/1',
        id: 'tsunami',
        sourceIds: [NTWC_SOURCE_ID],
        generatedAt: at,
        observedAt: at,
        asOf,
        asOfBasis: 'retrieved',
        completeness: failed ? 'partial' : 'complete',
        carriedForward: false,
        failure: null,
        perSource: { [NTWC_SOURCE_ID]: { ok: true, count: alerts.length, asOf } },
        diagnostics: { ...diag, [`partial:${NTWC_SOURCE_ID}`]: failed ? 1 : 0, [`itemsFailed:${NTWC_SOURCE_ID}`]: diagnostics.itemsFailed },
        items: alerts,
      },
    };
  },
};
