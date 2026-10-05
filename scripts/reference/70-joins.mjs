// @ts-check
/**
 * Reference builder 70: joins and the projection of the draft registry into site/data (blueprint 6.2 and 12.3, lane L5).
 *
 *   node scripts/reference/70-joins.mjs [--raw <folder> ...]
 *
 * Run order: 50-registry, 40-boundaries, then this file. It reads
 *   data/registry/draft-registry.json            the draft records (50)
 *   data/registry/boundaries-build.json          parts, bbox, and interior samples per Nation (40)
 *   site/data/geo/boundaries/<id>.json           the detail polygons (40), for the zone overlap test
 *   site/data/geo/{nws-zones.topo.json,footprint-ugc.json,eccc-regions.topo.json}   zone geometry (L4)
 *   site/data/ref/{radar-sites,gauges,wsc-stations}.json                              radar and gauges (L4, L7)
 *   data/registry/eccc-citypage-sites.json       the 98 British Columbia city pages of ECCC, a dated capture
 *   the NWS public forecast zone shapefile        zone to forecast office (WFO), from the pinned L4 input
 * and writes
 *   data/registry/joins-build.json                per-Nation nws, eccc, radar, and gauges plus the join report
 *   site/data/registry/nations/<id>.json, nations-index.json, id-redirects.json, site/data/geo/hq-points.json
 *
 * Join rules (every one is a documented policy, never an invented value; every record stays `review.status: draft`):
 *   nws        U.S. Nations only. A zone is listed when it contains the headquarters, an interior sample, or the inner point
 *              of any land-area part (each part also takes the nearest zone within five kilometres when none contains it), or covers at
 *              least two percent of the land area (grid of points inside the detail polygons; zone edges are simplified to
 *              about 1.2 km); a headquarters that no zone contains takes the nearest zone within five kilometres. Marine zones are those within ten kilometres of the headquarters or an interior sample.
 *              `wfo` is the forecast office of those forecast zones, headquarters zone first. `point` is the headquarters.
 *   eccc       British Columbia Nations only. The nearest city page by haversine distance (any distance, shown as such) and
 *              the ECCC public forecast zones by the same overlap rule.
 *   radar      The nearest U.S. NWS radar site by haversine distance when within 460 km (the long range of the WSR-88D
 *              base reflectivity product), else null. `ridgeLoop` is the same site when RIDGE publishes it. ECCC radar
 *              sites have no machine-readable list, so `eccc` stays null.
 *   gauges     NWPS gauges and Water Survey of Canada stations within 25 km of the headquarters or an interior sample, ranked
 *              with the Nation's own country first, then NWS forecast points, then nearest; at most six; then the reviewed
 *              Nation entries of gauges-overrides.yaml (blueprint 6.2). "Nearby gauges", never "gauges affecting".
 *   samples    The headquarters first, then up to eight interior points of the land areas (40-boundaries).
 *   bbox       Of all land areas, else the headquarters plus ten kilometres.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import mapshaper from 'mapshaper';
import { feature } from 'topojson-client';
import { ROOT } from '../check/lib/pages.mjs';
import { parseCsv, parseDataFile } from '../check/lib/data-files.mjs';
import { REGISTRY_DIR, distanceToOutlineKm, haversineKm, pointInGeometry, r5, stable } from './50-registry.mjs';

/** @param {number} x */
export const r4 = (x) => Math.round(x * 1e4) / 1e4;

/** Compact JSON for the headquarters layer (no indentation; trailing newline). @param {unknown} v */
export const compact = (v) => `${JSON.stringify(v)}\n`;

export const SITE_REGISTRY = path.join(ROOT, 'site', 'data', 'registry');
export const SITE_GEO = path.join(ROOT, 'site', 'data', 'geo');
export const JOINS_FILE = path.join(REGISTRY_DIR, 'joins-build.json');

/** Join policy constants (see the header). */
export const POLICY = Object.freeze({
  zoneLandShare: 0.02,
  marineKm: 10,
  snapKm: 5,
  radarMaxKm: 460,
  gaugeKm: 25,
  maxGauges: 6,
  gridMinStepKm: 0.2,
  gridMaxStepKm: 3,
});

