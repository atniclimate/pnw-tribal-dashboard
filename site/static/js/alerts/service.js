// @ts-check
/**
 * Load orchestration: snapshot first, live second (blueprint 3.7.6). The same module runs in Node for the
 * alerts snapshot task. DOM-free.
 *
 * 1. In parallel at priority 0: `data/live/alerts.json` (index, no text or geometry) and
 *    `data/live/tsunami.json`. The caller already holds the selected Nation's record (`scope.nation`).
 * 2. `onSnapshot` receives the snapshot-only result so the banner and collapsed cards paint at once.
 * 3. `loadAlertText` (priority 1) is the caller's next call after paint.
 * 4. Direct top-ups follow the request plans. Per source: a complete direct set replaces that source's
 *    snapshot set; a partial direct set is the union of direct items and snapshot items that no direct
 *    item supersedes, cancels, or outlives, and the source is marked degraded. Snapshot-only items keep
 *    their snapshot `provenance.fetchedAt`, which the list labels "Last confirmed ...".
 * 5. `loadAlertGeometry` and the zone index load only when a map is shown.
 *
 * Banner, lists, map, and the Node snapshot task never call adapters directly; they use this module.
 */
import { fetchAllPages, fetchLocal } from '../core/net.js';
import { deriveStatus } from '../core/status.js';
import { isEnabled } from '../core/sources.js';
import { APP } from '../config/app.js';
import { joinAlert, sortAlerts } from './model.js';
import { isExpired, resolveLifecycle } from './lifecycle.js';

// The normalizers (nws.js, eccc.js, and their mapping and category tables) and the footprint and
// relevance rules (footprint.js, relevance.js) load by dynamic import only
// when a direct top-up runs, after the snapshot has painted, so they stay off the page's static import
// graph and the bytes before the first alert paint (blueprint 8.1).

const NWS_SOURCE_ID = 'nws-alerts-active';
const ECCC_SOURCE_ID = 'eccc-geomet-weather-alerts';

/** @returns {AlertDiagnostics} */
function emptyDiagnostics() {
  return { testOrExerciseExcluded: 0, itemsFailed: 0, unknownZoneKeys: 0, truncated: false };
}

/**
 * The ECCC top-up rule of `ecccInScope` (alerts/eccc.js), repeated here so the decision needs no
 * normalizer before paint; tests/unit/alerts/service.test.mjs asserts the two agree.
 * @param {AlertScope} scope
 * @param {PageId} page
 * @returns {boolean}
 */
export function bcInScope(scope, page) {
  if (page === 'alerts') return true;
  if (scope.kind === 'nation') return scope.nation.country === 'CA' || scope.nation.jurisdictions.includes('BC');
  return Array.isArray(scope.jurisdictions) && scope.jurisdictions.includes('BC');
}

/** @typedef {import('../types.js').DashboardAlert} DashboardAlert */
/** @typedef {import('../types.js').DashboardAlertIndexEntry} DashboardAlertIndexEntry */
/** @typedef {import('../types.js').AlertScope} AlertScope */
/** @typedef {import('../types.js').LoadAllAlertsResult} LoadAllAlertsResult */
/** @typedef {import('../types.js').Banner} Banner */
/** @typedef {import('../types.js').NationsIndex} NationsIndex */
/** @typedef {import('../types.js').NationRecord} NationRecord */
/** @typedef {import('../types.js').StatusSnapshot} StatusSnapshot */
/** @typedef {import('../types.js').AlertDiagnostics} AlertDiagnostics */
/** @typedef {import('../types.js').LiveEnvelope<DashboardAlertIndexEntry>} AlertsEnvelope */
/** @typedef {import('../types.js').LiveEnvelope<DashboardAlert>} TsunamiEnvelope */
/** @typedef {import('../types.js').NetResult} NetResult */
/** @typedef {import('../types.js').PagedResult} PagedResult */
/** @typedef {import('../types.js').FetchOptions} FetchOptions */
/** @typedef {import('../types.js').StatusInputs} StatusInputs */
/** @typedef {import('../types.js').PageId} PageId */
/** @typedef {import('../types.js').HazardCategory} HazardCategory */
/** @typedef {import('../types.js').RegionCode} RegionCode */
/**
 * @typedef {{
 *   fetchLocal: (path: string, opts?: FetchOptions) => Promise<NetResult>,
 *   fetchAllPages: (sourceId: string, opts: FetchOptions, nextOf: (data: unknown) => string | null, maxPages?: number) => Promise<PagedResult>,
 *   deriveStatus: (inputs: StatusInputs) => StatusSnapshot,
 *   isEnabled: (id: string) => boolean,
 *   now: () => Date,
 * }} AlertDeps
 */

