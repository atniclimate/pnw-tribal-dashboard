// @ts-check
/**
 * Declarations loading for panels. DOM-free.
 *
 * Federal declarations come from the scheduled OpenFEMA copy (`data/live/declarations-fema.json`, already
 * grouped per disaster). When that copy is missing, rejected, or no longer fresh, the browser asks OpenFEMA
 * directly (paged with `$skip`, never silently capped) and groups the rows itself with the same module the
 * snapshot task uses. Tribal, state, provincial, county, and regional district declarations come from the
 * reviewed list compiled at build time (`data/curated/declarations.json`). Nothing here is simulated: when
 * a source cannot be read, its status says so and its list is empty.
 */
import { fetchJson, fetchLocal } from '../core/net.js';
import { deriveStatus } from '../core/status.js';
import { FEMA_PAGE_SIZE, femaQueryParams, groupFema } from './openfema.js';

/** @typedef {import('../types.js').StatusSnapshot} StatusSnapshot */
/** @typedef {import('../types.js').AlertScope} AlertScope */
/** @typedef {import('../types.js').CuratedDeclaration} CuratedDeclaration */
/** @typedef {import('../types.js').FemaDeclaration} FemaDeclaration */
/** @typedef {import('../types.js').NetResult} NetResult */
/** @typedef {import('../types.js').FetchOptions} FetchOptions */
/** @typedef {import('../types.js').FreshnessPolicy} FreshnessPolicy */
/**
 * @typedef {{
 *   fetchLocal: (path: string, opts?: FetchOptions) => Promise<NetResult>,
 *   fetchJson: (sourceId: string, opts?: FetchOptions) => Promise<NetResult>,
 *   deriveStatus: typeof deriveStatus,
 *   now: () => Date,
 * }} DeclarationDeps
 */

export const FEMA_ID = 'openfema-declarations';
export const CURATED_ID = 'cthd-curated-declarations';
/** OpenFEMA refreshes about once a day, so its stamp is fresh for thirty-six hours and usable for a week. */
export const FEMA_FRESHNESS = Object.freeze(/** @type {FreshnessPolicy} */ ({ freshForMs: 36 * 3_600_000, usableForMs: 7 * 86_400_000 }));
/** The curated file is rebuilt with every deploy; its rows carry their own review dates. */
export const CURATED_FRESHNESS = Object.freeze(/** @type {FreshnessPolicy} */ ({ freshForMs: 45 * 86_400_000, usableForMs: 90 * 86_400_000 }));
/** Direct paging stops at this many pages (six thousand rows) and says so. */
export const FEMA_MAX_PAGES = 6;
export const LIVE_FILE = 'data/live/declarations-fema.json';
export const CURATED_FILE = 'data/curated/declarations.json';

/** @type {DeclarationDeps} */
const DEFAULT_DEPS = { fetchLocal, fetchJson, deriveStatus, now: () => new Date() };