/** Wave 2 joins still pending when the build files are absent. */
export const PENDING_JOINS = Object.freeze(['nws zone keys', 'eccc city page', 'radar', 'gauges', 'boundary polygons', 'interior samples']);

/**
 * Headquarters plus 10 km on every side.
 * @param {number} lat @param {number} lon
 * @returns {[number, number, number, number]}
 */
export function hqBbox(lat, lon) {
  const dLat = 10 / 111.32;
  const dLon = 10 / (111.32 * Math.cos((lat * Math.PI) / 180));
  return [r5(lon - dLon), r5(lat - dLat), r5(lon + dLon), r5(lat + dLat)];
}

/**
 * Pure projection of the draft registry (testable; no file access). `builds` carries the boundary and join results;
 * without it the projection is the wave 1 one (headquarters sample and bbox, no joins).
 * @param {{ generatedAt: string, records: Record<string, any>[] }} draft
 * @param {{ redirects: Record<string, unknown> }} redirects
 * @param {{ boundaries?: { nations: Record<string, any> } | null, joins?: { nations: Record<string, any> } | null }} [builds]
 */
export function project(draft, redirects, builds = {}) {
  const bNations = builds.boundaries?.nations ?? {};
  const jNations = builds.joins?.nations ?? {};
  /** @type {Record<string, any>[]} */
  const records = draft.records.map((r) => {
    const b = bNations[r.id];
    const j = jNations[r.id];
    return {
      ...r,
      samples: [[r.hq.lat, r.hq.lon], ...(b ? b.interiorSamples : [])],
      bbox: b ? b.bbox : hqBbox(r.hq.lat, r.hq.lon),
      boundary: b
        ? { status: 'polygon', detailRef: `geo/boundaries/${r.id}.json`, parts: b.parts }
        : { status: 'point-only', detailRef: null, parts: [] },
      nws: j ? j.nws : r.nws,
      eccc: j ? j.eccc : r.eccc,
      radar: j ? j.radar : r.radar,
      gauges: j ? j.gauges : r.gauges,
    };
  });
  const index = {
    schema: 'cthd.nations-index/1',
    generatedAt: draft.generatedAt,
    nations: records.map((r) => ({
      id: r.id, name: r.name, preferredName: r.preferredName, aliases: r.aliases, jurisdictions: r.jurisdictions,
      region: r.region, kind: r.kind, hq: [r.hq.lat, r.hq.lon], tz: r.timeZone, hasBoundary: r.boundary.status === 'polygon',
    })),
  };
  // The layer is limited to 40 KB raw (budgets.json geometry.hqPoints.rawMax), so each feature carries only the promoted id
  // `nationId`. Display names and `hasBoundary` come from nations-index.json by the same id (map/layers/hq.js joins them);
  // writing `hasBoundary: true` on about nine in ten features would put the file over budget. Four-decimal coordinates (about 11 m).
  const hqPoints = {
    type: 'FeatureCollection',
    features: records.map((r) => ({
      type: 'Feature',
      properties: { nationId: r.id },
      geometry: { type: 'Point', coordinates: [r4(r.hq.lon), r4(r.hq.lat)] },
    })),
  };
  return { records, index, hqPoints, redirects };
}

// ---------------------------------------------------------------------------------------------
// Zone overlap
// ---------------------------------------------------------------------------------------------

/** @param {any} geom @returns {[number, number, number, number]} */
function geomBbox(geom) {
  let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
  const polys = geom.type === 'Polygon' ? [geom.coordinates] : geom.coordinates;
  for (const p of polys) for (const ring of p) for (const pt of ring) { const x = /** @type {number} */ (pt[0]); const y = /** @type {number} */ (pt[1]); if (x < w) w = x; if (x > e) e = x; if (y < s) s = y; if (y > n) n = y; }
  return [w, s, e, n];
}

/**
 * Zone features from a TopoJSON file, with their bounding boxes.
 * @param {any} topo @param {string} object
 * @returns {{ id: string, name: string, bbox: [number, number, number, number], geometry: any }[]}
 */
