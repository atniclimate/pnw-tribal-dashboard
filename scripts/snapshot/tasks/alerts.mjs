// @ts-check
/**
 * Snapshot task `alerts` (blueprint 5.10, 6.4): NWS and ECCC alerts for the whole footprint, split into
 * the index (`alerts.json`, no text or geometry), the text (`alerts-text.json`), and the polygons
 * (`alerts-geometry.json`). The browser modules do every step (normalize, footprint filter, lifecycle,
 * Nation relevance), so the snapshot and the live top-ups apply identical rules.
 *
 * Never throws for upstream failures. Each source stands alone: when one source fails, its previous
 * items are carried forward from the deployed files with their original `asOf` and `perSource.ok: false`,
 * so the client derives `stale` or `degraded` from age; with no previous copy the source contributes no
 * items and the envelope is `partial` (or `rejected` when both sources fail).
 *
 * Per-source facts the client reads ride in `diagnostics` as `partial:<sourceId>`, `itemsFailed:<sourceId>`,
 * and `truncated:<sourceId>` (the envelope schema allows only numbers there).
 */
import { normalizeNwsCollection, nwsNextPage, NWS_SNAPSHOT_AREAS, NWS_SOURCE_ID } from '../../../site/static/js/alerts/nws.js';
import { ecccAsOf, ecccNextPage, ECCC_SOURCE_ID, normalizeEcccCollection } from '../../../site/static/js/alerts/eccc.js';
import { footprintIndex } from '../../../site/static/js/alerts/footprint.js';
import { prepareAlerts } from '../../../site/static/js/alerts/relevance.js';
import { toIndexEntry } from '../../../site/static/js/alerts/model.js';
import { tableFromReference } from '../../../site/static/js/alerts/categories.js';

/** @typedef {import('../../../site/static/js/types.js').DashboardAlert} DashboardAlert */
/** @typedef {import('../../../site/static/js/types.js').DashboardAlertIndexEntry} DashboardAlertIndexEntry */
/** @typedef {import('../../../site/static/js/types.js').SnapshotContext} SnapshotContext */
/** @typedef {import('../../../site/static/js/types.js').NationRecord} NationRecord */
/** @typedef {import('../../../site/static/js/types.js').LiveEnvelope<unknown>} Envelope */
/** @typedef {import('../../../site/static/js/types.js').HazardCategory} HazardCategory */
/** @typedef {import('../../../site/static/js/types.js').RegionCode} RegionCode */
/** @typedef {import('../../../site/static/js/types.js').AlertLanguageBlock} AlertLanguageBlock */
/** @typedef {import('../../../site/static/js/types.js').Geometry} Geometry */

export const NWS_SNAPSHOT_URL = `https://api.weather.gov/alerts/active?area=${NWS_SNAPSHOT_AREAS.join(',')}&status=actual`;
export const ECCC_SNAPSHOT_URL = 'https://api.weather.gc.ca/collections/weather-alerts/items?filter=properties.province=BC&limit=500&f=json';
/** The snapshot follows pagination to completion, capped at ten pages (NWS pages at 500 items). */
export const SNAPSHOT_MAX_PAGES = 10;
const OUTPUTS = /** @type {const} */ (['alerts.json', 'alerts-text.json', 'alerts-geometry.json']);

