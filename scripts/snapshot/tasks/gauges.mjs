// @ts-check
/**
 * Snapshot task `gauges` (blueprint 6.4): NWPS observed and forecast status with the NWS category, slimmed to
 * the gauges in the committed reference list. Never throws for upstream failures; returns a rejected
 * envelope instead so the runner can carry the previous copy forward.
 */
import { normalizeNwpsGaugeList } from '../../../site/static/js/hydro/nwps.js';

/** @typedef {import('../../../site/static/js/types.js').GaugeStatus} GaugeStatus */

const SOURCE_ID = 'nwps-gauges';
const NWPS_BASE = 'https://api.water.noaa.gov/nwps/v1/gauges';

/** Tiles over the working footprint (Washington, Oregon, Idaho) for the NWPS bbox list; see blueprint 3.7.3. */
export const FOOTPRINT_TILES = Object.freeze([
  { xmin: -125.0, ymin: 42.0, xmax: -118.0, ymax: 45.6 },
  { xmin: -125.0, ymin: 45.6, xmax: -118.0, ymax: 49.2 },
  { xmin: -118.0, ymin: 42.0, xmax: -111.0, ymax: 45.6 },
  { xmin: -118.0, ymin: 45.6, xmax: -111.0, ymax: 49.2 },
]);

/**
 * Bbox list URL for one tile (the snapshot task and the reference build share it).
 * @param {{ xmin: number, ymin: number, xmax: number, ymax: number }} tile
 * @returns {string}
 */
export function nwpsBboxUrl(tile) {
  return `${NWPS_BASE}?bbox.xmin=${tile.xmin}&bbox.ymin=${tile.ymin}&bbox.xmax=${tile.xmax}&bbox.ymax=${tile.ymax}&srid=EPSG_4326`;
}

/**
 * @param {string} lid
 * @returns {string}
 */
export function nwpsDetailUrl(lid) {
  if (!/^[A-Za-z0-9]{5}$/.test(lid)) throw new Error(`invalid NWPS lid "${lid}"`);
  return `${NWPS_BASE}/${lid.toUpperCase()}`;
}

/** @type {import('../../../site/static/js/types.js').SnapshotTask} */
export default {
  id: 'gauges',
  sourceIds: [SOURCE_ID],
  cadenceMin: 15,
  outputs: ['gauges-status.json'],
  async run(ctx) {
    const at = ctx.now.toISOString();
    /** @type {Set<string> | null} */
    let wanted = null;
    try {
      const ref = /** @type {{ gauges?: { id: string }[] } | null} */ (await ctx.reference('gauges.json'));
      if (ref && Array.isArray(ref.gauges) && ref.gauges.length > 0) wanted = new Set(ref.gauges.map((g) => g.id));
    } catch { /* no reference yet: keep every footprint gauge the list returns */ }

    /** @type {Map<string, GaugeStatus>} */
    const byId = new Map();
    let tilesOk = 0;
    let firstError = '';
    for (const tile of FOOTPRINT_TILES) {
      const res = await ctx.http.getJson(SOURCE_ID, nwpsBboxUrl(tile), { timeoutMs: 30000 });
      if (!res.ok) { firstError ||= `${res.error.kind}: ${res.error.message}`; continue; }
      try {
        for (const s of normalizeNwpsGaugeList(res.data, { fetchedAt: res.fetchedAt, now: ctx.now })) {
          if (wanted === null || wanted.has(s.id)) byId.set(s.id, s);
        }
        tilesOk += 1;
      } catch (e) {
        firstError ||= `parse: ${/** @type {Error} */ (e).message}`;
      }
    }
    const items = [...byId.values()].sort((a, b) => (a.id < b.id ? -1 : 1));
    const times = items.map((i) => i.observed?.validTime).filter((t) => typeof t === 'string').sort();
    const asOf = times.length ? /** @type {string} */ (times[times.length - 1]) : null;
    const diagnostics = {
      tiles: FOOTPRINT_TILES.length,
      tilesOk,
      gauges: items.length,
      outOfService: items.filter((i) => i.observed?.category === 'out_of_service').length,
      notDefined: items.filter((i) => i.observed?.category === 'not_defined').length,
      noObservation: items.filter((i) => !i.observed || i.observed.validTime === null).length,
      missingFromReference: wanted ? [...wanted].filter((id) => !byId.has(id)).length : 0,
    };
    const rejected = tilesOk === 0;
    const complete = tilesOk === FOOTPRINT_TILES.length;
    return {
      'gauges-status.json': {
        schema: 'cthd.live.gauges-status/1',
        id: 'gauges',
        sourceIds: [SOURCE_ID],
        generatedAt: at,
        observedAt: at,
        asOf: rejected ? null : asOf,
        asOfBasis: rejected || asOf === null ? null : 'valid',
        completeness: rejected ? 'rejected' : complete ? 'complete' : 'partial',
        carriedForward: false,
        failure: rejected ? { code: 'upstream', message: firstError || 'no tile returned', at } : null,
        perSource: { [SOURCE_ID]: { ok: !rejected, count: items.length, asOf: rejected ? null : asOf } },
        diagnostics,
        items: rejected ? [] : items,
      },
    };
  },
};