export function zonesFromTopo(topo, object) {
  const fc = /** @type {any} */ (feature(topo, topo.objects[object]));
  return fc.features.map((/** @type {any} */ f) => ({ id: String(f.id ?? f.properties.id), name: String(f.properties?.name ?? ''), geometry: f.geometry, bbox: geomBbox(f.geometry) }));
}

/**
 * Grid of points inside one polygon feature, each carrying the area (km squared) it stands for.
 * The step grows with the polygon so a large reservation gets a few hundred points and a rancheria a few dozen.
 * @param {any} geom
 * @returns {{ lon: number, lat: number, w: number }[]}
 */
export function gridInside(geom) {
  const [w, s, e, n] = geomBbox(geom);
  const midLat = (s + n) / 2;
  const kmLon = 111.32 * Math.cos((midLat * Math.PI) / 180);
  const widthKm = (e - w) * kmLon;
  const heightKm = (n - s) * 110.57;
  const step = Math.min(POLICY.gridMaxStepKm, Math.max(POLICY.gridMinStepKm, Math.sqrt(Math.max(widthKm * heightKm, 0.01)) / 20));
  const dLon = step / kmLon;
  const dLat = step / 110.57;
  /** @type {{ lon: number, lat: number, w: number }[]} */
  const pts = [];
  for (let lat = s + dLat / 2; lat < n; lat += dLat) {
    for (let lon = w + dLon / 2; lon < e; lon += dLon) if (pointInGeometry(lon, lat, geom)) pts.push({ lon, lat, w: step * step });
  }
  return pts;
}

/** @typedef {{ id: string, bbox: [number, number, number, number], geometry: any }} Zone */

/**
 * Whether a point lies within a distance of a bounding box (a cheap prefilter; degrees of longitude shrink with latitude).
 * @param {{ lat: number, lon: number }} a @param {[number, number, number, number]} bbox @param {number} km
 */
function nearBbox(a, bbox, km) {
  const dLat = km / 110.57;
  const dLon = km / (111.32 * Math.max(0.05, Math.cos((a.lat * Math.PI) / 180)));
  return a.lon >= bbox[0] - dLon && a.lon <= bbox[2] + dLon && a.lat >= bbox[1] - dLat && a.lat <= bbox[3] + dLat;
}

/**
 * Zones that contain the headquarters, an interior sample, or a part's inner point (a part outside every zone takes the
 * nearest within POLICY.snapKm), or cover at least POLICY.zoneLandShare of the land.
 * Ordered: the headquarters zone first, then by land share, then by id.
 * @param {Zone[]} zones
 * @param {{ lat: number, lon: number }[]} anchors headquarters first, then interior samples
 * @param {{ lon: number, lat: number, w: number }[]} grid
 * @param {{ lat: number, lon: number }[]} [partPoints] the inner point of every land-area part (40-boundaries)
 * @returns {string[]}
 */
