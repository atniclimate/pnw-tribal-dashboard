// @ts-check
/**
 * Reference builder 40: Nation boundaries (blueprint 4.2, 6.2, and 12.3, lane L5, wave 2).
 *
 *   node scripts/reference/40-boundaries.mjs [--raw <folder> ...]
 *
 * Run it after 50-registry (it reads the draft registry and the crosswalks that 50 writes; the committed copies are
 * used when 50 has not run). The raw folders default to `.cache/inputs`, or `CTHD_RAW`.
 *
 * Inputs (SHA-256 verified against data/registry/inputs.yaml): `bia-lar` (335 land area representations, already
 * EPSG:4326), `census-aiannh-2025` (legal classes only: MTFCC G2101 reservations, GEOID suffix R, and G2102
 * off-reservation trust land, suffix T; statistical areas never enter while `boundary_policy.census_statistical_areas`
 * is false), and `nrcan-aboriginal-lands-bc` (Indian Reserve polygons joined to a First Nation by ALCODE through the
 * ISC reserve relation in crosswalk-bc.json).
 *
 * Policy: BIA LAR first. Census is used for a Nation only when it has no LAR polygon. British Columbia reserves come
 * from NRCan alone. A Nation with none of these stays point-only. Every feature carries `source`, `sourceFeatureId`,
 * and `vintage`; the registry's full formal name is `name` in the detail files and the source label is `sourceName`.
 * Every match in the crosswalks is a draft until the maintainer signs the packet, so every polygon here is a draft.
 * These are representations, not jurisdiction.
 *
 * Outputs:
 *   site/data/geo/boundaries-overview.topo.json   TopoJSON, quantized 1e5, Visvalingam to 300 m (at most 600 KB raw)
 *   site/data/geo/boundaries/<nationId>.json      GeoJSON, five decimals, Visvalingam to 20 m (at most 15 MB in all)
 *   data/registry/boundaries-build.json           per-Nation parts, bbox, and interior sample points for 70-joins, plus the
 *                                                  build report (sizes, footprint check, shared areas)
 * Output is deterministic: no clock values, stable ordering.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import mapshaper from 'mapshaper';
import { ROOT } from '../check/lib/pages.mjs';
import { REGISTRY_DIR, SHARED_AREAS, isSharedCensusName, normName, pointInGeometry, r5, resolveInputs, sharedLarAreas, stable } from './50-registry.mjs';

export const GEO_DIR = path.join(ROOT, 'site', 'data', 'geo');
export const DETAIL_DIR = path.join(GEO_DIR, 'boundaries');
export const OVERVIEW_FILE = path.join(GEO_DIR, 'boundaries-overview.topo.json');
export const BUILD_FILE = path.join(REGISTRY_DIR, 'boundaries-build.json');

/** Size limits (blueprint 4.2 and 12.3). */
export const LIMITS = Object.freeze({ overviewRawBytes: 600 * 1024, detailTotalBytes: 15 * 1024 * 1024 });
/** Simplification intervals in metres (Visvalingam) and TopoJSON quantization. */
export const TUNING = Object.freeze({ detailIntervalM: 20, detailPrecision: 0.00001, overviewIntervalM: 300, overviewQuantization: 100000 });
/** Interior points kept after the headquarters (the Nation schema allows nine samples in all). */
export const MAX_INTERIOR_SAMPLES = 8;

export const INPUT_IDS = Object.freeze(['bia-lar', 'census-aiannh-2025', 'nrcan-aboriginal-lands-bc']);
/** The window the footprint check reads (the footprint plus a margin). */
const FOOTPRINT_WINDOW = [-142, 37.5, -108, 61];

/**
 * @param {string} commands @param {Record<string, Buffer | string>} files
 * @returns {Promise<Record<string, Buffer | string>>}
 */
async function ms(commands, files) {
  return /** @type {Record<string, Buffer | string>} */ (await mapshaper.applyCommands(commands, files));
}

