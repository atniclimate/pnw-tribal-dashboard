// @ts-check
/**
 * Relevance to Nations by typed zone membership and point-in-polygon of samples (blueprint 3.7.8).
 * DOM-free.
 *
 * - Zone-only NWS alerts: exact set membership of the alert's typed keys in the Nation's precomputed
 *   `nws.forecastZones`, `countyZones`, `fireZones`, and `marineZones`. No geometry math.
 * - Alerts with a polygon (NWS storm-based, ECCC): a Nation matches when one of its `samples`
 *   (headquarters plus interior points of its land areas, [lat, lon]) lies inside the polygon, or when
 *   the polygon's bounding box overlaps the Nation's bounding box (so a polygon that touches a land area
 *   between sample points is not missed; it errs toward showing the alert). The county list of a
 *   storm-based warning does not decide relevance by itself, because the forecaster's polygon is the
 *   precise area.
 * - ECCC alerts also match through `eccc.forecastZones` (the alert's `feature_id`).
 */
import { bboxIntersects, bboxOf, pointInGeometry } from '../core/geo.js';
import { inFootprint } from './footprint.js';
import { resolveLifecycle } from './lifecycle.js';

/** @typedef {import('../types.js').DashboardAlert} DashboardAlert */
/** @typedef {import('../types.js').DashboardAlertIndexEntry} DashboardAlertIndexEntry */
/** @typedef {import('../types.js').NationRecord} NationRecord */
/** @typedef {import('../types.js').Geometry} Geometry */

/** @type {WeakMap<NationRecord, Set<string>>} */
const zoneSets = new WeakMap();

/** @param {NationRecord} nation @returns {Set<string>} */
function nwsZoneSet(nation) {
  let s = zoneSets.get(nation);
  if (!s) {
    const n = nation.nws;
    s = new Set(n ? [...n.forecastZones, ...n.countyZones, ...n.fireZones, ...n.marineZones] : []);
    zoneSets.set(nation, s);
  }
  return s;
}

/**
 * @param {Geometry} geometry
 * @param {NationRecord} nation
 * @returns {boolean}
 */
function polygonMatches(geometry, nation) {
  for (const s of nation.samples ?? []) {
    if (Array.isArray(s) && s.length >= 2 && pointInGeometry([s[1], s[0]], geometry)) return true;
  }
  if (Array.isArray(nation.bbox) && nation.bbox.length === 4) {
    try {
      return bboxIntersects(bboxOf(geometry), nation.bbox);
    } catch {
      return false;
    }
  }
  return false;
}

/**
 * Nations a polygon covers by the polygon rule above (British Columbia provincial items use this).
 * @param {Geometry | null} geometry
 * @param {NationRecord[]} nations
 * @returns {string[]}
 */
export function nationIdsForGeometry(geometry, nations) {
  if (!geometry || (geometry.type !== 'Polygon' && geometry.type !== 'MultiPolygon')) return [];
  return nations.filter((n) => polygonMatches(geometry, n)).map((n) => n.id).sort();
}

/**
 * Exact zone set membership for NWS; samples in polygon for polygon alerts.
 * @param {DashboardAlert} alert
 * @param {NationRecord[]} nations
 * @returns {string[]}
 */
export function nationIdsForAlert(alert, nations) {
  /** @type {string[]} */
  const out = [];
  const featureIds = alert.agency === 'eccc' ? alert.parameters?.feature_id ?? [] : [];
  for (const nation of nations) {
    let match = false;
    if (alert.geometry && (alert.geometry.type === 'Polygon' || alert.geometry.type === 'MultiPolygon')) {
      match = polygonMatches(alert.geometry, nation);
    } else if (alert.agency === 'nws' && alert.zones.length > 0) {
      const zs = nwsZoneSet(nation);
      match = alert.zones.some((z) => zs.has(z));
    }
    if (!match && featureIds.length > 0 && nation.eccc) {
      match = featureIds.some((f) => nation.eccc?.forecastZones.includes(f) ?? false);
    }
    if (match) out.push(nation.id);
  }
  return out.sort();
}

// Lives in model.js so the alert list stays off the geometry modules.
export { groupForNation } from './model.js';

/**
 * Footprint filter, lifecycle resolution, and Nation relevance for one source's freshly normalized
 * alerts. Used by browser top-ups and by the Node snapshot task, so both apply identical rules.
 * @param {DashboardAlert[]} alerts
 * @param {{ now: Date, footprint?: { ugc: ReadonlySet<string>, bbox: [number, number, number, number] } | null, nations?: NationRecord[] | null }} opts
 * @returns {{ alerts: DashboardAlert[], outsideFootprint: number, superseded: number, cancelled: number, expired: number }}
 */
export function prepareAlerts(alerts, opts) {
  const kept = opts.footprint ? alerts.filter((a) => inFootprint(a, /** @type {NonNullable<typeof opts.footprint>} */ (opts.footprint))) : alerts;
  const life = resolveLifecycle(kept, opts.now);
  const nations = opts.nations ?? null;
  const out = nations ? life.current.map((a) => ({ ...a, nationIds: nationIdsForAlert(a, nations) })) : life.current;
  return {
    alerts: out,
    outsideFootprint: alerts.length - kept.length,
    superseded: life.superseded.length,
    cancelled: life.cancelled.length,
    expired: life.expired.length,
  };
}