export function overlappingZones(zones, anchors, grid, partPoints = []) {
  const total = grid.reduce((n, p) => n + p.w, 0);
  /** @type {Map<string, { share: number, anchor: boolean, hq: boolean }>} */
  const hit = new Map();
  const touch = (/** @type {string} */ id) => { let h = hit.get(id); if (!h) { h = { share: 0, anchor: false, hq: false }; hit.set(id, h); } return h; };
  /** @type {boolean[]} */
  const partInside = partPoints.map(() => false);
  for (const z of zones) {
    const [w, s, e, n] = z.bbox;
    anchors.forEach((a, i) => {
      if (!nearBbox(a, z.bbox, 0)) return;
      if (pointInGeometry(a.lon, a.lat, z.geometry)) { const h = touch(z.id); h.anchor = true; if (i === 0) h.hq = true; }
    });
    // Every part of the land area anchors its own zone (review R3), so a small outlying reserve is never left without one.
    partPoints.forEach((a, i) => {
      if (!nearBbox(a, z.bbox, 0)) return;
      if (pointInGeometry(a.lon, a.lat, z.geometry)) { touch(z.id).anchor = true; partInside[i] = true; }
    });
    let share = 0;
    for (const p of grid) if (p.lon >= w && p.lon <= e && p.lat >= s && p.lat <= n && pointInGeometry(p.lon, p.lat, z.geometry)) share += p.w;
    if (share > 0) touch(z.id).share = total ? share / total : 0;
  }
  /** @param {{ lat: number, lon: number }} a @returns {string} the nearest zone within POLICY.snapKm, or '' */
  const snap = (a) => {
    let bestId = '';
    let bestKm = Infinity;
    for (const z of zones) {
      if (!nearBbox(a, z.bbox, POLICY.snapKm)) continue;
      const km = distanceToOutlineKm(a.lon, a.lat, z.geometry);
      if (km < bestKm || (km === bestKm && z.id < bestId)) { bestKm = km; bestId = z.id; }
    }
    return bestId && bestKm <= POLICY.snapKm ? bestId : '';
  };
  // A shoreline headquarters can fall just outside a simplified zone (Craig, Alaska, is 0.4 km off the Prince of Wales Island
  // zone). When no zone contains it, the nearest zone within POLICY.snapKm is taken as its zone. Islet and shoreline
  // reserve parts take the same fallback, one part at a time.
  const anchor = anchors[0];
  if (anchor && ![...hit.values()].some((h) => h.hq)) {
    const id = snap(anchor);
    if (id) { const h = touch(id); h.anchor = true; h.hq = true; }
  }
  partPoints.forEach((a, i) => {
    if (partInside[i]) return;
    const id = snap(a);
    if (id) touch(id).anchor = true;
  });
  return [...hit.entries()]
    .filter(([, h]) => h.anchor || h.share >= POLICY.zoneLandShare)
    .sort((a, b) => Number(b[1].hq) - Number(a[1].hq) || b[1].share - a[1].share || (a[0] < b[0] ? -1 : 1))
    .map(([id]) => id);
}

/**
 * Marine zones within POLICY.marineKm of the headquarters or an interior sample (or containing one), nearest first.
 * @param {Zone[]} zones @param {{ lat: number, lon: number }[]} anchors
 * @returns {string[]}
 */
export function nearMarineZones(zones, anchors) {
  /** @type {{ id: string, km: number }[]} */
  const out = [];
  for (const z of zones) {
    let best = Infinity;
    for (const a of anchors) {
      if (!nearBbox(a, z.bbox, POLICY.marineKm)) continue;
      const km = pointInGeometry(a.lon, a.lat, z.geometry) ? 0 : distanceToOutlineKm(a.lon, a.lat, z.geometry);
      if (km < best) best = km;
    }
    if (best <= POLICY.marineKm) out.push({ id: z.id, km: best });
  }
  return out.sort((a, b) => a.km - b.km || (a.id < b.id ? -1 : 1)).map((x) => x.id);
}

/**
 * Nearest radar site within range.
 * @param {{ id: string, lat: number, lon: number, ridge?: boolean }[]} sites @param {{ lat: number, lon: number }} hq
 * @returns {{ nexrad: string | null, ridgeLoop: string | null, eccc: null }}
 */
export function nearestRadar(sites, hq) {
  let best = /** @type {typeof sites[number] | null} */ (null);
  let bestKm = Infinity;
  for (const s of sites) { const km = haversineKm(hq.lat, hq.lon, s.lat, s.lon); if (km < bestKm || (km === bestKm && best && s.id < best.id)) { best = s; bestKm = km; } }
  if (!best || bestKm > POLICY.radarMaxKm) return { nexrad: null, ridgeLoop: null, eccc: null };
  return { nexrad: best.id, ridgeLoop: best.ridge === false ? null : best.id, eccc: null };
}

/**
 * Nearby gauges (blueprint 6.2): gauges within POLICY.gaugeKm of any sample point, ranked with the Nation's own country
 * first, then NWS forecast points, then by distance; the top POLICY.maxGauges; then the reviewed Nation-specific entries
 * of gauges-overrides.yaml (`add` appends past the cap, `remove` drops). "Nearby gauges", never "gauges affecting".
 * @param {{ id: string, lat: number, lon: number, country?: string, isForecastPoint?: boolean }[]} gauges
 * @param {{ lat: number, lon: number }[]} anchors
 * @param {{ country?: string, nationId?: string, overrides?: { gaugeId: string, action: string, nationIds?: string[] }[] }} [opts]
 * @returns {string[]}
 */