/**
 * Parts of one Nation, in policy order: LAR; else Census; British Columbia: NRCan.
 * Pure (testable): reads the draft records and crosswalk rows only.
 * @param {Record<string, any>[]} records
 * @param {{ rows: any[] }} crossUs
 * @param {{ rows: any[] }} crossBc
 * @param {{ lar: Set<string>, census: Set<string> }} [shared] shared LAR ids and Census GEOIDs, skipped
 * @param {{ nationId: string, source: string, key: string }[]} [skipped] receives every skipped shared row
 * @returns {{ nationId: string, source: 'bia-lar' | 'census-aiannh-2025' | 'nrcan-aboriginal-lands-bc', key: string, matchMethod: string }[]}
 */
export function selectAreas(records, crossUs, crossBc, shared = { lar: new Set(), census: new Set() }, skipped = []) {
  /** @type {{ nationId: string, source: any, key: string, matchMethod: string }[]} */
  const out = [];
  // A shared land area (review R2) is never drawn for one Nation, even when a crosswalk row names it; it is reported.
  /** @param {{ sourceId: string, sourceKey: string }} x @param {string} nationId */
  const isShared = (x, nationId) => {
    const hit = x.sourceId === 'bia-lar' ? shared.lar.has(x.sourceKey) : x.sourceId === 'census-aiannh-2025' ? shared.census.has(x.sourceKey) : false;
    if (hit) skipped.push({ nationId, source: x.sourceId, key: x.sourceKey });
    return hit;
  };
  for (const r of records) {
    if (r.country === 'US') {
      const lar = crossUs.rows.filter((x) => x.nationId === r.id && x.sourceId === 'bia-lar' && !isShared(x, r.id));
      if (lar.length) { for (const x of lar) out.push({ nationId: r.id, source: 'bia-lar', key: x.sourceKey, matchMethod: x.matchMethod }); continue; }
      for (const x of crossUs.rows.filter((y) => y.nationId === r.id && y.sourceId === 'census-aiannh-2025' && !isShared(y, r.id))) out.push({ nationId: r.id, source: 'census-aiannh-2025', key: x.sourceKey, matchMethod: x.matchMethod });
    } else {
      for (const x of crossBc.rows.filter((y) => y.nationId === r.id && y.sourceId === 'nrcan-aboriginal-lands-bc')) out.push({ nationId: r.id, source: 'nrcan-aboriginal-lands-bc', key: x.sourceKey.replace(/^ALCODE /, ''), matchMethod: x.matchMethod });
    }
  }
  return out.sort((a, b) => (a.nationId + a.source + a.key).localeCompare(b.nationId + b.source + b.key, 'en'));
}

/**
 * Restores overview features that simplification or quantization collapsed to null geometry (review R1: four tiny
 * British Columbia reserves, the smallest about six metres across, vanished from the overview while their detail
 * polygons are valid). Each collapsed feature takes its detail geometry, quantized with the overview's own transform
 * and appended as new arcs. A ring that quantizes to fewer than three distinct positions becomes the smallest shape the
 * overview can hold, one quantum square (about 17 by 23 metres) at the ring's first position, so the reserve stays
 * visible at overview zoom; the detail file keeps the true shape. A collapsed hole is dropped. Mutates `topo`.
 * @param {any} topo TopoJSON with `transform`, `arcs`, and `objects.boundaries`
 * @param {any[]} detailFeatures the overview's input features, in the same order as its geometries
 * @returns {{ nationId: string, sourceFeatureId: string, squares: number }[]} the restored features
 */
