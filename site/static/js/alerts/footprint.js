// @ts-check
/**
 * Footprint filter and jurisdictions from UGC prefixes, never from areaDesc (blueprint 3.7.3, 3.7.8).
 * DOM-free.
 */
import { bboxIntersects, bboxOf } from '../core/geo.js';
import { isMarineCode, splitZoneKey } from './model.js';

/** @typedef {import('../types.js').Jurisdiction} Jurisdiction */
/** @typedef {import('../types.js').RegionCode} RegionCode */
/** @typedef {import('../types.js').ZoneKey} ZoneKey */
/** @typedef {import('../types.js').DashboardAlert} DashboardAlert */
/** @typedef {import('../types.js').DashboardAlertIndexEntry} DashboardAlertIndexEntry */
/** @typedef {{ ugc: ReadonlySet<string>, bbox: [number, number, number, number] }} FootprintIndex */

/**
 * UGC state prefix to jurisdiction. Prefixes outside Washington, Oregon, and Idaho name only the footprint
 * part of that state, because alerts are footprint-filtered before jurisdictions are read.
 * @type {Readonly<Record<string, Jurisdiction>>}
 */
export const PREFIX_TO_JURISDICTION = Object.freeze({
  WA: 'WA', OR: 'OR', ID: 'ID', CA: 'CA-N', MT: 'MT-W', NV: 'NV-N', AK: 'AK-SE',
});

/** @type {Readonly<Record<RegionCode, Jurisdiction>>} */
const REGION_TO_JURISDICTION = Object.freeze({
  wa: 'WA', or: 'OR', id: 'ID', bc: 'BC', 'ca-n': 'CA-N', 'mt-w': 'MT-W', 'nv-n': 'NV-N', 'ak-se': 'AK-SE',
});

/** Order used for every jurisdiction list the engine emits. @type {readonly Jurisdiction[]} */
export const JURISDICTION_ORDER = Object.freeze(/** @type {Jurisdiction[]} */ (['WA', 'OR', 'ID', 'BC', 'CA-N', 'MT-W', 'NV-N', 'AK-SE', 'MARINE']));

/**
 * Builds the footprint index from `site/data/geo/footprint-ugc.json` (lane L4) and the footprint bbox.
 * The set holds every typed key and every bare code, so either form matches.
 * @param {{ zones?: string[] } | null | undefined} footprintUgc
 * @param {[number, number, number, number]} bbox [west, south, east, north]
 * @returns {FootprintIndex}
 */
export function footprintIndex(footprintUgc, bbox) {
  /** @type {Set<string>} */
  const ugc = new Set();
  for (const z of footprintUgc?.zones ?? []) {
    if (typeof z !== 'string') continue;
    ugc.add(z);
    const i = z.indexOf(':');
    if (i > 0) ugc.add(z.slice(i + 1));
  }
  return { ugc, bbox };
}

/**
 * Any UGC in footprint-ugc.json, or the polygon intersects the footprint. NWS alerts match by typed key
 * (so a fire zone never matches through a public zone's code), by bare UGC geocode only when the alert
 * carries no typed zone, and by polygon bounding box only when it names no zone or UGC at all (the
 * agency's own zone list is the authoritative coverage). Non-NWS alerts (ECCC, NTWC) are always in the
 * footprint: their requests are already scoped.
 * @param {DashboardAlert | DashboardAlertIndexEntry} alert
 * @param {{ ugc: ReadonlySet<string>, bbox: [number, number, number, number] }} footprint
 * @returns {boolean}
 */
export function inFootprint(alert, footprint) {
  if (alert.agency !== 'nws') return true;
  if (alert.zones.length > 0) return alert.zones.some((k) => footprint.ugc.has(k));
  const codes = alert.provenance.coverage.geocodes.filter((g) => /^[A-Z]{2}[CZ]\d{3}$/.test(g));
  if (codes.length > 0) return codes.some((c) => footprint.ugc.has(c));
  // No zone information at all: the polygon decides.
  const geometry = 'geometry' in alert ? alert.geometry : null;
  if (geometry) {
    try {
      return bboxIntersects(bboxOf(geometry), footprint.bbox);
    } catch {
      return false;
    }
  }
  return false;
}

/**
 * PZZ and PKZ map to MARINE (plus the region of that water from marineToRegion, so a region filter such
 * as `j=wa` includes Puget Sound marine alerts); land zones and counties map by their state prefix. Never
 * derived from areaDesc text.
 * @param {ZoneKey[]} zones
 * @param {Record<string, RegionCode>} marineToRegion
 * @returns {Jurisdiction[]}
 */
export function jurisdictionsOf(zones, marineToRegion) {
  /** @type {Set<Jurisdiction>} */
  const out = new Set();
  for (const key of zones) {
    const { code } = splitZoneKey(key);
    if (isMarineCode(code)) {
      out.add('MARINE');
      const region = marineToRegion?.[code];
      if (region && REGION_TO_JURISDICTION[region]) out.add(REGION_TO_JURISDICTION[region]);
      continue;
    }
    const j = PREFIX_TO_JURISDICTION[code.slice(0, 2)];
    if (j) out.add(j);
  }
  return JURISDICTION_ORDER.filter((j) => out.has(j));
}
