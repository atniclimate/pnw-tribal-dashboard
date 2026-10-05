// @ts-check
/**
 * Snapshot task `bc-hazards` (blueprint 3.7.2, 6.4): British Columbia provincial streams, all registry
 * `candidate` sources that stay hidden in the browser until the maintainer approves them (Q8):
 * BC River Forecast Centre advisories (active basins only), EMCR evacuation orders and alerts, and EMBC
 * tsunami notification zones (attributes only). Never merged into alert counts.
 *
 * Each source stands alone; a failed source contributes no items and the envelope is `partial` (or
 * `rejected` when every source fails, so the runner carries the previous copy forward). An ArcGIS response
 * with `exceededTransferLimit` is partial. `asOf` is the retrieval time (`asOfBasis: 'retrieved'`): these
 * layers publish edit dates per record, not a time for the layer as a whole.
 */
import { normalizeRfcAdvisories, BC_RFC_SOURCE_ID } from '../../../site/static/js/bc/rfc-advisories.js';
import { normalizeEvacuations, EMCR_SOURCE_ID } from '../../../site/static/js/bc/evacuations.js';
import { normalizeTsunamiNotifications, EMBC_TSUNAMI_SOURCE_ID } from '../../../site/static/js/bc/tsunami.js';
import { nationIdsForGeometry } from '../../../site/static/js/alerts/relevance.js';
import { loadNations } from './alerts.mjs';

/** @typedef {import('../../../site/static/js/types.js').BcHazardItem} BcHazardItem */
/** @typedef {import('../../../site/static/js/types.js').LiveEnvelope<unknown>} Envelope */

const BASE = 'https://services6.arcgis.com/ubm4tcTYICKBpist/arcgis/rest/services';
export const BC_URLS = Object.freeze({
  [BC_RFC_SOURCE_ID]: `${BASE}/BC_Flood_Advisory_and_Warning_Notifications_(Public_View)/FeatureServer/0/query?where=Advisory%3E1&outFields=*&outSR=4326&geometryPrecision=5&f=geojson`,
  [EMCR_SOURCE_ID]: `${BASE}/Evacuation_Orders_and_Alerts/FeatureServer/0/query?where=1%3D1&outFields=*&outSR=4326&geometryPrecision=4&f=geojson`,
  [EMBC_TSUNAMI_SOURCE_ID]: `${BASE}/EMBC_Tsunami_Notifications_VIEW/FeatureServer/0/query?where=1%3D1&outFields=OBJECTID_1,TSUNAMI_ZONE_CLASSIFICATION,STATUS,URL&returnGeometry=false&f=json`,
});
const SOURCES = /** @type {const} */ ([BC_RFC_SOURCE_ID, EMCR_SOURCE_ID, EMBC_TSUNAMI_SOURCE_ID]);

/** @param {unknown} v @returns {v is Record<string, unknown>} */
function isRecord(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** @type {import('../../../site/static/js/types.js').SnapshotTask} */
export default {
  id: 'bc-hazards',
  sourceIds: [...SOURCES],
  cadenceMin: 10,
  outputs: ['bc-hazards.json'],
  async run(ctx) {
    const at = ctx.now.toISOString();
    const nations = await loadNations(ctx);
    /** @type {BcHazardItem[]} */
    const items = [];
    /** @type {Record<string, { ok: boolean, count: number, asOf: string | null }>} */
    const perSource = {};
    /** @type {Record<string, number>} */
    const diagnostics = { registryUnavailable: nations === null ? 1 : 0 };
    /** @type {string[]} */
    const errors = [];
    let partial = false;
    for (const id of SOURCES) {
      const res = await ctx.http.getJson(id, BC_URLS[id], { timeoutMs: 30000 });
      if (!res.ok || (isRecord(res.data) && isRecord(res.data.error))) {
        const msg = res.ok ? `ArcGIS error: ${JSON.stringify(/** @type {Record<string, unknown>} */ (res.data).error)}` : `${res.error.kind}: ${res.error.message}`;
        errors.push(`${id}: ${msg}`);
        perSource[id] = { ok: false, count: 0, asOf: null };
        diagnostics[`partial:${id}`] = 1;
        partial = true;
        continue;
      }
      const out = id === BC_RFC_SOURCE_ID
        ? normalizeRfcAdvisories(res.data, { fetchedAt: res.fetchedAt, ratified: false })
        : id === EMCR_SOURCE_ID
          ? normalizeEvacuations(res.data, { fetchedAt: res.fetchedAt, now: ctx.now })
          : normalizeTsunamiNotifications(res.data, { fetchedAt: res.fetchedAt });
      const scored = nations ? out.items.map((i) => ({ ...i, nationIds: nationIdsForGeometry(i.geometry, nations) })) : out.items;
      items.push(...scored);
      const srcPartial = Number(out.diagnostics.exceededTransferLimit ?? 0) > 0 || Number(out.diagnostics.itemsFailed ?? 0) > 0;
      if (srcPartial) partial = true;
      perSource[id] = { ok: true, count: scored.length, asOf: res.fetchedAt };
      for (const [k, v] of Object.entries(out.diagnostics)) diagnostics[`${k}:${id}`] = v;
      diagnostics[`partial:${id}`] = srcPartial ? 1 : 0;
    }
    const allFailed = SOURCES.every((id) => perSource[id]?.ok === false);
    const fetchedTimes = Object.values(perSource).map((p) => p.asOf).filter((t) => typeof t === 'string');
    const asOf = fetchedTimes.length === 0 ? null : /** @type {string} */ (fetchedTimes.reduce((a, b) => (Date.parse(/** @type {string} */ (a)) <= Date.parse(/** @type {string} */ (b)) ? a : b)));
    return {
      'bc-hazards.json': {
        schema: 'cthd.live.bc-hazards/1',
        id: 'bc-hazards',
        sourceIds: [...SOURCES],
        generatedAt: at,
        observedAt: at,
        asOf: allFailed ? null : asOf,
        asOfBasis: allFailed || asOf === null ? null : 'retrieved',
        completeness: allFailed ? 'rejected' : partial ? 'partial' : 'complete',
        carriedForward: false,
        failure: errors.length > 0 ? { code: allFailed ? 'upstream-failed' : 'source-failed', message: errors.join('; '), at } : null,
        perSource,
        diagnostics,
        items: allFailed ? [] : items.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
      },
    };
  },
};
