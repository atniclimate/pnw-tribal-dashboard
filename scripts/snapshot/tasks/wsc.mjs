// @ts-check
/**
 * Snapshot task `wsc` (blueprint 6.4): latest level and discharge for British Columbia Water Survey of Canada
 * stations in the committed reference list. One windowed request per run (ECCC request-volume courtesy),
 * paged by offset only when the window holds more than one page. No flood categories exist and none are made.
 */
import { normalizeWscRealtime } from '../../../site/static/js/hydro/wsc.js';

const SOURCE_ID = 'eccc-hydrometric-realtime';
const BASE = 'https://api.weather.gc.ca/collections/hydrometric-realtime/items';
const WINDOW_MS = 2 * 60 * 60 * 1000;
const PAGE = 10000;
const MAX_PAGES = 3;

/**
 * @param {Date} now
 * @param {number} offset
 * @returns {string}
 */
export function realtimeUrl(now, offset) {
  const from = new Date(now.getTime() - WINDOW_MS).toISOString().replace(/\.\d{3}Z$/, 'Z');
  return `${BASE}?f=json&limit=${PAGE}&offset=${offset}&PROV_TERR_STATE_LOC=BC&datetime=${from}/..`;
}

/** @type {import('../../../site/static/js/types.js').SnapshotTask} */
export default {
  id: 'wsc',
  sourceIds: [SOURCE_ID],
  cadenceMin: 30,
  outputs: ['wsc-status.json'],
  async run(ctx) {
    const at = ctx.now.toISOString();
    /** @type {Set<string> | null} */
    let wanted = null;
    try {
      const ref = /** @type {{ stations?: { id: string }[] } | null} */ (await ctx.reference('wsc-stations.json'));
      if (ref && Array.isArray(ref.stations) && ref.stations.length > 0) wanted = new Set(ref.stations.map((s) => s.id));
    } catch { /* no reference yet */ }

    /** @type {unknown[]} */
    const features = [];
    let failure = '';
    let truncated = false;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const res = await ctx.http.getJson(SOURCE_ID, realtimeUrl(ctx.now, page * PAGE), { timeoutMs: 60000 });
      if (!res.ok) { failure = `${res.error.kind}: ${res.error.message}`; break; }
      const data = /** @type {{ features?: unknown[], numberMatched?: number }} */ (res.data);
      if (!data || !Array.isArray(data.features)) { failure = 'parse: features array missing'; break; }
      features.push(...data.features);
      const matched = typeof data.numberMatched === 'number' ? data.numberMatched : features.length;
      if (features.length >= matched) break;
      if (page === MAX_PAGES - 1) truncated = true;
    }
    const ok = failure === '' && features.length > 0;
    /** @type {import('../../../site/static/js/types.js').GaugeStatus[]} */
    let items = [];
    if (ok) {
      items = normalizeWscRealtime({ features }, { fetchedAt: at }).filter((s) => wanted === null || wanted.has(s.id));
      if (wanted) {
        // A station with no reading in the window still appears, as "No current reading", never as a zero.
        const have = new Set(items.map((i) => i.id));
        for (const id of [...wanted].sort()) if (!have.has(id)) items.push({ id, observed: null, forecast: null });
        items.sort((a, b) => (a.id < b.id ? -1 : 1));
      }
    }
    const times = items.map((i) => i.observed?.validTime).filter((t) => typeof t === 'string').sort();
    const asOf = times.length ? /** @type {string} */ (times[times.length - 1]) : null;
    return {
      'wsc-status.json': {
        schema: 'cthd.live.wsc-status/1',
        id: 'wsc',
        sourceIds: [SOURCE_ID],
        generatedAt: at,
        observedAt: at,
        asOf: ok ? asOf : null,
        asOfBasis: ok && asOf ? 'observed' : null,
        completeness: !ok ? 'rejected' : truncated ? 'partial' : 'complete',
        carriedForward: false,
        failure: ok ? null : { code: 'upstream', message: failure || 'no readings in the window', at },
        perSource: { [SOURCE_ID]: { ok, count: items.length, asOf: ok ? asOf : null } },
        diagnostics: {
          rows: features.length,
          stations: items.length,
          noReading: items.filter((i) => !i.observed || (i.observed.stage === null && i.observed.flow === null)).length,
        },
        items: ok ? items : [],
      },
    };
  },
};