/** @param {unknown} v @returns {v is Record<string, unknown>} */
function isRecord(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * @param {NetResult} res
 * @returns {Record<string, any> | null} an envelope-shaped object with an items array, or null
 */
function envelopeOf(res) {
  return res.ok && isRecord(res.data) && Array.isArray(res.data.items) ? /** @type {Record<string, any>} */ (res.data) : null;
}

/**
 * Footprint county codes for the edge states, from the footprint zone index.
 * @param {unknown} doc
 * @returns {Set<string> | null}
 */
function countyCodes(doc) {
  if (!isRecord(doc) || !Array.isArray(doc.zones)) return null;
  return new Set(doc.zones.filter((z) => typeof z === 'string' && z.startsWith('county:')).map((z) => /** @type {string} */ (z).slice('county:'.length)));
}

/**
 * Ask OpenFEMA directly, following `$skip` until a page comes back short.
 * @param {DeclarationDeps} deps
 * @param {Date} now
 * @param {AbortSignal | undefined} signal
 * @returns {Promise<{ ok: true, items: FemaDeclaration[], asOf: string | null, partial: boolean, detail: string | null } | { ok: false, error: import('../types.js').NetError }>}
 */
async function directFema(deps, now, signal) {
  /** @type {unknown[]} */
  const rows = [];
  let truncated = false;
  for (let page = 0; page < FEMA_MAX_PAGES; page += 1) {
    const res = await deps.fetchJson(FEMA_ID, { params: femaQueryParams(now, page * FEMA_PAGE_SIZE), priority: 1, ...(signal ? { signal } : {}) });
    if (!res.ok) return { ok: false, error: res.error };
    const batch = isRecord(res.data) && Array.isArray(res.data.DisasterDeclarationsSummaries) ? res.data.DisasterDeclarationsSummaries : null;
    if (batch === null) return { ok: false, error: { kind: 'parse', message: 'OpenFEMA returned an unexpected format' } };
    rows.push(...batch);
    if (batch.length < FEMA_PAGE_SIZE) break;
    if (page === FEMA_MAX_PAGES - 1) truncated = true;
  }
  const [index, footprint] = await Promise.all([
    deps.fetchLocal('data/registry/nations-index.json', { priority: 1, ...(signal ? { signal } : {}) }),
    deps.fetchLocal('data/geo/footprint-ugc.json', { priority: 1, ...(signal ? { signal } : {}) }),
  ]);
  const indexDoc = index.ok && isRecord(index.data) ? index.data : null;
  /** @type {import('../types.js').NationIndexEntry[]} */
  const nations = indexDoc && Array.isArray(indexDoc.nations) ? /** @type {any[]} */ (indexDoc.nations) : [];
  const counties = footprint.ok ? countyCodes(footprint.data) : null;
  const grouped = groupFema(rows, { nations, footprintCountyCodes: counties });
  /** @type {string[]} */
  const notes = [];
  if (truncated) notes.push('Partial: not every page of OpenFEMA rows could be loaded.');
  if (nations.length === 0) notes.push('Tribal Nation matching was not available, so Nation names are not attached.');
  if (counties === null) notes.push('The footprint county list was not available, so edge-state counties are not included.');
  return { ok: true, items: grouped.items, asOf: grouped.latestRefresh, partial: notes.length > 0, detail: notes.length > 0 ? notes.join(' ') : null };
}

/**
 * @param {FemaDeclaration[]} items
 * @param {AlertScope} scope
 * @returns {FemaDeclaration[]}
 */
function nationFirst(items, scope) {
  if (scope.kind !== 'nation') return items;
  const id = scope.nation.id;
  return [...items.filter((d) => d.nationIds.includes(id)), ...items.filter((d) => !d.nationIds.includes(id))];
}

/**
 * @param {{ scope: AlertScope, signal?: AbortSignal, deps?: Partial<DeclarationDeps> }} opts
 * @returns {Promise<{ fema: FemaDeclaration[], curated: CuratedDeclaration[], statuses: Map<string, StatusSnapshot> }>}
 */
export async function loadDeclarations(opts) {
  const deps = { ...DEFAULT_DEPS, ...(opts.deps ?? {}) };
  const sig = opts.signal ? { signal: opts.signal } : {};
  const now = deps.now();
  /** @type {Map<string, StatusSnapshot>} */
  const statuses = new Map();

  const [snapRes, curatedRes] = await Promise.all([
    deps.fetchLocal(LIVE_FILE, { priority: 1, ...sig }),
    deps.fetchLocal(CURATED_FILE, { priority: 2, ...sig }),
  ]);

  // Federal declarations: scheduled copy first, direct OpenFEMA when the copy cannot be trusted.
  const env = envelopeOf(snapRes);
  const usable = env !== null && env.completeness !== 'rejected' && typeof env.asOf === 'string' && !Number.isNaN(Date.parse(env.asOf));
  const snapshot = usable ? { asOf: /** @type {string} */ (env.asOf), asOfBasis: env.asOfBasis ?? 'retrieved', carriedForward: Boolean(env.carriedForward) } : null;
  const unavailableReason = 'The scheduled copy of federal declarations is not available.';
  let femaStatus = deps.deriveStatus({ sourceIds: [FEMA_ID], policy: FEMA_FRESHNESS, now, snapshot, direct: null, unavailableReason });
  /** @type {FemaDeclaration[]} */
  let fema = usable ? /** @type {any[]} */ (env.items).filter((i) => isRecord(i) && typeof i.id === 'string' && Array.isArray(i.designatedAreas)) : [];
  if (!usable || femaStatus.state === 'stale' || femaStatus.state === 'degraded') {
    const direct = await directFema(deps, now, opts.signal);
    if (direct.ok) {
      fema = direct.items;
      femaStatus = deps.deriveStatus({
        sourceIds: [FEMA_ID], policy: FEMA_FRESHNESS, now, snapshot,
        direct: { ok: true, asOf: direct.asOf ?? now.toISOString(), asOfBasis: direct.asOf ? 'issued' : 'retrieved', completeness: direct.partial ? 'partial' : 'complete', ...(direct.detail ? { detail: direct.detail } : {}) },
      });
    } else if (opts.signal?.aborted !== true) {
      femaStatus = deps.deriveStatus({ sourceIds: [FEMA_ID], policy: FEMA_FRESHNESS, now, snapshot, direct: { ok: false, error: direct.error }, unavailableReason });
    }
  }
  statuses.set(FEMA_ID, femaStatus);

  // Curated declarations: the reviewed list compiled at build time.
  const cEnv = envelopeOf(curatedRes);
  const curatedOk = cEnv !== null && typeof cEnv.generatedAt === 'string' && !Number.isNaN(Date.parse(cEnv.generatedAt));
  /** @type {CuratedDeclaration[]} */
  const curated = curatedOk ? /** @type {any[]} */ (cEnv.items).filter((i) => isRecord(i) && typeof i.id === 'string' && isRecord(i.source)) : [];
  const curatedBase = deps.deriveStatus({
    sourceIds: [CURATED_ID], policy: CURATED_FRESHNESS, now,
    snapshot: curatedOk ? { asOf: /** @type {string} */ (cEnv.generatedAt), asOfBasis: 'retrieved', carriedForward: false } : null,
    direct: null,
    unavailableReason: 'The reviewed list of Tribal, state, and provincial declarations is not available.',
  });
  statuses.set(CURATED_ID, curatedBase.state === 'live'
    ? { ...curatedBase, detail: 'Compiled from the reviewed list; each row shows its own verification date.' }
    : curatedBase);

  return { fema: nationFirst(fema, opts.scope), curated, statuses };
}