export function fillCollapsed(topo, detailFeatures) {
  const geoms = topo.objects.boundaries.geometries;
  const [sx, sy] = topo.transform.scale;
  const [tx, ty] = topo.transform.translate;
  /** @type {{ nationId: string, sourceFeatureId: string, squares: number }[]} */
  const filled = [];
  geoms.forEach((/** @type {any} */ g, /** @type {number} */ i) => {
    if (g.type) return;
    const f = detailFeatures[i];
    if (!f || f.properties.nationId !== g.properties?.nationId || f.properties.sourceFeatureId !== g.properties?.sourceFeatureId) {
      throw new Error(`40-boundaries: overview feature ${i} (${g.properties?.nationId} ${g.properties?.sourceFeatureId}) does not line up with its detail feature`);
    }
    let squares = 0;
    /** @type {number[][][]} */
    const polys = [];
    for (const poly of f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates) {
      /** @type {number[][]} */
      const rings = [];
      poly.forEach((/** @type {number[][]} */ ring, /** @type {number} */ ri) => {
        /** @type {number[][]} */
        let q = [];
        for (const [x, y] of ring) {
          const p = [Math.round((/** @type {number} */ (x) - tx) / sx), Math.round((/** @type {number} */ (y) - ty) / sy)];
          const last = q[q.length - 1];
          if (!last || last[0] !== p[0] || last[1] !== p[1]) q.push(p);
        }
        const first = /** @type {number[]} */ (q[0]);
        const end = /** @type {number[]} */ (q[q.length - 1]);
        if (q.length > 1 && (first[0] !== end[0] || first[1] !== end[1])) q.push(first);
        if (new Set(q.map((p) => `${p[0]},${p[1]}`)).size < 3) {
          if (ri > 0) return;
          const [x0, y0] = /** @type {[number, number]} */ (first);
          q = [[x0, y0], [x0 + 1, y0], [x0 + 1, y0 + 1], [x0, y0 + 1], [x0, y0]];
          squares += 1;
        }
        topo.arcs.push(q.map((p, j) => (j === 0 ? p : [/** @type {number} */ (p[0]) - /** @type {number} */ (q[j - 1]?.[0]), /** @type {number} */ (p[1]) - /** @type {number} */ (q[j - 1]?.[1])])));
        rings.push([topo.arcs.length - 1]);
      });
      if (rings.length) polys.push(rings);
    }
    if (!polys.length) throw new Error(`40-boundaries: ${g.properties.nationId} ${g.properties.sourceFeatureId} has no ring to restore`);
    geoms[i] = polys.length === 1 ? { arcs: polys[0], type: 'Polygon', properties: g.properties } : { arcs: polys, type: 'MultiPolygon', properties: g.properties };
    filled.push({ nationId: g.properties.nationId, sourceFeatureId: g.properties.sourceFeatureId, squares });
  });
  return filled;
}

/** @param {any} geom @returns {number[][]} every position of a polygonal geometry */
function positions(geom) {
  const polys = geom.type === 'Polygon' ? [geom.coordinates] : geom.coordinates;
  return polys.flatMap((/** @type {number[][][]} */ p) => p.flatMap((ring) => ring));
}

/** @param {any[]} features @returns {[number, number, number, number]} */
export function bboxOf(features) {
  let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
  for (const f of features) for (const [x, y] of positions(f.geometry)) { w = Math.min(w, /** @type {number} */ (x)); e = Math.max(e, /** @type {number} */ (x)); s = Math.min(s, /** @type {number} */ (y)); n = Math.max(n, /** @type {number} */ (y)); }
  return [r5(w), r5(s), r5(e), r5(n)];
}

/** @param {string} dir */
function listDetail(dir) { return existsSync(dir) ? readdirSync(dir).filter((n) => n.endsWith('.json')) : []; }

/**
 * @param {{ rawDirs: string[], records: Record<string, any>[], crossUs: { rows: any[] }, crossBc: { rows: any[] }, footprint: any | null }} p
 */