export const NTWC_ID = 'ntwc-atom';
/** Same-origin files this module reads. */
export const LIVE_FILES = Object.freeze({
  index: 'data/live/alerts.json',
  text: 'data/live/alerts-text.json',
  geometry: 'data/live/alerts-geometry.json',
  tsunami: 'data/live/tsunami.json',
  footprintUgc: 'data/geo/footprint-ugc.json',
  nwsCategories: 'data/ref/nws-event-categories.json',
  ecccCategories: 'data/ref/eccc-event-categories.json',
});
/** Browser pagination cap (blueprint 3.7.7: snapshot to completion, browser up to five pages). */
export const BROWSER_MAX_PAGES = 5;

/** @type {AlertDeps} */
const DEFAULT_DEPS = {
  fetchLocal,
  fetchAllPages,
  deriveStatus,
  isEnabled: (id) => {
    try { return isEnabled(id); } catch { return false; }
  },
  now: () => new Date(),
};

/** @param {unknown} v @returns {v is Record<string, unknown>} */
function isRecord(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** @param {AlertDiagnostics} into @param {AlertDiagnostics | Record<string, number | boolean>} add */
function addDiagnostics(into, add) {
  for (const [k, v] of Object.entries(add)) {
    if (typeof v === 'boolean') into[k] = Boolean(into[k]) || v;
    else if (typeof v === 'number') into[k] = (typeof into[k] === 'number' ? /** @type {number} */ (into[k]) : 0) + v;
  }
}


/**
 * Complete direct replaces; partial direct is the union with non-superseded snapshot items.
 * A snapshot item drops out of the union when a direct item has the same id or event, references it,
 * or when its own `ends ?? expires` has passed.
 * @param {DashboardAlert[]} direct
 * @param {DashboardAlert[]} snapshot
 * @param {'complete' | 'partial'} completeness
 * @param {Date} now
 * @returns {DashboardAlert[]}
 */
export function mergeDirectWithSnapshot(direct, snapshot, completeness, now) {
  if (completeness === 'complete') return [...direct];
  const ids = new Set(direct.map((a) => a.alertId));
  const events = new Set(direct.map((a) => a.eventId));
  const referenced = new Set(direct.flatMap((a) => [...a.references]));
  const kept = snapshot.filter((s) => !ids.has(s.alertId) && !events.has(s.eventId) && !referenced.has(s.alertId)
    && !referenced.has(s.eventId) && !isExpired(s, now) && s.lifecycleState === 'active' && s.posture !== 'ended');
  return [...direct, ...kept];
}

/**
 * Per-source facts written by the snapshot task into the envelope (`perSource` plus the
 * `<kind>:<sourceId>` diagnostics keys).
 * @param {AlertsEnvelope | TsunamiEnvelope} env
 * @param {string} sourceId
 * @returns {{ present: boolean, ok: boolean, asOf: string | null, partial: boolean, itemsFailed: number, truncated: boolean }}
 */
export function snapshotSourceFacts(env, sourceId) {
  const ps = env.perSource?.[sourceId];
  const d = env.diagnostics ?? {};
  return {
    present: ps !== undefined,
    ok: ps?.ok === true,
    asOf: ps?.asOf ?? null,
    partial: d[`partial:${sourceId}`] === 1 || (env.completeness === 'partial' && Object.keys(env.perSource ?? {}).length === 1),
    itemsFailed: Number(d[`itemsFailed:${sourceId}`] ?? 0),
    truncated: d[`truncated:${sourceId}`] === 1,
  };
}

/**
 * The snapshot-only status of one source, from the envelope's own facts and the source's age.
 * @param {AlertsEnvelope | TsunamiEnvelope | null} env
 * @param {string} sourceId
 * @param {{ now: Date, pending: boolean, deps: AlertDeps, unavailableReason?: string }} o
 * @returns {StatusSnapshot}
 */
function snapshotStatus(env, sourceId, o) {
  const policy = APP.freshness.alerts;
  const facts = env ? snapshotSourceFacts(env, sourceId) : null;
  const usable = env !== null && facts !== null && facts.present && facts.asOf !== null && env.completeness !== 'rejected';
  const base = o.deps.deriveStatus({
    sourceIds: [sourceId],
    policy,
    now: o.now,
    snapshot: usable ? { asOf: facts.asOf, asOfBasis: env.asOfBasis ?? 'issued', carriedForward: env.carriedForward || !facts.ok } : null,
    direct: o.pending ? 'pending' : null,
    unavailableReason: o.unavailableReason ?? 'The scheduled copy of these alerts is not available.',
  });
  if (usable && facts.partial) {
    return { ...base, state: base.state === 'unavailable' ? 'unavailable' : 'degraded', completeness: 'partial', detail: partialDetail(facts.itemsFailed, facts.truncated, null, null, sourceId) };
  }
  return base;
}

/**
 * A saved response keeps its original age and completeness, but cannot claim a live check.
 * @param {StatusSnapshot} status
 * @param {NetResult} response
 * @returns {StatusSnapshot}
 */
function savedStatus(status, response) {
  if (!response.ok || !response.fromCache || status.state === 'unavailable') return status;
  return { ...status, origin: 'device', state: status.state === 'live' ? 'cached' : status.state,
    detail: `Saved on this device; current conditions could not be confirmed. ${status.detail ?? ''}`.trim() };
}

/**
 * The partial-data sentence for a source.
 * @param {number} itemsFailed
 * @param {boolean} truncated
 * @param {number | null} loaded
 * @param {number | null} matched
 * @param {string} sourceId
 * @returns {string}
 */
export function partialDetail(itemsFailed, truncated, loaded, matched, sourceId) {
  const site = sourceId === ECCC_SOURCE_ID ? 'weather.gc.ca' : 'weather.gov';
  /** @type {string[]} */
  const parts = [];
  if (truncated) {
    parts.push(loaded !== null && matched !== null && matched > loaded
      ? `Partial: ${loaded} of ${matched} alerts loaded.`
      : 'Partial: not every page of alerts could be loaded.');
  }
  if (itemsFailed === 1) parts.push(`One alert could not be displayed here. Check ${site} for complete alerts.`);
  else if (itemsFailed > 1) parts.push(`${itemsFailed} alerts could not be displayed here. Check ${site} for complete alerts.`);
  if (parts.length === 0) parts.push(`Partial: some areas could not be checked. Check ${site} for complete alerts.`);
  return parts.join(' ');
}

/**
 * Scope filter for display: a Nation sees alerts whose relevance names it; a footprint view filtered to
 * jurisdictions sees alerts in any of them.
 * @template {DashboardAlertIndexEntry} T
 * @param {T[]} alerts
 * @param {AlertScope} scope
 * @returns {T[]}
 */
export function scopeFilter(alerts, scope) {
  if (scope.kind === 'nation') {
    const id = scope.nation.id;
    return alerts.filter((a) => a.nationIds.includes(id) || (a.agency === 'ntwc' && a.jurisdictions.some((j) => scope.nation.jurisdictions.includes(j))));
  }
  const js = scope.jurisdictions ?? [];
  if (js.length === 0) return alerts;
  return alerts.filter((a) => a.jurisdictions.some((j) => js.includes(j)));
}

/**
 * @param {NetResult} res
 * @returns {AlertsEnvelope | null}
 */
function envelopeOf(res) {
  if (!res.ok || !isRecord(res.data) || !Array.isArray(res.data.items)) return null;
  return /** @type {AlertsEnvelope} */ (/** @type {unknown} */ (res.data));
}

/**
 * Full text for expanded cards (`alerts-text.json`, priority 1), keyed by alertId.
 * @param {{ signal?: AbortSignal, deps?: Partial<AlertDeps> }} [opts]
 * @returns {Promise<Map<string, Record<string, import('../types.js').AlertLanguageBlock>> | null>}
 */
export async function loadAlertText(opts) {
  const deps = { ...DEFAULT_DEPS, ...(opts?.deps ?? {}) };
  const res = await deps.fetchLocal(LIVE_FILES.text, { priority: 1, ...(opts?.signal ? { signal: opts.signal } : {}) });
  if (!res.ok || !isRecord(res.data) || !Array.isArray(res.data.items)) return null;
  const out = new Map();
  for (const item of res.data.items) if (isRecord(item) && typeof item.alertId === 'string' && isRecord(item.sourceLanguage)) out.set(item.alertId, item.sourceLanguage);
  return out;
}

/**
 * Polygons for the map (`alerts-geometry.json`, priority 1), keyed by alertId. Load only when a map is shown.
 * @param {{ signal?: AbortSignal, deps?: Partial<AlertDeps> }} [opts]
 * @returns {Promise<Map<string, import('../types.js').Geometry> | null>}
 */
export async function loadAlertGeometry(opts) {
  const deps = { ...DEFAULT_DEPS, ...(opts?.deps ?? {}) };
  const res = await deps.fetchLocal(LIVE_FILES.geometry, { priority: 1, ...(opts?.signal ? { signal: opts.signal } : {}) });
  if (!res.ok || !isRecord(res.data) || !Array.isArray(res.data.items)) return null;
  const out = new Map();
  for (const item of res.data.items) if (isRecord(item) && typeof item.alertId === 'string' && isRecord(item.geometry)) out.set(item.alertId, item.geometry);
  return out;
}

/**
 * One source's direct top-up: every planned request, normalized, merged, and stamped.
 * @param {{ sourceId: string, requests: Array<{ params: Record<string, string> }>, nextOf: (d: unknown) => string | null,
 *   normalize: (collection: unknown, ctx: any) => { alerts: DashboardAlert[], diagnostics: AlertDiagnostics, failures: unknown[] }, asOfOf: (pages: unknown[], alerts: DashboardAlert[]) => string | null,
 *   filter: (alerts: DashboardAlert[]) => DashboardAlert[], ctxExtras: Record<string, unknown>, forcedPartial?: string | null,
 *   signal?: AbortSignal, deps: AlertDeps, now: Date }} o
 * @returns {Promise<{ ok: boolean, alerts: DashboardAlert[], completeness: 'complete' | 'partial', asOf: string | null, detail: string | null, error: import('../types.js').NetError | null, diagnostics: AlertDiagnostics }>}
 */
async function directTopUp(o) {
  const diagnostics = emptyDiagnostics();
  /** @type {DashboardAlert[]} */
  let alerts = [];
  /** @type {unknown[]} */
  const pagesData = [];
  let anyOk = false;
  let failedRequests = 0;
  /** @type {import('../types.js').NetError | null} */
  let firstError = null;
  let truncated = false;
  let loaded = 0;
  let matched = 0;
  const results = await Promise.all(o.requests.map((r) => o.deps.fetchAllPages(o.sourceId,
    { params: r.params, priority: 0, ...(o.signal ? { signal: o.signal } : {}) }, o.nextOf, BROWSER_MAX_PAGES)));
  for (const res of results) {
    const okPages = res.pages.filter((p) => p.ok);
    if (!res.ok) { failedRequests += 1; firstError ??= res.error ?? null; }
    if (res.truncated) truncated = true;
    for (const page of okPages) {
      if (!page.ok) continue;
      anyOk = true;
      pagesData.push(page.data);
      const n = o.normalize(page.data, { fetchedAt: page.fetchedAt, now: o.now, ...o.ctxExtras });
      addDiagnostics(diagnostics, { ...n.diagnostics, truncated: false });
      alerts = alerts.concat(n.alerts);
      loaded += n.alerts.length + n.failures.length;
      const nm = isRecord(page.data) && typeof page.data.numberMatched === 'number' ? page.data.numberMatched : null;
      if (nm !== null) matched = Math.max(matched, nm);
    }
    // The last fetched page still pointing onward means the set is cut short.
    const last = res.pages[res.pages.length - 1];
    if (last?.ok && o.nextOf(last.data) !== null) truncated = true;
  }
  if (!anyOk) {
    return { ok: false, alerts: [], completeness: 'partial', asOf: null, detail: null,
      error: firstError ?? { kind: 'network', message: 'no request completed' }, diagnostics };
  }
  diagnostics.truncated = truncated;
  const filtered = o.filter(alerts);
  const failed = Number(diagnostics.itemsFailed);
  const partial = truncated || failed > 0 || failedRequests > 0 || Boolean(o.forcedPartial);
  /** @type {string | null} */
  let detail = null;
  if (partial) {
    detail = o.forcedPartial && !truncated && failed === 0 && failedRequests === 0
      ? o.forcedPartial
      : partialDetail(failed, truncated || failedRequests > 0, loaded, matched || null, o.sourceId);
  }
  return { ok: true, alerts: filtered, completeness: partial ? 'partial' : 'complete', asOf: o.asOfOf(pagesData, filtered), detail, error: null, diagnostics };
}

/** @param {unknown[]} pages @returns {string | null} the oldest collection `updated` stamp (NWS) */
function nwsAsOf(pages) {
  const times = pages.map((p) => (isRecord(p) && typeof p.updated === 'string' ? p.updated : null))
    .filter((t) => t !== null && !Number.isNaN(Date.parse(t)));
  if (times.length === 0) return null;
  return /** @type {string} */ (times.reduce((a, b) => (Date.parse(/** @type {string} */ (a)) <= Date.parse(/** @type {string} */ (b)) ? a : b)));
}

/**
 * Banner, lists, map, and the snapshot task never call adapters directly.
 * @param {{ scope: AlertScope, registry: { index: NationsIndex | null }, signal?: AbortSignal,
 *   page?: PageId, direct?: boolean, onSnapshot?: (result: LoadAllAlertsResult) => void, deps?: Partial<AlertDeps>,
 *   prefetch?: { index: Promise<NetResult>, tsunami: Promise<NetResult> } | null }} opts
 *   `page` decides the ECCC top-up (blueprint 3.7.4); `direct: false` paints from the snapshot only;
 *   `prefetch` replaces this call's own two snapshot requests (the caller passes it to one call only);
 *   `deps` replaces network, status, and clock functions (tests and the Node task).
 * @returns {Promise<LoadAllAlertsResult>}
 */
export async function loadAllAlerts(opts) {
  const deps = { ...DEFAULT_DEPS, ...(opts.deps ?? {}) };
  const { scope, signal } = opts;
  const page = opts.page ?? 'dashboard';
  const now = deps.now();
  const sig = signal ? { signal } : {};

  // 1. Snapshot index and tsunami file in parallel at priority 0, or the caller's earlier requests (an aborted scope discards them).
  const early = opts.prefetch && !signal?.aborted ? opts.prefetch : null;
  const [indexRes, tsunamiRes] = await Promise.all(early
    ? [early.index, early.tsunami]
    : [deps.fetchLocal(LIVE_FILES.index, { priority: 0, ...sig }), deps.fetchLocal(LIVE_FILES.tsunami, { priority: 0, ...sig })]);
  const env = envelopeOf(indexRes);
  const tsunamiEnv = /** @type {TsunamiEnvelope | null} */ (/** @type {unknown} */ (envelopeOf(tsunamiRes)));
  const snapshotAll = (env?.completeness === 'rejected' ? [] : env?.items ?? []).map((e) => joinAlert(e, null, null));
  /** @type {Map<string, DashboardAlert[]>} */
  const snapBySource = new Map();
  for (const a of snapshotAll) snapBySource.set(a.sourceId, [...(snapBySource.get(a.sourceId) ?? []), a]);
  const tsunamiAlerts = tsunamiEnv && tsunamiEnv.completeness !== 'rejected' ? tsunamiEnv.items.filter((a) => isRecord(a)) : [];

  const nwsDirect = opts.direct !== false && deps.isEnabled(NWS_SOURCE_ID) && !(scope.kind === 'nation' && scope.nation.nws === null);
  const ecccDirect = opts.direct !== false && deps.isEnabled(ECCC_SOURCE_ID) && bcInScope(scope, page);

  /** @type {Map<string, StatusSnapshot>} */
  const statuses = new Map();
  statuses.set(NWS_SOURCE_ID, savedStatus(snapshotStatus(env, NWS_SOURCE_ID, { now, pending: nwsDirect, deps }), indexRes));
  statuses.set(ECCC_SOURCE_ID, savedStatus(snapshotStatus(env, ECCC_SOURCE_ID, { now, pending: ecccDirect, deps }), indexRes));
  statuses.set(NTWC_ID, savedStatus(snapshotStatus(tsunamiEnv, NTWC_ID, { now, pending: false, deps }), tsunamiRes));

  const diagnostics = emptyDiagnostics();
  if (env) addDiagnostics(diagnostics, Object.fromEntries(Object.entries(env.diagnostics ?? {}).filter(([k]) => !k.includes(':'))));

  /** @param {DashboardAlert[]} all @returns {DashboardAlert[]} */
  const finish = (all) => sortAlerts(scopeFilter(resolveLifecycle(all, now).current, scope));

  const snapshotResult = { alerts: finish([...snapshotAll, ...tsunamiAlerts]), statuses: new Map(statuses), diagnostics: { ...diagnostics } };
  if (opts.onSnapshot) {
    try { opts.onSnapshot(snapshotResult); } catch { /* a paint failure never blocks the top-up */ }
  }
  if (!nwsDirect && !ecccDirect) return snapshotResult;
  if (signal?.aborted) return snapshotResult;

  // Reference data for direct normalization: category tables (optional) and, in footprint scope, the
  // footprint zone index (lane L4). Both are small same-origin files. The normalizers load here too.
  const [nwsMod, ecccMod, catMod, relMod, fpMod, nwsCat, ecccCat, fpRes] = await Promise.all([
    import('./nws.js'),
    import('./eccc.js'),
    import('./categories.js'),
    import('./relevance.js'),
    import('./footprint.js'),
    deps.fetchLocal(LIVE_FILES.nwsCategories, { priority: 1, ...sig }),
    deps.fetchLocal(LIVE_FILES.ecccCategories, { priority: 1, ...sig }),
    scope.kind === 'footprint' && nwsDirect ? deps.fetchLocal(LIVE_FILES.footprintUgc, { priority: 0, ...sig }) : Promise.resolve(null),
  ]);
  const tables = { nws: nwsCat.ok ? catMod.tableFromReference(nwsCat.data) : {}, eccc: ecccCat.ok ? catMod.tableFromReference(ecccCat.data) : {} };
  const fpDoc = fpRes && fpRes.ok && isRecord(fpRes.data) ? /** @type {{ zones?: string[], edgeCodes?: string[], marineToRegion?: Record<string, RegionCode> }} */ (fpRes.data) : null;
  const marineToRegion = fpDoc?.marineToRegion ?? {};

  /** @type {Promise<void>[]} */
  const jobs = [];
  /** @type {Map<string, DashboardAlert[]>} */
  const merged = new Map(snapBySource);

  if (nwsDirect) {
    jobs.push((async () => {
      const plan = nwsMod.nwsRequestPlan(scope, { edgeCodes: fpDoc?.edgeCodes ?? [] });
      /** @type {string | null} */
      let forced = null;
      /** @type {(alerts: DashboardAlert[]) => DashboardAlert[]} */
      let filter;
      if (scope.kind === 'nation') {
        const nation = scope.nation;
        // zone= matches bare codes (and county codes spatially), so the results are post-filtered by typed key.
        filter = (alerts) => relMod.prepareAlerts(alerts, { now, nations: [nation] }).alerts.filter((a) => a.nationIds.includes(nation.id));
      } else if (fpDoc) {
        const fp = fpMod.footprintIndex(fpDoc, [-180, -90, 180, 90]);
        filter = (alerts) => relMod.prepareAlerts(alerts, { now, footprint: fp }).alerts;
      } else {
        // Without the footprint zone index the edge areas cannot be requested or filtered directly; they stay
        // snapshot-only and the stamp says so.
        filter = (alerts) => relMod.prepareAlerts(alerts, { now }).alerts.filter((a) => a.jurisdictions.some((j) => j === 'WA' || j === 'OR' || j === 'ID'));
        forced = 'Partial: northern California, western Montana, northern Nevada, Southeast Alaska, and coastal waters are shown from the scheduled copy.';
      }
      const r = await directTopUp({ sourceId: NWS_SOURCE_ID, requests: plan, nextOf: nwsMod.nwsNextPage, normalize: nwsMod.normalizeNwsCollection,
        asOfOf: (pages) => nwsAsOf(pages), filter, ctxExtras: { tables, marineToRegion }, forcedPartial: forced, ...sig, deps, now });
      applyDirect(NWS_SOURCE_ID, r);
    })());
  }
  if (ecccDirect) {
    jobs.push((async () => {
      const bcCount = (snapBySource.get(ECCC_SOURCE_ID) ?? []).length;
      const params = ecccMod.ecccRequestParams(scope, { skipGeometry: ecccMod.ecccSkipGeometry(bcCount) });
      /** @type {(alerts: DashboardAlert[]) => DashboardAlert[]} */
      const filter = scope.kind === 'nation'
        ? (alerts) => relMod.prepareAlerts(alerts, { now }).alerts.map((a) => ({ ...a, nationIds: [scope.nation.id] }))
        : (alerts) => relMod.prepareAlerts(alerts, { now }).alerts.filter((a) => a.jurisdictions.includes('BC'));
      const r = await directTopUp({ sourceId: ECCC_SOURCE_ID, requests: [{ params }], nextOf: ecccMod.ecccNextPage,
        normalize: ecccMod.normalizeEcccCollection, asOfOf: (pages, alerts) => ecccMod.ecccAsOf(pages[pages.length - 1], alerts), filter,
        ctxExtras: { tables }, ...sig, deps, now });
      applyDirect(ECCC_SOURCE_ID, r);
    })());
  }

  /**
   * @param {string} sourceId
   * @param {Awaited<ReturnType<typeof directTopUp>>} r
   */
  function applyDirect(sourceId, r) {
    const snap = snapBySource.get(sourceId) ?? [];
    if (!r.ok) {
      statuses.set(sourceId, savedStatus(deps.deriveStatus({
        sourceIds: [sourceId], policy: APP.freshness.alerts, now,
        snapshot: snapshotInputs(env, sourceId),
        direct: { ok: false, error: /** @type {import('../types.js').NetError} */ (r.error) },
        unavailableReason: 'These alerts could not be loaded right now.',
      }), indexRes));
      return;
    }
    addDiagnostics(diagnostics, r.diagnostics);
    // Direct nationIds for alerts the snapshot already scored are kept when the direct request could not
    // score them (footprint scope has no Nation records).
    const prior = new Map(snap.map((a) => [a.alertId, a.nationIds]));
    const direct = r.alerts.map((a) => (a.nationIds.length === 0 && prior.has(a.alertId) ? { ...a, nationIds: /** @type {string[]} */ (prior.get(a.alertId)) } : a));
    const scopedSnap = scope.kind === 'nation' ? snap.filter((a) => a.nationIds.includes(scope.nation.id)) : snap;
    const outside = scope.kind === 'nation' ? snap.filter((a) => !a.nationIds.includes(scope.nation.id)) : [];
    merged.set(sourceId, [...mergeDirectWithSnapshot(direct, scopedSnap, r.completeness, now), ...outside]);
    statuses.set(sourceId, deps.deriveStatus({
      sourceIds: [sourceId], policy: APP.freshness.alerts, now,
      snapshot: snapshotInputs(env, sourceId),
      direct: { ok: true, asOf: r.asOf, asOfBasis: r.asOf ? 'issued' : 'retrieved', completeness: r.completeness, ...(r.detail ? { detail: r.detail } : {}) },
    }));
  }

  await Promise.all(jobs);
  const all = [...[...merged.values()].flat(), ...tsunamiAlerts];
  return { alerts: finish(all), statuses, diagnostics };
}

/**
 * @param {AlertsEnvelope | null} env
 * @param {string} sourceId
 * @returns {{ asOf: string | null, asOfBasis: import('../types.js').AsOfBasis | null, carriedForward: boolean } | null}
 */
function snapshotInputs(env, sourceId) {
  if (!env || env.completeness === 'rejected') return null;
  const f = snapshotSourceFacts(env, sourceId);
  if (!f.present || f.asOf === null) return null;
  return { asOf: f.asOf, asOfBasis: env.asOfBasis ?? 'issued', carriedForward: env.carriedForward || !f.ok };
}