export function nearbyGauges(gauges, anchors, opts = {}) {
  /** @type {{ id: string, km: number, own: boolean, fp: boolean }[]} */
  const out = [];
  for (const g of gauges) {
    let best = Infinity;
    for (const a of anchors) best = Math.min(best, haversineKm(a.lat, a.lon, g.lat, g.lon));
    if (best <= POLICY.gaugeKm) out.push({ id: g.id, km: best, own: !opts.country || !g.country || g.country === opts.country, fp: g.isForecastPoint === true });
  }
  const ids = out
    .sort((a, b) => Number(b.own) - Number(a.own) || Number(b.fp) - Number(a.fp) || a.km - b.km || (a.id < b.id ? -1 : 1))
    .slice(0, POLICY.maxGauges).map((x) => x.id);
  for (const o of opts.overrides ?? []) {
    if (!opts.nationId || !o.nationIds?.includes(opts.nationId)) continue;
    if (o.action === 'add' && !ids.includes(o.gaugeId)) ids.push(o.gaugeId);
    if (o.action === 'remove') { const i = ids.indexOf(o.gaugeId); if (i >= 0) ids.splice(i, 1); }
  }
  return ids;
}

/**
 * Gauge candidates for the joins: NWPS gauges with their country and forecast-point flag, and Water Survey of Canada
 * stations (Canada, never NWS forecast points).
 * @param {{ gauges: any[] }} gaugesDoc site/data/ref/gauges.json
 * @param {{ stations: any[] }} wscDoc site/data/ref/wsc-stations.json
 * @returns {{ id: string, lat: number, lon: number, country: string, isForecastPoint: boolean }[]}
 */
export function gaugeCandidates(gaugesDoc, wscDoc) {
  return [
    ...gaugesDoc.gauges.map((g) => ({ id: String(g.id), lat: g.lat, lon: g.lon, country: String(g.country ?? 'US'), isForecastPoint: g.isForecastPoint === true })),
    ...wscDoc.stations.map((s) => ({ id: String(s.id), lat: s.lat, lon: s.lon, country: 'CA', isForecastPoint: false })),
  ];
}

/**
 * Nearest city page with the distance from the headquarters.
 * @param {{ id: string, name: string, lat: number, lon: number }[]} sites @param {{ lat: number, lon: number }} hq
 */
export function nearestCityPage(sites, hq) {
  let best = /** @type {typeof sites[number] | null} */ (null);
  let bestKm = Infinity;
  for (const s of sites) { const km = haversineKm(hq.lat, hq.lon, s.lat, s.lon); if (km < bestKm) { best = s; bestKm = km; } }
  return best ? { citypageId: best.id, citypageName: best.name, distanceKm: Math.round(bestKm * 10) / 10 } : null;
}

// ---------------------------------------------------------------------------------------------
// The join build
// ---------------------------------------------------------------------------------------------

/** @param {string} rel */
const readJson = (rel) => JSON.parse(readFileSync(path.join(ROOT, rel), 'utf8'));

/**
 * Forecast zone key to forecast office, from the pinned NWS public zone shapefile.
 * @param {Buffer} zip
 * @returns {Promise<Map<string, string>>}
 */
export async function cwaByForecastZone(zip) {
  const out = /** @type {Record<string, Buffer | string>} */ (await mapshaper.applyCommands('-i z.zip -filter-fields STATE,ZONE,CWA -o z.csv', { 'z.zip': zip }));
  /** @type {Map<string, string>} */
  const map = new Map();
  for (const r of parseCsv(String(out['z.csv']))) if (r.STATE && r.ZONE && r.CWA) map.set(`forecast:${r.STATE}Z${r.ZONE}`, String(r.CWA).trim());
  return map;
}