export async function buildBoundaries({ rawDirs, records, crossUs, crossBc, footprint }) {
  const inputs = resolveInputs(rawDirs, { only: [...INPUT_IDS] });
  const vintage = (/** @type {string} */ id) => /** @type {string} */ (inputs[id]?.pin.vintage);
  const read = (/** @type {string} */ id) => readFileSync(/** @type {{ path: string }} */ (inputs[id]).path);
  const byId = new Map(records.map((r) => [r.id, r]));
  const larAll = JSON.parse(read('bia-lar').toString('utf8')).features;
  // Shared areas (review R2): every LAR feature the pinned file classifies as shared, plus the named list; Census legal
  // areas by name. None is ever drawn for one Nation.
  const sharedLar = sharedLarAreas(larAll.map((/** @type {any} */ f) => f.properties));
  const censusAttrs = await ms('-i census.zip -filter-fields GEOID,NAME,MTFCC -o format=json a.json', { 'census.zip': read('census-aiannh-2025') });
  const sharedCensus = new Map(/** @type {any[]} */ (JSON.parse(String(censusAttrs['a.json'])))
    .filter((a) => (a.MTFCC === 'G2101' || a.MTFCC === 'G2102') && isSharedCensusName(a.NAME)).map((a) => [String(a.GEOID), String(a.NAME)]));
  /** @type {{ nationId: string, source: string, key: string }[]} */
  const sharedSkipped = [];
  const areas = selectAreas(records, crossUs, crossBc, { lar: new Set(sharedLar.keys()), census: new Set(sharedCensus.keys()) }, sharedSkipped);

  // ---- source features for the selected areas ----
  const larIds = new Set(areas.filter((a) => a.source === 'bia-lar').map((a) => a.key));
  const geoids = [...new Set(areas.filter((a) => a.source === 'census-aiannh-2025').map((a) => a.key))];
  const alcodes = [...new Set(areas.filter((a) => a.source === 'nrcan-aboriginal-lands-bc').map((a) => a.key))];
  /** @type {Map<string, any>} */
  const larById = new Map(larAll.filter((/** @type {any} */ f) => larIds.has(f.properties.LARID)).map((/** @type {any} */ f) => [f.properties.LARID, f]));
  const censusOut = await ms(
    `-i census.zip -filter ${JSON.stringify(`${JSON.stringify(geoids)}.includes(GEOID)`)} -filter-fields GEOID,NAME,MTFCC -o format=geojson c.json`,
    { 'census.zip': read('census-aiannh-2025') });
  /** @type {Map<string, any>} */
  const censusById = new Map(JSON.parse(String(censusOut['c.json'])).features.map((/** @type {any} */ f) => [f.properties.GEOID, f]));
  const nrcanOut = await ms(
    `-i nrcan.zip -filter ${JSON.stringify(`${JSON.stringify(alcodes)}.includes(ALCODE)`)} -filter-fields ALCODE,NAME1,ALTYPE -o format=geojson n.json`,
    { 'nrcan.zip': read('nrcan-aboriginal-lands-bc') });
  /** @type {Map<string, any>} */
  const nrcanByCode = new Map(JSON.parse(String(nrcanOut['n.json'])).features.map((/** @type {any} */ f) => [f.properties.ALCODE, f]));

  /** @type {any[]} */
  const features = [];
  /** @type {{ nationId: string, source: string, key: string, why: string }[]} */
  const missing = [];
  for (const a of areas) {
    const nation = /** @type {any} */ (byId.get(a.nationId));
    let src;
    let props;
    if (a.source === 'bia-lar') {
      src = larById.get(a.key);
      if (src) props = { source: 'bia-lar', sourceFeatureId: a.key, vintage: vintage('bia-lar'), kind: 'land-area-representation', sourceName: String(src.properties.LARNAME) };
    } else if (a.source === 'census-aiannh-2025') {
      src = censusById.get(a.key);
      if (src) props = { source: 'census-aiannh-2025', sourceFeatureId: a.key, vintage: vintage('census-aiannh-2025'), kind: src.properties.MTFCC === 'G2102' ? 'off-reservation-trust-land' : 'reservation', sourceName: String(src.properties.NAME) };
    } else {
      src = nrcanByCode.get(a.key);
      if (src) props = { source: 'nrcan-aboriginal-lands-bc', sourceFeatureId: a.key, vintage: vintage('nrcan-aboriginal-lands-bc'), kind: 'indian-reserve', sourceName: String(src.properties.NAME1) };
    }
    if (!src || !props) { missing.push({ nationId: a.nationId, source: a.source, key: a.key, why: 'the crosswalk names a feature that the pinned file does not contain' }); continue; }
    features.push({ type: 'Feature', properties: { nationId: a.nationId, name: nation.name, ...props }, geometry: src.geometry });
  }
  const full = JSON.stringify({ type: 'FeatureCollection', features });

  // ---- detail geometry: about 20 m, five decimals ----
  const det = await ms(
    `-i full.json -clean allow-overlaps -simplify visvalingam interval=${TUNING.detailIntervalM} keep-shapes ` +
      `-clean allow-overlaps -o format=geojson precision=${TUNING.detailPrecision} d.json`,
    { 'full.json': full });
  const detail = JSON.parse(String(det['d.json']));
  if (detail.features.length !== features.length) throw new Error(`detail simplification changed the feature count (${features.length} to ${detail.features.length})`);

  // ---- overview: about 300 m, quantized TopoJSON ----
  const ovIn = JSON.stringify({ type: 'FeatureCollection', features: detail.features.map((/** @type {any} */ f) => {
    const { nationId, source, sourceFeatureId, vintage: v, kind, sourceName } = f.properties;
    return { type: 'Feature', properties: { nationId, source, sourceFeatureId, vintage: v, kind, sourceName }, geometry: f.geometry };
  }) });
  const ov = await ms(
    `-i ov.json -simplify visvalingam interval=${TUNING.overviewIntervalM} keep-shapes -clean allow-overlaps ` +
      `-rename-layers boundaries -o format=topojson quantization=${TUNING.overviewQuantization} target=* o.topo.json`,
    { 'ov.json': ovIn });
  const overviewTopo = JSON.parse(String(ov['o.topo.json']));
  const restored = fillCollapsed(overviewTopo, detail.features);
  const overviewText = `${JSON.stringify(overviewTopo)}\n`;

  // ---- per-Nation detail files, parts, bbox, and interior samples ----
  /** @type {Map<string, any[]>} */
  const perNation = new Map();
  for (const f of detail.features) { if (!perNation.has(f.properties.nationId)) perNation.set(f.properties.nationId, []); /** @type {any[]} */ (perNation.get(f.properties.nationId)).push(f); }
  const inner = await ms(
    `-i d.json -each "areaM2=this.area" -points inner -o format=geojson precision=${TUNING.detailPrecision} p.json`,
    { 'd.json': JSON.stringify(detail) });
  /** @type {Map<string, any[]>} */
  const innerBy = new Map();
  for (const p of JSON.parse(String(inner['p.json'])).features) { const k = p.properties.nationId; if (!innerBy.has(k)) innerBy.set(k, []); /** @type {any[]} */ (innerBy.get(k)).push(p); }

  /** @type {Record<string, any>} */
  const nations = {};
  /** @type {Map<string, string>} */
  const files = new Map();
  for (const [id, feats] of [...perNation.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    feats.sort((a, b) => (a.properties.source + a.properties.sourceFeatureId).localeCompare(b.properties.source + b.properties.sourceFeatureId, 'en'));
    files.set(id, `${JSON.stringify({ type: 'FeatureCollection', features: feats })}\n`);
    const ranked = (innerBy.get(id) ?? []).slice().sort((a, b) => b.properties.areaM2 - a.properties.areaM2 || (a.properties.sourceFeatureId < b.properties.sourceFeatureId ? -1 : 1));
    /** @type {[number, number][]} */
    const samples = [];
    for (const p of ranked) {
      const [lon, lat] = /** @type {[number, number]} */ (p.geometry.coordinates);
      const own = feats.find((f) => f.properties.sourceFeatureId === p.properties.sourceFeatureId && f.properties.source === p.properties.source);
      // A sample must be inside its own simplified polygon after rounding; a sliver whose inner point rounds outside is skipped.
      if (!own || !pointInGeometry(lon, lat, own.geometry)) continue;
      if (!samples.some(([la, lo]) => la === r5(lat) && lo === r5(lon))) samples.push([r5(lat), r5(lon)]);
      if (samples.length >= MAX_INTERIOR_SAMPLES) break;
    }
    // The inner point of every part, in part order (review R3): 70-joins uses each one as a zone anchor, so a small
    // outlying reserve brings its own zone even when it is not among the ranked samples.
    /** @type {[number, number][]} */
    const partPoints = [];
    for (const f of feats) {
      const p = (innerBy.get(id) ?? []).find((x) => x.properties.source === f.properties.source && x.properties.sourceFeatureId === f.properties.sourceFeatureId);
      if (!p) continue;
      const [lon, lat] = /** @type {[number, number]} */ (p.geometry.coordinates);
      if (!partPoints.some(([la, lo]) => la === r5(lat) && lo === r5(lon))) partPoints.push([r5(lat), r5(lon)]);
    }
    nations[id] = {
      parts: feats.map((f) => ({ sourceId: f.properties.source, featureId: f.properties.sourceFeatureId, kind: f.properties.kind, vintage: f.properties.vintage })),
      bbox: bboxOf(feats),
      interiorSamples: samples,
      partPoints,
    };
  }

  // ---- footprint check: legal land areas inside the footprint that no Nation received ----
  // Claimed means any Nation holds the area in a crosswalk, even when LAR took precedence over Census for that Nation.
  const assigned = new Set([...crossUs.rows.filter((x) => x.sourceId === 'bia-lar' || x.sourceId === 'census-aiannh-2025').map((x) => `${x.sourceId}:${x.sourceKey}`)]);
  // A Census reservation and its trust land share one code; a trust area of a claimed code is claimed too.
  const claimedCodes = new Set([...assigned].filter((k) => k.startsWith('census-aiannh-2025:')).map((k) => k.slice(19, 23)));
  // A Census area with the same name as a claimed LAR is the same place under a second source (LAR takes precedence).
  const claimedLarNames = new Set(larAll.filter((/** @type {any} */ f) => assigned.has(`bia-lar:${f.properties.LARID}`)).map((/** @type {any} */ f) => normName(f.properties.LARNAME)));
  const sharedKeys = new Set([...[...sharedLar.keys()].map((k) => `bia-lar:${k}`), '*']);
  /** @type {{ source: string, key: string, name: string, region: string }[]} */
  const unassignedInFootprint = [];
  if (footprint) {
    const [w, s, e, n] = FOOTPRINT_WINDOW;
    const win = `this.bounds[2] > ${w} && this.bounds[0] < ${e} && this.bounds[3] > ${s} && this.bounds[1] < ${n}`;
    const larPts = await ms(`-i lar.json -filter ${JSON.stringify(win)} -points inner -o format=geojson lp.json`, { 'lar.json': JSON.stringify({ type: 'FeatureCollection', features: larAll }) });
    const cenPts = await ms(`-i census.zip -filter ${JSON.stringify(`(MTFCC=='G2101' || MTFCC=='G2102') && ${win}`)} -filter-fields GEOID,NAME,MTFCC -points inner -o format=geojson cp.json`, { 'census.zip': read('census-aiannh-2025') });
    /** @param {number} lon @param {number} lat */
    const regionAt = (lon, lat) => footprint.features.find((/** @type {any} */ f) => pointInGeometry(lon, lat, f.geometry))?.properties.region;
    for (const p of JSON.parse(String(larPts['lp.json'])).features) {
      const key = p.properties.LARID;
      const region = regionAt(p.geometry.coordinates[0], p.geometry.coordinates[1]);
      if (region && !assigned.has(`bia-lar:${key}`) && !sharedKeys.has(`bia-lar:${key}`)) unassignedInFootprint.push({ source: 'bia-lar', key, name: String(p.properties.LARNAME), region });
    }
    for (const p of JSON.parse(String(cenPts['cp.json'])).features) {
      const key = p.properties.GEOID;
      const region = regionAt(p.geometry.coordinates[0], p.geometry.coordinates[1]);
      if (region && !assigned.has(`census-aiannh-2025:${key}`) && !claimedCodes.has(key.slice(0, 4)) && !claimedLarNames.has(normName(p.properties.NAME)) &&!SHARED_AREAS.censusNames.includes(normName(p.properties.NAME))) unassignedInFootprint.push({ source: 'census-aiannh-2025', key, name: String(p.properties.NAME), region });
    }
    unassignedInFootprint.sort((a, b) => (a.source + a.key).localeCompare(b.source + b.key, 'en'));
  }

  const detailBytes = [...files.values()].reduce((n, t) => n + Buffer.byteLength(t), 0);
  const report = {
    features: features.length, nationsWithPolygon: perNation.size, nationsTotal: records.length,
    bySource: Object.fromEntries(['bia-lar', 'census-aiannh-2025', 'nrcan-aboriginal-lands-bc'].map((s) => [s, features.filter((f) => f.properties.source === s).length])),
    overviewBytes: Buffer.byteLength(overviewText), detailBytes, detailFiles: files.size, missing,
    shared: {
      lar: SHARED_AREAS.lar, censusNames: SHARED_AREAS.censusNames,
      larIds: [...sharedLar.keys()].sort(), censusGeoids: [...sharedCensus.keys()].sort(), skipped: sharedSkipped,
    },
    overviewRestored: restored,
    unassignedInFootprint,
    vintages: Object.fromEntries(INPUT_IDS.map((i) => [i, vintage(i)])),
  };
  return { overviewText, files, nations, report };
}

/** @param {string} rel */
const readJson = (rel) => JSON.parse(readFileSync(path.join(ROOT, rel), 'utf8'));

/** @param {string[]} argv */
const rawArgs = (argv) => argv.flatMap((a, i) => (a === '--raw' ? [argv[i + 1] ?? ''] : []));

export async function main(argv = process.argv.slice(2)) {
  const rawDirs = rawArgs(argv).length ? rawArgs(argv) : (process.env.CTHD_RAW ?? '').split(path.delimiter).filter(Boolean);
  if (!rawDirs.length) rawDirs.push(path.join(ROOT, '.cache', 'inputs'));
  const draft = readJson('data/registry/draft-registry.json');
  const footprint = existsSync(path.join(GEO_DIR, 'footprint.json')) ? readJson('site/data/geo/footprint.json') : null;
  const out = await buildBoundaries({ rawDirs, records: draft.records, crossUs: readJson('data/registry/crosswalk-us.json'), crossBc: readJson('data/registry/crosswalk-bc.json'), footprint });
  if (out.report.missing.length) throw new Error(`40-boundaries: ${out.report.missing.length} crosswalk features are missing from the pinned files`);
  if (out.report.overviewBytes > LIMITS.overviewRawBytes) throw new Error(`40-boundaries: overview is ${out.report.overviewBytes} bytes, over ${LIMITS.overviewRawBytes}`);
  if (out.report.detailBytes > LIMITS.detailTotalBytes) throw new Error(`40-boundaries: detail files total ${out.report.detailBytes} bytes, over ${LIMITS.detailTotalBytes}`);
  mkdirSync(DETAIL_DIR, { recursive: true });
  const keep = new Set([...out.files.keys()].map((id) => `${id}.json`));
  for (const f of listDetail(DETAIL_DIR)) if (!keep.has(f)) rmSync(path.join(DETAIL_DIR, f));
  for (const [id, text] of out.files) writeFileSync(path.join(DETAIL_DIR, `${id}.json`), text);
  writeFileSync(OVERVIEW_FILE, out.overviewText);
  writeFileSync(BUILD_FILE, stable({ schema: 'cthd.boundaries-build/1', report: out.report, nations: out.nations }));
  console.log(`40-boundaries: ${out.report.nationsWithPolygon} of ${out.report.nationsTotal} Nations with polygons (${out.report.features} features: ${JSON.stringify(out.report.bySource)}); overview ${out.report.overviewBytes} bytes; detail ${out.report.detailFiles} files, ${out.report.detailBytes} bytes`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
