// @ts-check
/**
 * Snapshot task `declarations` (blueprint 5.7, 5.10, 6.4): OpenFEMA DisasterDeclarationsSummaries for the
 * footprint states over 730 days, paged with `$skip` until a page comes back short (no silent `$top` cap),
 * grouped per `femaDeclarationString`, and matched to registry Nations by designated area.
 *
 * Grouping is the browser module's own (`site/static/js/declarations/openfema.js`), so the scheduled copy
 * and the direct fallback in the browser apply identical rules. The task never infers that a declaration is
 * "active" and never invents a row: a failed page rejects the whole file, so the runner carries the previous
 * complete copy forward (or, with none, the client renders Unavailable). A footprint county list or a
 * registry that cannot be read makes the file `partial` and says why in `diagnostics`.
 */
import { FEMA_PAGE_SIZE, femaQueryParams, groupFema } from '../../../site/static/js/declarations/openfema.js';
import { failure, rejectedEnvelope } from '../../lib/live.mjs';

/** @typedef {import('../../../site/static/js/types.js').LiveEnvelope<unknown>} Envelope */

export const OPENFEMA_SOURCE_ID = 'openfema-declarations';
export const OPENFEMA_BASE = 'https://www.fema.gov/api/open/v2/DisasterDeclarationsSummaries';
/** Ten pages of one thousand rows; a full last page means the set is partial. */
export const MAX_PAGES = 10;
const OUTPUT = 'declarations-fema.json';

/**
 * The request URL for one page, as the fixture captures record it.
 * @param {Date} now
 * @param {number} skip
 * @returns {string}
 */
export function femaUrl(now, skip) {
  return `${OPENFEMA_BASE}?${new URLSearchParams(femaQueryParams(now, skip)).toString()}`;
}

/** @param {unknown} v @returns {v is Record<string, unknown>} */
function isRecord(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** @type {import('../../../site/static/js/types.js').SnapshotTask} */
const task = {
  id: 'declarations',
  sourceIds: [OPENFEMA_SOURCE_ID],
  cadenceMin: 60,
  outputs: [OUTPUT],
  async run(ctx) {
    const now = ctx.now;
    const at = now.toISOString();
    /** @type {unknown[]} */
    const rows = [];
    let pages = 0;
    let truncated = false;
    let fetchedAt = at;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const res = await ctx.http.getJson(OPENFEMA_SOURCE_ID, femaUrl(now, page * FEMA_PAGE_SIZE), { timeoutMs: 60_000 });
      if (!res.ok) {
        const message = `${res.error.kind}: ${res.error.message}`;
        ctx.log(`${OPENFEMA_SOURCE_ID}: page ${page + 1} failed (${message})`);
        return { [OUTPUT]: rejectedEnvelope(task, OUTPUT, failure(res.error.kind, message, now), now) };
      }
      const batch = isRecord(res.data) && Array.isArray(res.data.DisasterDeclarationsSummaries) ? res.data.DisasterDeclarationsSummaries : null;
      if (batch === null) {
        return { [OUTPUT]: rejectedEnvelope(task, OUTPUT, failure('parse', 'OpenFEMA returned an unexpected format', now), now) };
      }
      pages += 1;
      fetchedAt = res.fetchedAt;
      rows.push(...batch);
      if (batch.length < FEMA_PAGE_SIZE) break;
      if (page === MAX_PAGES - 1) truncated = true;
    }

    const nations = Array.isArray(ctx.registry?.index?.nations) ? ctx.registry.index.nations : [];
    /** @type {unknown} */
    let footprint = null;
    try { footprint = await ctx.reference('footprint-ugc.json'); } catch { footprint = null; }
    const zones = isRecord(footprint) && Array.isArray(footprint.zones) ? footprint.zones : null;
    const counties = zones ? new Set(zones.filter((z) => typeof z === 'string' && z.startsWith('county:')).map((z) => String(z).slice('county:'.length))) : null;

    const grouped = groupFema(rows, { nations, footprintCountyCodes: counties });
    const partial = truncated || nations.length === 0 || counties === null;
    const asOf = grouped.latestRefresh;
    /** @type {Envelope} */
    const envelope = {
      schema: 'cthd.live.declarations-fema/1',
      id: 'declarations',
      sourceIds: [OPENFEMA_SOURCE_ID],
      generatedAt: at,
      observedAt: fetchedAt,
      asOf,
      asOfBasis: asOf === null ? null : 'issued',
      completeness: partial ? 'partial' : 'complete',
      carriedForward: false,
      failure: null,
      perSource: { [OPENFEMA_SOURCE_ID]: { ok: true, count: grouped.items.length, asOf } },
      diagnostics: {
        rows: rows.length,
        pages,
        skippedRows: grouped.skipped,
        truncated: truncated ? 1 : 0,
        registryUnavailable: nations.length === 0 ? 1 : 0,
        footprintCountiesUnavailable: counties === null ? 1 : 0,
        tribalRequests: grouped.items.filter((d) => d.tribalRequest).length,
        unmatchedTribalAreas: grouped.items.filter((d) => d.unmatchedTribalArea !== null).length,
      },
      items: grouped.items,
    };
    return { [OUTPUT]: envelope };
  },
};

export default task;