/**
 * @param {{ records: Record<string, any>[], boundaries: { nations: Record<string, any> }, detail: (id: string) => any | null,
 *   nwsZones: ReturnType<typeof zonesFromTopo>, ecccZones: ReturnType<typeof zonesFromTopo>, cwa: Map<string, string>,
 *   citypages: { id: string, name: string, lat: number, lon: number }[], radar: any[], gauges: any[],
 *   gaugeOverrides?: { gaugeId: string, action: string, nationIds?: string[] }[] }} p
 */
export function computeJoins(p) {
  /** @type {Record<string, any>} */
  const nations = {};
  const bucket = (/** @type {string} */ prefix) => p.nwsZones.filter((z) => z.id.startsWith(prefix));
  const forecast = bucket('forecast:');
  const county = bucket('county:');
  const fire = bucket('fire:');
  const marine = bucket('marine:');
  /** @type {string[]} */
  const noForecastZone = [];
  /** @type {string[]} */
  const noWfo = [];
  for (const r of p.records) {
    const b = p.boundaries.nations[r.id];
    const anchors = [{ lat: r.hq.lat, lon: r.hq.lon }, ...(b ? b.interiorSamples.map((/** @type {number[]} */ s) => ({ lat: s[0], lon: s[1] })) : [])];
    const parts = (b?.partPoints ?? []).map((/** @type {number[]} */ s) => ({ lat: s[0], lon: s[1] }));
    /** @type {{ lon: number, lat: number, w: number }[]} */
    const grid = [];
    const detail = b ? p.detail(r.id) : null;
    if (detail) for (const f of detail.features) grid.push(...gridInside(f.geometry));
    /** @type {any} */
    let nws = null;
    /** @type {any} */
    let eccc = null;
    if (r.country === 'US') {
      const fz = overlappingZones(forecast, anchors, grid, parts);
      if (!fz.length) noForecastZone.push(r.id);
      const offices = [...new Set(fz.map((k) => p.cwa.get(k)).filter(Boolean))];
      if (!offices.length) noWfo.push(r.id);
      nws = {
        wfo: offices.length ? offices : [],
        point: [r4(r.hq.lat), r4(r.hq.lon)],
        forecastZones: fz,
        countyZones: overlappingZones(county, anchors, grid, parts),
        fireZones: overlappingZones(fire, anchors, grid, parts),
        marineZones: nearMarineZones(marine, anchors),
      };
    } else {
      const page = nearestCityPage(p.citypages, r.hq);
      eccc = page ? { ...page, forecastZones: overlappingZones(p.ecccZones, anchors, grid, parts) } : null;
    }
    nations[r.id] = {
      nws, eccc,
      radar: nearestRadar(p.radar, r.hq),
      gauges: nearbyGauges(p.gauges, anchors, { country: r.country, nationId: r.id, overrides: p.gaugeOverrides ?? [] }),
    };
  }
  const us = p.records.filter((r) => r.country === 'US');
  const ca = p.records.filter((r) => r.country === 'CA');
  const report = {
    policy: POLICY,
    nws: { nations: us.length, withWfo: us.length - noWfo.length, noForecastZone, noWfo },
    eccc: { nations: ca.length, withCityPage: ca.filter((r) => nations[r.id].eccc).length, withForecastZones: ca.filter((r) => nations[r.id].eccc?.forecastZones.length).length },
    radar: { withRadar: p.records.filter((r) => nations[r.id].radar.nexrad).length, withoutRadar: p.records.filter((r) => !nations[r.id].radar.nexrad).map((r) => r.id) },
    gauges: { withGauges: p.records.filter((r) => nations[r.id].gauges.length).length, withoutGauges: p.records.filter((r) => !nations[r.id].gauges.length).length },
  };
  return { nations, report };
}

/** @param {string[]} argv */
const rawArgs = (argv) => argv.flatMap((a, i) => (a === '--raw' ? [argv[i + 1] ?? ''] : []));

/** The reviewed gauge overrides (lane L7's file; only entries with `nationIds` affect the joins). */
export async function readGaugeOverrides() {
  const file = path.join(REGISTRY_DIR, 'gauges-overrides.yaml');
  if (!existsSync(file)) return [];
  return /** @type {{ gaugeId: string, action: string, nationIds?: string[] }[]} */ ((await parseDataFile('data/registry/gauges-overrides.yaml')) ?? []);
}