/** @param {unknown} v @returns {v is Record<string, unknown>} */
function isRecord(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Every Nation record the registry holds (lane L5), or null when no registry is built yet.
 * @param {SnapshotContext} ctx
 * @returns {Promise<NationRecord[] | null>}
 */
export async function loadNations(ctx) {
  try {
    const index = ctx.registry.index;
    if (!index || !Array.isArray(index.nations)) return null;
    /** @type {NationRecord[]} */
    const out = [];
    for (const n of index.nations) {
      const rec = await ctx.registry.nation(n.id);
      if (rec) out.push(rec);
    }
    return out;
  } catch {
    return null;
  }
}

/**
 * Optional reference file: null when it is not built yet.
 * @param {SnapshotContext} ctx
 * @param {string} file
 * @returns {Promise<unknown>}
 */
export async function optionalReference(ctx, file) {
  try { return await ctx.reference(file); } catch { return null; }
}

/**
 * Typed zone keys present in nws-zones.topo.json (lane L4), or null when that file is absent.
 * @param {unknown} topo
 * @returns {Set<string> | null}
 */
function zoneKeysOfTopology(topo) {
  if (!isRecord(topo) || !isRecord(topo.objects)) return null;
  const keys = new Set();
  for (const obj of Object.values(topo.objects)) {
    if (!isRecord(obj) || !Array.isArray(obj.geometries)) continue;
    for (const g of obj.geometries) {
      if (!isRecord(g)) continue;
      const k = typeof g.id === 'string' ? g.id : isRecord(g.properties) && typeof g.properties.key === 'string' ? g.properties.key : null;
      if (k) keys.add(k);
    }
  }
  return keys;
}

/**
 * Fetch one source's pages, following its next links.
 * @param {SnapshotContext} ctx
 * @param {string} sourceId
 * @param {string} firstUrl
 * @param {(data: unknown) => string | null} nextOf
 * @returns {Promise<{ ok: boolean, pages: { data: unknown, fetchedAt: string }[], truncated: boolean, error: string | null }>}
 */
export async function fetchPages(ctx, sourceId, firstUrl, nextOf) {
  /** @type {{ data: unknown, fetchedAt: string }[]} */
  const pages = [];
  /** @type {string | null} */
  let url = firstUrl;
  for (let i = 0; i < SNAPSHOT_MAX_PAGES && url; i += 1) {
    const res = await ctx.http.getJson(sourceId, url, { timeoutMs: 30000 });
    if (!res.ok) {
      const error = `${res.error.kind}: ${res.error.message}`;
      return { ok: pages.length > 0, pages, truncated: pages.length > 0, error };
    }
    pages.push({ data: res.data, fetchedAt: res.fetchedAt });
    url = nextOf(res.data);
  }
  return { ok: true, pages, truncated: url !== null && url !== undefined, error: null };
}

/**
 * @typedef {{ alerts: DashboardAlert[], ok: boolean, partial: boolean, asOf: string | null, error: string | null,
 *   diagnostics: Record<string, number> }} SourceOutcome
 */

/**
 * Normalize, filter, and score one source's pages.
 * @param {{ data: unknown, fetchedAt: string }[]} pages
 * @param {typeof normalizeNwsCollection} normalize
 * @param {{ now: Date, extras: Record<string, unknown>, footprint: ReturnType<typeof footprintIndex> | null, nations: NationRecord[] | null }} o
 * @returns {{ alerts: DashboardAlert[], itemsFailed: number, diagnostics: Record<string, number> }}
 */
function normalizePages(pages, normalize, o) {
  /** @type {DashboardAlert[]} */
  let all = [];
  /** @type {Record<string, number>} */
  const d = { testOrExerciseExcluded: 0, itemsFailed: 0, otherStatusExcluded: 0 };
  for (const p of pages) {
    const n = normalize(p.data, { fetchedAt: p.fetchedAt, now: o.now, ...o.extras });
    all = all.concat(n.alerts);
    d.testOrExerciseExcluded = (d.testOrExerciseExcluded ?? 0) + n.diagnostics.testOrExerciseExcluded;
    d.itemsFailed = (d.itemsFailed ?? 0) + n.diagnostics.itemsFailed;
    d.otherStatusExcluded = (d.otherStatusExcluded ?? 0) + Number(n.diagnostics.otherStatusExcluded ?? 0);
  }
  const prepared = prepareAlerts(all, { now: o.now, footprint: o.footprint, nations: o.nations });
  d.outsideFootprint = prepared.outsideFootprint;
  d.superseded = prepared.superseded;
  d.cancelled = prepared.cancelled;
  d.expired = prepared.expired;
  return { alerts: prepared.alerts, itemsFailed: d.itemsFailed ?? 0, diagnostics: d };
}

/**
 * Items of `sourceId` from the previously deployed split files, rejoined.
 * @param {SnapshotContext} ctx
 * @param {string} sourceId
 * @returns {Promise<{ alerts: DashboardAlert[], asOf: string | null } | null>}
 */
async function previousFor(ctx, sourceId) {
  try {
    const index = await ctx.previous('alerts.json');
    if (!index || index.completeness === 'rejected' || !Array.isArray(index.items)) return null;
    const text = await ctx.previous('alerts-text.json');
    const geom = await ctx.previous('alerts-geometry.json');
    /** @type {Map<string, Record<string, AlertLanguageBlock>>} */
    const textById = new Map();
    for (const t of /** @type {any[]} */ (text?.items ?? [])) if (isRecord(t) && typeof t.alertId === 'string') textById.set(t.alertId, /** @type {any} */ (t.sourceLanguage));
    /** @type {Map<string, Geometry>} */
    const geomById = new Map();
    for (const g of /** @type {any[]} */ (geom?.items ?? [])) if (isRecord(g) && typeof g.alertId === 'string') geomById.set(g.alertId, /** @type {any} */ (g.geometry));
    const items = /** @type {DashboardAlertIndexEntry[]} */ (index.items).filter((a) => a.sourceId === sourceId);
    const alerts = items
      .filter((a) => textById.has(a.alertId))
      .map((a) => ({ ...a, sourceLanguage: /** @type {Record<string, AlertLanguageBlock>} */ (textById.get(a.alertId)), geometry: geomById.get(a.alertId) ?? null }));
    const asOf = index.perSource?.[sourceId]?.asOf ?? index.asOf ?? null;
    return { alerts, asOf };
  } catch {
    return null;
  }
}

/** @param {(string | null)[]} times @returns {string | null} */
function oldest(times) {
  const ok = /** @type {string[]} */ (times.filter((t) => typeof t === 'string' && !Number.isNaN(Date.parse(t))));
  if (ok.length === 0) return null;
  return ok.reduce((a, b) => (Date.parse(a) <= Date.parse(b) ? a : b));
}

/** @type {import('../../../site/static/js/types.js').SnapshotTask} */
export default {
  id: 'alerts',
  sourceIds: [NWS_SOURCE_ID, ECCC_SOURCE_ID],
  cadenceMin: 10,
  outputs: [...OUTPUTS],
  async run(ctx) {
    const now = ctx.now;
    const at = now.toISOString();
    const fpDoc = /** @type {{ zones?: string[], marineToRegion?: Record<string, RegionCode> } | null} */ (await optionalReference(ctx, 'footprint-ugc.json'));
    const zonesTopo = zoneKeysOfTopology(await optionalReference(ctx, 'nws-zones.topo.json'));
    const tables = {
      nws: tableFromReference(await optionalReference(ctx, 'nws-event-categories.json')),
      eccc: tableFromReference(await optionalReference(ctx, 'eccc-event-categories.json')),
    };
    const nations = await loadNations(ctx);
    const footprint = fpDoc ? footprintIndex(fpDoc, [-180, -90, 180, 90]) : null;
    /** @type {Record<string, number>} */
    const diagnostics = {
      registryUnavailable: nations === null ? 1 : 0,
      footprintIndexUnavailable: footprint === null ? 1 : 0,
    };

    /**
     * @param {string} sourceId
     * @param {string} url
     * @param {(d: unknown) => string | null} nextOf
     * @param {typeof normalizeNwsCollection} normalize
     * @param {(pages: { data: unknown }[], alerts: DashboardAlert[]) => string | null} asOfOf
     * @param {boolean} useFootprint
     * @returns {Promise<SourceOutcome>}
     */
    const runSource = async (sourceId, url, nextOf, normalize, asOfOf, useFootprint) => {
      const fetched = await fetchPages(ctx, sourceId, url, nextOf);
      if (!fetched.ok) {
        const prev = await previousFor(ctx, sourceId);
        ctx.log(`${sourceId}: ${fetched.error ?? 'failed'}; ${prev ? `carried forward ${prev.alerts.length} item(s)` : 'no previous copy'}`);
        return { alerts: prev?.alerts ?? [], ok: false, partial: prev === null, asOf: prev?.asOf ?? null, error: fetched.error,
          diagnostics: { [`partial:${sourceId}`]: prev === null ? 1 : 0, [`carriedForward:${sourceId}`]: prev === null ? 0 : 1 } };
      }
      const n = normalizePages(fetched.pages, normalize, {
        now, extras: { tables, marineToRegion: fpDoc?.marineToRegion ?? {} },
        footprint: useFootprint ? footprint : null, nations,
      });
      const lastPage = fetched.pages[fetched.pages.length - 1]?.data;
      const matchedShort = isRecord(lastPage) && typeof lastPage.numberMatched === 'number'
        && lastPage.numberMatched > fetched.pages.reduce((s, p) => s + (isRecord(p.data) && Array.isArray(p.data.features) ? p.data.features.length : 0), 0);
      const truncated = fetched.truncated || matchedShort;
      // Without the footprint index the edge states cannot be filtered, so NWS keeps only Washington,
      // Oregon, Idaho, and marine alerts and says it is partial.
      let alerts = n.alerts;
      let partial = truncated || n.itemsFailed > 0;
      if (useFootprint && footprint === null) {
        alerts = alerts.filter((a) => a.jurisdictions.some((j) => j === 'WA' || j === 'OR' || j === 'ID'));
        partial = true;
      }
      return {
        alerts,
        ok: true,
        partial,
        asOf: asOfOf(fetched.pages, alerts),
        error: fetched.error,
        diagnostics: { ...n.diagnostics, [`truncated:${sourceId}`]: truncated ? 1 : 0, [`itemsFailed:${sourceId}`]: n.itemsFailed, [`partial:${sourceId}`]: partial ? 1 : 0 },
      };
    };

    const [nws, eccc] = await Promise.all([
      runSource(NWS_SOURCE_ID, NWS_SNAPSHOT_URL, nwsNextPage, normalizeNwsCollection,
        (pages) => oldest(pages.map((p) => (isRecord(p.data) && typeof p.data.updated === 'string' ? p.data.updated : null))), true),
      runSource(ECCC_SOURCE_ID, ECCC_SNAPSHOT_URL, ecccNextPage, normalizeEcccCollection,
        (pages, alerts) => ecccAsOf(pages[pages.length - 1]?.data, alerts), false),
    ]);

    for (const o of [nws, eccc]) {
      for (const [k, v] of Object.entries(o.diagnostics)) diagnostics[k] = (diagnostics[k] ?? 0) + v;
    }
    const all = [...nws.alerts, ...eccc.alerts];
    if (zonesTopo) diagnostics.unknownZoneKeys = new Set(all.flatMap((a) => a.zones).filter((z) => !zonesTopo.has(z))).size;
    const bothFailed = !nws.ok && !eccc.ok && all.length === 0;
    const completeness = bothFailed ? 'rejected' : (!nws.ok || !eccc.ok || nws.partial || eccc.partial) ? 'partial' : 'complete';
    const failed = [nws.ok ? null : `${NWS_SOURCE_ID}: ${nws.error}`, eccc.ok ? null : `${ECCC_SOURCE_ID}: ${eccc.error}`].filter(Boolean);
    const failure = failed.length > 0 ? { code: bothFailed ? 'upstream-failed' : 'source-failed', message: failed.join('; '), at } : null;
    const asOf = bothFailed ? null : oldest([nws.asOf, eccc.asOf]);
    const perSource = {
      [NWS_SOURCE_ID]: { ok: nws.ok, count: nws.alerts.length, asOf: nws.asOf },
      [ECCC_SOURCE_ID]: { ok: eccc.ok, count: eccc.alerts.length, asOf: eccc.asOf },
    };
    /** @param {string} stem @param {unknown[]} items @returns {Envelope} */
    const envelope = (stem, items) => ({
      schema: /** @type {`cthd.live.${string}/1`} */ (`cthd.live.${stem}/1`),
      id: 'alerts',
      sourceIds: [NWS_SOURCE_ID, ECCC_SOURCE_ID],
      generatedAt: at,
      observedAt: at,
      asOf,
      asOfBasis: asOf === null ? null : 'issued',
      completeness,
      carriedForward: false,
      failure,
      perSource,
      diagnostics,
      items: bothFailed ? [] : items,
    });
    return {
      'alerts.json': envelope('alerts', all.map(toIndexEntry)),
      'alerts-text.json': envelope('alerts-text', all.map((a) => ({ alertId: a.alertId, sourceLanguage: a.sourceLanguage }))),
      'alerts-geometry.json': envelope('alerts-geometry', all.filter((a) => a.geometry !== null).map((a) => ({ alertId: a.alertId, geometry: a.geometry }))),
    };
  },
};
