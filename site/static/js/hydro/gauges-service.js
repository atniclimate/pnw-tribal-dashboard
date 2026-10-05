// @ts-check
/**
 * Gauge loading for panels: reference plus live status. DOM-free.
 *
 * Owner: lane L7. Reads only same-origin files (ref/gauges.json, ref/wsc-stations.json, live/gauges-status.json,
 * live/wsc-status.json); the full-footprint NWPS list is snapshot-only (blueprint 5.5). Network and status
 * derivation come from core/net.js and core/status.js, replaceable through `opts.deps` for tests.
 */

import { fetchLocal } from '../core/net.js';
import { deriveStatus } from '../core/status.js';

/** @typedef {import('../types.js').StatusSnapshot} StatusSnapshot */
/** @typedef {import('../types.js').NationRecord} NationRecord */
/** @typedef {import('../types.js').Gauge} Gauge */
/** @typedef {import('../types.js').GaugeStatus} GaugeStatus */

/** Gauge freshness (blueprint 3.9): fresh for 30 minutes, usable for 6 hours. */
export const GAUGE_POLICY = Object.freeze({ freshForMs: 30 * 60 * 1000, usableForMs: 6 * 60 * 60 * 1000 });
export const NEARBY_KM = 25;
export const NEARBY_LIMIT = 6;
const SOURCE_IDS = ['nwps-gauges', 'eccc-hydrometric-realtime'];

/**
 * @typedef {{ fetchLocal: typeof fetchLocal, deriveStatus: typeof deriveStatus, now?: () => Date }} GaugeDeps
 */

/**
 * Great-circle distance in kilometres (local copy so nearby ranking never depends on module load order).
 * @param {[number, number]} a [lat, lon]
 * @param {[number, number]} b [lat, lon]
 * @returns {number}
 */
function km(a, b) {
  const rad = Math.PI / 180;
  const dLat = (b[0] - a[0]) * rad;
  const dLon = (b[1] - a[1]) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[0] * rad) * Math.cos(b[0] * rad) * Math.sin(dLon / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(h));
}

/**
 * @param {import('../types.js').NetResult} res
 * @returns {unknown | null}
 */
function dataOf(res) {
  return res && res.ok ? res.data : null;
}

/**
 * A reference station as a Gauge, so lists and maps handle one shape.
 * @param {Record<string, any>} s
 * @returns {Gauge}
 */
function stationAsGauge(s) {
  return {
    id: s.id, country: 'CA', agency: 'WSC', lid: null, usgsId: null, wscId: String(s.id).slice(4), name: s.name, river: null,
    region: s.region, wfo: null, rfc: null, lat: s.lat, lon: s.lon, timeZone: s.timeZone, stages: null,
    isForecastPoint: false, hydrographImage: null, links: s.links ?? {}, nationIds: s.nationIds ?? [], selection: 'auto',
  };
}

/**
 * @param {{ nation: NationRecord | null, signal?: AbortSignal, deps?: GaugeDeps }} opts
 * @returns {Promise<{ gauges: Gauge[], statuses: Map<string, GaugeStatus>, status: StatusSnapshot }>}
 */
export async function loadGauges(opts) {
  const deps = opts.deps ?? { fetchLocal, deriveStatus };
  const now = deps.now ? deps.now() : new Date();
  const fo = opts.signal ? { signal: opts.signal } : {};
  const [refUs, refCa, liveUs, liveCa] = await Promise.all([
    deps.fetchLocal('data/ref/gauges.json', fo),
    deps.fetchLocal('data/ref/wsc-stations.json', fo),
    deps.fetchLocal('data/live/gauges-status.json', fo),
    deps.fetchLocal('data/live/wsc-status.json', fo),
  ]);
  /** @type {Gauge[]} */
  const gauges = [];
  const usRef = /** @type {{ gauges?: Gauge[] } | null} */ (dataOf(refUs));
  const caRef = /** @type {{ stations?: Record<string, any>[] } | null} */ (dataOf(refCa));
  if (usRef?.gauges) gauges.push(...usRef.gauges);
  if (caRef?.stations) gauges.push(...caRef.stations.map(stationAsGauge));

  /** @type {Map<string, GaugeStatus>} */
  const statuses = new Map();
  /** @type {{ asOf: string, carriedForward: boolean }[]} */
  const stamps = [];
  let anyLive = false;
  let partial = false;
  for (const res of [liveUs, liveCa]) {
    const env = /** @type {import('../types.js').LiveEnvelope<GaugeStatus> | null} */ (dataOf(res));
    if (!env || !Array.isArray(env.items)) continue;
    if (env.completeness === 'rejected') continue;
    anyLive = true;
    if (env.completeness === 'partial') partial = true;
    for (const item of env.items) statuses.set(item.id, item);
    if (env.asOf) stamps.push({ asOf: env.asOf, carriedForward: env.carriedForward });
  }

  /** @type {StatusSnapshot} */
  let status;
  if (gauges.length === 0 || !anyLive) {
    status = deps.deriveStatus({
      sourceIds: SOURCE_IDS, policy: GAUGE_POLICY, now,
      unavailableReason: gauges.length === 0 ? 'The gauge reference list could not be read.' : 'Gauge readings are not available right now.',
    });
  } else {
    // The oldest upstream time governs: a panel is only as current as its stalest feed.
    const oldest = stamps.length ? stamps.reduce((a, b) => (Date.parse(a.asOf) <= Date.parse(b.asOf) ? a : b)) : null;
    status = deps.deriveStatus({
      sourceIds: SOURCE_IDS, policy: GAUGE_POLICY, now,
      snapshot: { asOf: oldest ? oldest.asOf : null, asOfBasis: oldest ? 'valid' : null, carriedForward: stamps.some((s) => s.carriedForward) },
    });
    if (partial && status.completeness === 'complete') status = { ...status, completeness: 'partial' };
  }
  return { gauges, statuses, status };
}

/**
 * The Nation record gauges list first, nearest first ("Nearby gauges").
 * When the record lists none, gauges within 25 km of any sample point (or the headquarters), forecast
 * points first then by distance, at most six. Never "gauges affecting"; never inferred upstream or downstream.
 * @param {NationRecord} nation
 * @param {Gauge[]} gauges
 * @returns {Gauge[]}
 */
export function nearbyGauges(nation, gauges) {
  const byId = new Map(gauges.map((g) => [g.id, g]));
  if (Array.isArray(nation.gauges) && nation.gauges.length > 0) {
    return nation.gauges.map((id) => byId.get(id)).filter((g) => g !== undefined);
  }
  /** @type {[number, number][]} */
  const points = Array.isArray(nation.samples) && nation.samples.length > 0 ? nation.samples
    : nation.hq ? [[nation.hq.lat, nation.hq.lon]] : [];
  if (points.length === 0) return [];
  const ranked = [];
  for (const g of gauges) {
    let best = Infinity;
    for (const p of points) best = Math.min(best, km(p, [g.lat, g.lon]));
    if (best <= NEARBY_KM) ranked.push({ g, d: best });
  }
  ranked.sort((a, b) => (Number(b.g.isForecastPoint) - Number(a.g.isForecastPoint)) || (a.d - b.d) || (a.g.id < b.g.id ? -1 : 1));
  return ranked.slice(0, NEARBY_LIMIT).map((r) => r.g);
}