export async function main(argv = process.argv.slice(2)) {
  const draft = readJson('data/registry/draft-registry.json');
  const redirectsFile = path.join(REGISTRY_DIR, 'id-redirects.json');
  if (!existsSync(redirectsFile)) writeFileSync(redirectsFile, stable({ schema: 'cthd.id-redirects/1', redirects: {} }));
  const redirects = JSON.parse(readFileSync(redirectsFile, 'utf8'));
  const boundaries = existsSync(path.join(REGISTRY_DIR, 'boundaries-build.json')) ? readJson('data/registry/boundaries-build.json') : null;
  let joins = null;
  if (boundaries) {
    const rawDirs = rawArgs(argv).length ? rawArgs(argv) : (process.env.CTHD_RAW ?? '').split(path.delimiter).filter(Boolean);
    if (!rawDirs.length) rawDirs.push(path.join(ROOT, '.cache', 'inputs'));
    const zipPath = rawDirs.map((d) => path.join(d, 'z_16ap26.zip')).find((f) => existsSync(f));
    if (!zipPath) throw new Error('70-joins: z_16ap26.zip (the pinned NWS public zone file, lane L4) is not in the raw folders');
    const cwa = await cwaByForecastZone(readFileSync(zipPath));
    const detailDir = path.join(SITE_GEO, 'boundaries');
    const sites = readJson('data/registry/eccc-citypage-sites.json').sites;
    joins = computeJoins({
      records: draft.records, boundaries,
      detail: (id) => (existsSync(path.join(detailDir, `${id}.json`)) ? JSON.parse(readFileSync(path.join(detailDir, `${id}.json`), 'utf8')) : null),
      nwsZones: zonesFromTopo(readJson('site/data/geo/nws-zones.topo.json'), 'zones'),
      ecccZones: zonesFromTopo(readJson('site/data/geo/eccc-regions.topo.json'), 'regions'),
      cwa, citypages: sites, radar: readJson('site/data/ref/radar-sites.json').sites,
      gauges: gaugeCandidates(readJson('site/data/ref/gauges.json'), readJson('site/data/ref/wsc-stations.json')),
      gaugeOverrides: await readGaugeOverrides(),
    });
    writeFileSync(JOINS_FILE, stable({ schema: 'cthd.joins-build/1', report: joins.report, nations: joins.nations }));
  }
  const out = project(draft, redirects, { boundaries, joins });
  const dir = path.join(SITE_REGISTRY, 'nations');
  mkdirSync(dir, { recursive: true });
  mkdirSync(SITE_GEO, { recursive: true });
  const keep = new Set(out.records.map((r) => `${r.id}.json`));
  // Files for ids that are no longer in the draft are removed; the id-stability gate (90-validate) reports an
  // id that vanished without a redirect, so this never hides a disappearance.
  for (const f of readdirSync(dir)) if (f.endsWith('.json') && !keep.has(f)) rmSync(path.join(dir, f));
  for (const r of out.records) writeFileSync(path.join(dir, `${r.id}.json`), stable(r));
  writeFileSync(path.join(SITE_REGISTRY, 'nations-index.json'), stable(out.index));
  writeFileSync(path.join(SITE_REGISTRY, 'id-redirects.json'), stable(out.redirects));
  writeFileSync(path.join(SITE_GEO, 'hq-points.json'), compact(out.hqPoints));
  const rep = joins?.report;
  console.log(`70-joins: ${out.records.length} Nation files, index, ${out.hqPoints.features.length} headquarters points; ${out.records.filter((r) => r.boundary.status === 'polygon').length} with polygons${rep ? `; nws wfo ${rep.nws.withWfo}/${rep.nws.nations}, eccc ${rep.eccc.withCityPage}/${rep.eccc.nations}, radar ${rep.radar.withRadar}, gauges ${rep.gauges.withGauges}` : `; pending joins: ${PENDING_JOINS.join(', ')}`}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
