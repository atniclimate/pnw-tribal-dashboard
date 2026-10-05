// @ts-check
/**
 * Reference builder 90: registry validation gates, review packet, and crosswalk notes (blueprint 6.2, 6.6, and
 * 12.3, lane L5, waves 1 and 2). Other lanes extend this file with their own gates.
 *
 *   node scripts/reference/90-validate.mjs                         run the gates over the committed registry files
 *   node scripts/reference/90-validate.mjs --reproducibility --raw <folder> ...   rebuild in memory, compare bytes
 *   node scripts/reference/90-validate.mjs --packet <folder> --raw <folder> ...   write the review packet and the
 *                                                                                  crosswalk notes (Markdown)
 *
 * Gates (a failure exits 1; a warning does not): schema validity of every registry file; the named-person
 * guard; Nation count gates against the 6.2 ranges (warning while `footprint.yaml` has `ratified: false`);
 * source count reconciliation; names with `?` or U+FFFD (never `reviewed`); id stability (lock, records, and
 * redirects agree, and an id of a previous registry never vanishes); at least 95 percent of NRCan polygons
 * joined to a First Nation; a `reviewed` record carries a review date, a reviewed headquarters, and no flag (the approval
 * is data/registry/review.yaml, applied by 50-registry). Wave 2 gates (boundaryGates):
 * boundary detail files schema-valid with source, id, and vintage on every feature, overview at most 600 KB and detail
 * files at most 15 MB, interior samples inside land areas, parts equal to the detail features, at least 95 percent of the
 * British Columbia reserve polygons drawn, a typed NWS zone list or ECCC linkage on every record with keys that exist in
 * the L4 zone files, radar and gauge ids that exist, and byte-identical reruns of 40-boundaries and 70-joins.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import tzlookup from '@photostructure/tz-lookup';
import { ROOT } from '../check/lib/pages.mjs';
import { loadAjv, parseDataFile, personKeyHits } from '../check/lib/data-files.mjs';
import { BC_TOLERANCE_KM, CA_COUNTIES, AK_SE_BOROUGHS, CANDIDATE_KM, CENSUS_GUARD_KM, REGISTRY_DIR, SHARED_AREAS, buildDraft, loadConfig, pointInGeometry, resolveInputs, stable, tzConsistent } from './50-registry.mjs';
import { LIMITS, buildBoundaries } from './40-boundaries.mjs';
import { PENDING_JOINS, compact, computeJoins, cwaByForecastZone, gaugeCandidates, project, readGaugeOverrides, zonesFromTopo } from './70-joins.mjs';

/** Expected Nation counts (blueprint 6.2; adjustable by a reviewed pull request). */
export const COUNT_GATES = Object.freeze({
  // 75 to 95 since the packet amendments of 10/05/2026 (Section E.2): the earlier 120 to 170 was an estimate that no reading
  // of "northern California" reaches.
  usOutsideAlaska: Object.freeze({ min: 75, max: 95 }),
  southeastAlaska: Object.freeze({ min: 15, max: 25 }),
  britishColumbia: Object.freeze({ min: 195, max: 210 }),
});

const SCHEMA_FILES = [
  ['ids-lock.schema.json', ['data/registry/ids.lock.json']],
  ['crosswalk.schema.json', ['data/registry/crosswalk-us.json', 'data/registry/crosswalk-bc.json']],
  ['id-redirects.schema.json', ['data/registry/id-redirects.json']],
  ['registry-scope.schema.json', ['data/registry/scope.yaml']],
  ['registry-names.schema.json', ['data/registry/names.yaml']],
  ['registry-overrides.schema.json', ['data/registry/overrides.yaml']],
  ['pipeline-inputs.schema.json', ['data/registry/inputs.yaml']],
  ['nations-index.schema.json', ['site/data/registry/nations-index.json']],
  ['hq-points.schema.json', ['site/data/geo/hq-points.json']],
];

/** @param {string} rel */
const exists = (rel) => existsSync(path.join(ROOT, rel));
/** @param {string} rel */
const readJson = (rel) => JSON.parse(readFileSync(path.join(ROOT, rel), 'utf8'));

/**
 * @typedef {{ problems: string[], warnings: string[], notes: string[] }} Findings
 */

/** Counts by region as the gates define them. @param {Record<string, any>[]} records */
export function countRegistry(records) {
  const us = records.filter((r) => r.country === 'US');
  const se = us.filter((r) => r.region === 'ak-se');
  return { total: records.length, us: us.length, usOutsideAlaska: us.length - se.length, southeastAlaska: se.length, britishColumbia: records.filter((r) => r.country === 'CA').length };
}

/**
 * Pure gate over parsed registry data (tests seed violations in memory).
 * @param {{ records: Record<string, any>[], lock: { entries: { id: string, key: string }[] }, redirects: { redirects: Record<string, any> }, previousIds?: string[] | null,
 *   bc?: { nrcanPolygons: number, nrcanJoined: number } | null, ratified: boolean, files?: string[], wave2?: boolean }} c
 * @returns {Findings}
 */
export function registryGates(c) {
  /** @type {Findings} */
  const f = { problems: [], warnings: [], notes: [] };
  const counts = countRegistry(c.records);
  /** @type {[string, number, { min: number, max: number }][]} */
  const gates = [
    ['U.S. Tribes outside Alaska', counts.usOutsideAlaska, COUNT_GATES.usOutsideAlaska],
    ['Southeast Alaska Nations', counts.southeastAlaska, COUNT_GATES.southeastAlaska],
    ['British Columbia First Nations', counts.britishColumbia, COUNT_GATES.britishColumbia],
  ];
  for (const [label, n, g] of gates) {
    const line = `${label}: ${n} (gate ${g.min} to ${g.max})`;
    if (n < g.min || n > g.max) (c.ratified ? f.problems : f.warnings).push(`count gate ${line}${c.ratified ? '' : '; footprint.yaml is unratified, so this is a warning'}`);
    else f.notes.push(`count gate met: ${line}`);
  }
  const ids = new Set();
  for (const r of c.records) {
    if (ids.has(r.id)) f.problems.push(`duplicate Nation id ${r.id}`);
    ids.add(r.id);
    if (r.review?.status !== 'draft') {
      // A reviewed record was approved by the maintainer (review.yaml): it needs the approval date, a reviewed headquarters, and no flag.
      if (!r.review?.reviewedAt) f.problems.push(`${r.id}: review.status is ${r.review?.status} without review.reviewedAt`);
      if (r.hq?.reviewed !== true) f.problems.push(`${r.id}: review.status is ${r.review?.status} but hq.reviewed is not true`);
      if (r.flags?.length) f.problems.push(`${r.id}: review.status is ${r.review?.status} while the record carries ${r.flags.join(', ')}`);
    }
    if (/[?�]/.test(r.name)) {
      if (r.review?.status !== 'draft') f.problems.push(`${r.id}: name "${r.name}" carries ? or U+FFFD and cannot be reviewed`);
      else if (!r.flags.includes('name-orthography-needs-nation-source')) f.problems.push(`${r.id}: name carries ? or U+FFFD without the name-orthography-needs-nation-source flag`);
    }
    for (const a of r.aliases) if (a.toLowerCase() === String(r.name).toLowerCase()) f.problems.push(`${r.id}: alias equals the name`);
    if (!r.nameSource?.url || !r.hq?.sourceId || !r.timeZone) f.problems.push(`${r.id}: missing name source, headquarters provenance, or time zone`);
    if (r.country === 'US' && r.kind === 'first-nation') f.problems.push(`${r.id}: kind first-nation on a U.S. Nation`);
    // Time zone consistent with jurisdiction: an Alaska record in a Pacific zone or a British Columbia record in a United States zone fails.
    if (!tzConsistent(r.jurisdictions, r.timeZone)) f.problems.push(`${r.id}: time zone ${r.timeZone} is not consistent with jurisdiction ${r.jurisdictions?.[0] ?? '(none)'}; correct it with a timeZone entry in data/registry/overrides.yaml once the maintainer ratifies the zone`);  }
  const reviewedCount = c.records.filter((r) => r.review?.status !== 'draft').length;
  f.notes.push(`review status: ${reviewedCount} reviewed, ${c.records.length - reviewedCount} draft (${c.records.filter((r) => r.review?.status === 'draft').map((r) => r.id).slice(0, 5).join(', ') || 'none'}${c.records.length - reviewedCount > 5 ? ', ...' : ''})`);
  const lockIds = new Set(c.lock.entries.map((e) => e.id));
  for (const id of ids) if (!lockIds.has(id)) f.problems.push(`${id} is not in ids.lock.json (ids come only from the lock)`);
  const redirected = new Set(Object.keys(c.redirects.redirects ?? {}));
  for (const id of lockIds) if (!ids.has(id) && !redirected.has(id)) f.problems.push(`lock id ${id} has no record and no redirect (id stability)`);
  for (const id of c.previousIds ?? []) if (!ids.has(id) && !redirected.has(id)) f.problems.push(`id ${id} of the previous registry disappeared without an id-redirects.json entry`);
  const keys = new Set();
  for (const e of c.lock.entries) { if (keys.has(e.key)) f.problems.push(`ids.lock.json repeats key ${e.key}`); keys.add(e.key); }
  if (c.bc) {
    const pct = (100 * c.bc.nrcanJoined) / Math.max(1, c.bc.nrcanPolygons);
    const line = `BC reserve polygons joined to a First Nation: ${c.bc.nrcanJoined} of ${c.bc.nrcanPolygons} (${pct.toFixed(1)} percent; gate 95)`;
    if (pct < 95) f.problems.push(line); else f.notes.push(line);
  }
  if (!c.wave2) f.warnings.push(`wave 2 joins pending (fields stay null or empty): ${PENDING_JOINS.join(', ')}`);
  return f;
}

/**
 * Wave 2 gates over parsed boundary and join outputs (pure; tests seed violations in memory).
 * @param {{ records: Record<string, any>[], detail: Map<string, { json: any, bytes: number }>, overview: any, overviewBytes: number,
 *   nwsKeys: Set<string>, ecccIds: Set<string>, radarIds: Set<string>, gaugeIds: Set<string>, bcPolygons: number, limits?: { overviewRawBytes: number, detailTotalBytes: number },
 *   sharedKeys?: Set<string> }} c `sharedKeys`: `<sourceId>:<featureId>` of every shared land area
 * @returns {Findings}
 */
export function boundaryGates(c) {
  /** @type {Findings} */
  const f = { problems: [], warnings: [], notes: [] };
  const limits = c.limits ?? LIMITS;
  const byId = new Map(c.records.map((r) => [r.id, r]));
  let features = 0;
  let detailBytes = 0;
  /** @type {Set<string>} */
  const bcCodes = new Set();
  for (const [id, d] of c.detail) {
    detailBytes += d.bytes;
    const rec = byId.get(id);
    if (!rec) { f.problems.push(`boundaries/${id}.json has no Nation record`); continue; }
    if (rec.boundary?.status !== 'polygon') f.problems.push(`${id}: a detail file exists but the record is ${rec.boundary?.status}`);
    for (const ft of d.json.features) {
      features += 1;
      const p = ft.properties;
      for (const k of ['nationId', 'name', 'source', 'sourceFeatureId', 'vintage', 'kind', 'sourceName']) if (!p?.[k]) f.problems.push(`${id}: a boundary feature has no ${k}`);
      if (p.nationId !== id) f.problems.push(`${id}: a boundary feature carries nationId ${p.nationId}`);
      if (p.name !== rec.name) f.problems.push(`${id}: boundary feature name "${p.name}" is not the registry formal name`);
      if (p.source === 'nrcan-aboriginal-lands-bc') bcCodes.add(p.sourceFeatureId);
    }
    const parts = d.json.features.map((/** @type {any} */ ft) => ({ sourceId: ft.properties.source, featureId: ft.properties.sourceFeatureId, kind: ft.properties.kind, vintage: ft.properties.vintage }));
    if (JSON.stringify(parts) !== JSON.stringify(rec.boundary?.parts)) f.problems.push(`${id}: boundary.parts does not equal the features of its detail file`);
    if (rec.boundary?.detailRef !== `geo/boundaries/${id}.json`) f.problems.push(`${id}: boundary.detailRef is ${rec.boundary?.detailRef}`);
    // Interior samples fall inside a land area (the first sample is the headquarters and is not required to).
    for (const [lat, lon] of rec.samples.slice(1)) if (!d.json.features.some((/** @type {any} */ ft) => pointInGeometry(lon, lat, ft.geometry))) f.problems.push(`${id}: interior sample ${lat}, ${lon} is outside every land area`);
    const xs = d.json.features.flatMap((/** @type {any} */ ft) => (ft.geometry.type === 'Polygon' ? [ft.geometry.coordinates] : ft.geometry.coordinates).flatMap((/** @type {number[][][]} */ pl) => pl.flatMap((ring) => ring)));
    const w = Math.min(...xs.map((/** @type {number[]} */ p) => /** @type {number} */ (p[0])));
    const e = Math.max(...xs.map((/** @type {number[]} */ p) => /** @type {number} */ (p[0])));
    const s = Math.min(...xs.map((/** @type {number[]} */ p) => /** @type {number} */ (p[1])));
    const n = Math.max(...xs.map((/** @type {number[]} */ p) => /** @type {number} */ (p[1])));
    if (Math.abs(w - rec.bbox[0]) > 2e-5 || Math.abs(e - rec.bbox[2]) > 2e-5 || Math.abs(s - rec.bbox[1]) > 2e-5 || Math.abs(n - rec.bbox[3]) > 2e-5) f.problems.push(`${id}: bbox does not span the land areas`);
    // A shared land area (review R2) is never drawn for one Nation.
    for (const p of rec.boundary?.parts ?? []) if (c.sharedKeys?.has(`${p.sourceId}:${p.featureId}`)) f.problems.push(`${id}: part ${p.sourceId} ${p.featureId} is a shared land area and must not be drawn for one Nation`);
  }
  for (const r of c.records) {
    if (r.boundary?.status === 'polygon' && !c.detail.has(r.id)) f.problems.push(`${r.id}: boundary.status is polygon but no detail file exists`);
    if (r.boundary?.status !== 'polygon' && (r.samples.length !== 1 || r.boundary.parts.length)) f.problems.push(`${r.id}: a point-only Nation must have the headquarters as its only sample and no parts`);
    // Joins: a typed NWS zone list or ECCC linkage on every record, and every key must exist in the L4 files.
    if (r.country === 'US') {
      if (!r.nws) f.problems.push(`${r.id}: no NWS zone join`);
      else {
        if (r.nws.wfo.length < 1) f.problems.push(`${r.id}: nws.wfo is empty`);
        if (r.nws.forecastZones.length < 1) f.problems.push(`${r.id}: no NWS forecast zone`);
        for (const k of [...r.nws.forecastZones, ...r.nws.countyZones, ...r.nws.fireZones, ...r.nws.marineZones]) if (!c.nwsKeys.has(k)) f.problems.push(`${r.id}: zone key ${k} is not in nws-zones.topo.json`);
      }
      if (r.eccc) f.problems.push(`${r.id}: a U.S. Nation carries an ECCC join`);
    } else {
      if (!r.eccc) f.problems.push(`${r.id}: no ECCC city page linkage`);
      else {
        for (const z of r.eccc.forecastZones) if (!c.ecccIds.has(z)) f.problems.push(`${r.id}: ECCC zone ${z} is not in eccc-regions.topo.json`);
        if (!r.eccc.forecastZones.length) f.warnings.push(`${r.id}: no ECCC public forecast zone within five kilometres of the headquarters (city page ${r.eccc.citypageId} only)`);
      }
      if (r.nws) f.problems.push(`${r.id}: a British Columbia Nation carries an NWS join`);
    }
    if (r.radar.nexrad && !c.radarIds.has(r.radar.nexrad)) f.problems.push(`${r.id}: radar site ${r.radar.nexrad} is not in radar-sites.json`);
    for (const g of r.gauges) if (!c.gaugeIds.has(g)) f.problems.push(`${r.id}: gauge ${g} is not in gauges.json or wsc-stations.json`);
  }
  if (c.overviewBytes > limits.overviewRawBytes) f.problems.push(`boundaries-overview.topo.json is ${c.overviewBytes} bytes, over ${limits.overviewRawBytes}`);
  else f.notes.push(`boundaries-overview.topo.json is ${c.overviewBytes} bytes (limit ${limits.overviewRawBytes})`);
  if (detailBytes > limits.detailTotalBytes) f.problems.push(`boundary detail files total ${detailBytes} bytes, over ${limits.detailTotalBytes}`);
  else f.notes.push(`${c.detail.size} boundary detail files total ${detailBytes} bytes (limit ${limits.detailTotalBytes})`);
  const geoms = c.overview?.objects?.boundaries?.geometries ?? [];
  if (!geoms.length) f.problems.push('boundaries-overview.topo.json has no boundaries object');
  if (geoms.length !== features) f.problems.push(`boundaries-overview.topo.json holds ${geoms.length} features and the detail files hold ${features}`);
  for (const g of geoms) for (const k of ['nationId', 'source', 'sourceFeatureId', 'vintage', 'kind', 'sourceName']) if (!g.properties?.[k]) { f.problems.push(`an overview feature has no ${k}`); break; }
  // Every overview feature has a geometry (review R1): simplification or quantization must never drop a reserve.
  for (const g of geoms) if (!g.type) f.problems.push(`overview feature ${g.properties?.nationId ?? '?'} ${g.properties?.sourceFeatureId ?? '?'} has null geometry`);
  if (c.bcPolygons > 0) {
    const pct = (100 * bcCodes.size) / c.bcPolygons;
    const line = `BC reserve polygons drawn in the boundary files: ${bcCodes.size} of ${c.bcPolygons} (${pct.toFixed(1)} percent; gate 95)`;
    if (pct < 95) f.problems.push(line); else f.notes.push(line);
  }
  const pointOnly = c.records.filter((r) => r.boundary?.status !== 'polygon');
  f.notes.push(`${c.records.length - pointOnly.length} of ${c.records.length} Nations have polygons; ${pointOnly.length} are point-only`);
  return f;
}

export async function validate(argv = process.argv.slice(2)) {
  /** @type {Findings} */
  const f = { problems: [], warnings: [], notes: [] };
  const ajv = await loadAjv();
  let checked = 0;
  for (const [schema, files] of SCHEMA_FILES) {
    for (const rel of /** @type {string[]} */ (files)) {
      if (!exists(rel)) { f.warnings.push(`${rel} is absent`); continue; }
      const data = await parseDataFile(rel);
      const validateFn = ajv.getSchema(`https://atniclimate.github.io/pnw-tribal-dashboard/schemas/${schema}`);
      if (!validateFn) throw new Error(`schema ${schema} not loaded`);
      checked += 1;
      if (!validateFn(data)) for (const e of validateFn.errors ?? []) f.problems.push(`${rel}: ${e.instancePath || '/'} ${e.message} (${schema})`);
      for (const hit of personKeyHits(data)) f.problems.push(`${rel}: person key at ${hit}`);
    }
  }
  const nationDir = path.join(ROOT, 'site', 'data', 'registry', 'nations');
  const records = [];
  const nationSchema = ajv.getSchema('https://atniclimate.github.io/pnw-tribal-dashboard/schemas/nation.schema.json');
  if (existsSync(nationDir)) {
    for (const name of readdirSync(nationDir).filter((n) => n.endsWith('.json')).sort()) {
      const rec = readJson(`site/data/registry/nations/${name}`);
      records.push(rec);
      checked += 1;
      if (name !== `${rec.id}.json`) f.problems.push(`site/data/registry/nations/${name}: file name does not match id ${rec.id}`);
      if (nationSchema && !nationSchema(rec)) for (const e of nationSchema.errors ?? []) f.problems.push(`site/data/registry/nations/${name}: ${e.instancePath || '/'} ${e.message}`);
      for (const hit of personKeyHits(rec)) f.problems.push(`site/data/registry/nations/${name}: person key at ${hit}`);
    }
  }
  const previous = argv.includes('--previous') ? argv[argv.indexOf('--previous') + 1] : undefined;
  const previousIds = previous && existsSync(previous) ? readdirSync(previous).filter((n) => n.endsWith('.json')).map((n) => n.replace(/\.json$/, '')) : null;
  const draft = exists('data/registry/draft-registry.json') ? readJson('data/registry/draft-registry.json') : null;
  const footprint = /** @type {any} */ (exists('data/pipeline/footprint.yaml') ? await parseDataFile('data/pipeline/footprint.yaml') : null);
  const boundaries = exists('data/registry/boundaries-build.json') ? readJson('data/registry/boundaries-build.json') : null;
  const joins = exists('data/registry/joins-build.json') ? readJson('data/registry/joins-build.json') : null;
  const g = registryGates({
    records, lock: exists('data/registry/ids.lock.json') ? readJson('data/registry/ids.lock.json') : { entries: [] },
    redirects: exists('data/registry/id-redirects.json') ? readJson('data/registry/id-redirects.json') : { redirects: {} }, previousIds,
    bc: draft?.bc ?? null, ratified: footprint?.ratified === true, wave2: Boolean(boundaries && joins),
  });
  f.problems.push(...g.problems); f.warnings.push(...g.warnings); f.notes.push(...g.notes);
  if (boundaries && joins) {
    const geoDir = path.join(ROOT, 'site', 'data', 'geo', 'boundaries');
    /** @type {Map<string, { json: any, bytes: number }>} */
    const detail = new Map();
    const detailSchema = ajv.getSchema('https://atniclimate.github.io/pnw-tribal-dashboard/schemas/boundary-detail.schema.json');
    for (const name of existsSync(geoDir) ? readdirSync(geoDir).filter((n) => n.endsWith('.json')).sort() : []) {
      const text = readFileSync(path.join(geoDir, name), 'utf8');
      const json = JSON.parse(text);
      checked += 1;
      if (detailSchema && !detailSchema(json)) for (const e of (detailSchema.errors ?? []).slice(0, 3)) f.problems.push(`site/data/geo/boundaries/${name}: ${e.instancePath || '/'} ${e.message}`);
      detail.set(name.replace(/\.json$/, ''), { json, bytes: Buffer.byteLength(text) });
    }
    const overviewPath = path.join(ROOT, 'site', 'data', 'geo', 'boundaries-overview.topo.json');
    const overviewText = existsSync(overviewPath) ? readFileSync(overviewPath, 'utf8') : '{}';
    const nwsKeys = new Set(zonesFromTopo(readJson('site/data/geo/nws-zones.topo.json'), 'zones').map((z) => z.id));
    const ecccIds = new Set(zonesFromTopo(readJson('site/data/geo/eccc-regions.topo.json'), 'regions').map((z) => z.id));
    const bg = boundaryGates({
      records, detail, overview: JSON.parse(overviewText), overviewBytes: Buffer.byteLength(overviewText), nwsKeys, ecccIds,
      radarIds: new Set(readJson('site/data/ref/radar-sites.json').sites.map((/** @type {any} */ s) => s.id)),
      gaugeIds: new Set([...readJson('site/data/ref/gauges.json').gauges, ...readJson('site/data/ref/wsc-stations.json').stations].map((/** @type {any} */ s) => s.id)),
      bcPolygons: draft?.bc?.nrcanPolygons ?? 1602,
      sharedKeys: new Set([
        ...Object.keys(SHARED_AREAS.lar).map((k) => `bia-lar:${k}`),
        ...(boundaries.report?.shared?.larIds ?? []).map((/** @type {string} */ k) => `bia-lar:${k}`),
        ...(boundaries.report?.shared?.censusGeoids ?? []).map((/** @type {string} */ k) => `census-aiannh-2025:${k}`),
      ]),
    });
    f.problems.push(...bg.problems); f.warnings.push(...bg.warnings); f.notes.push(...bg.notes);
  }
  if (draft) {
    const same = JSON.stringify(draft.records.map((/** @type {any} */ r) => r.id)) === JSON.stringify(records.map((r) => r.id));
    if (!same) f.problems.push('site/data/registry does not match data/registry/draft-registry.json; run 70-joins');
    else {
      const out = project(draft, readJson('data/registry/id-redirects.json'), { boundaries, joins });
      for (const r of out.records) if (stable(r) !== readFileSync(path.join(ROOT, 'site/data/registry/nations', `${r.id}.json`), 'utf8')) { f.problems.push(`site/data/registry/nations/${r.id}.json differs from the projection of the draft`); break; }
      if (exists('site/data/registry/nations-index.json') && stable(out.index) !== readFileSync(path.join(ROOT, 'site/data/registry/nations-index.json'), 'utf8')) f.problems.push('site/data/registry/nations-index.json differs from the projection of the draft; run 70-joins');
      if (exists('site/data/geo/hq-points.json')) {
        const hqText = readFileSync(path.join(ROOT, 'site/data/geo/hq-points.json'), 'utf8');
        if (hqText !== compact(out.hqPoints)) f.problems.push('site/data/geo/hq-points.json differs from the projection of the draft; run 70-joins');
        if (Buffer.byteLength(hqText) > 40960) f.problems.push(`site/data/geo/hq-points.json is ${Buffer.byteLength(hqText)} bytes, over the 40,960-byte budget`);
      }
    }
  }
  if (argv.includes('--reproducibility')) await reproducibility(argv, f);
  f.notes.push(`${checked} registry files schema-checked`);
  return f;
}

/** Rebuild in memory from the pinned inputs and compare bytes with the committed files. @param {string[]} argv @param {Findings} f */
async function reproducibility(argv, f) {
  const rawDirs = argv.flatMap((a, i) => (a === '--raw' ? [argv[i + 1] ?? ''] : []));
  if (!rawDirs.length) { f.warnings.push('--reproducibility needs --raw <folder>; skipped'); return; }
  const cfg = loadConfig('1970-01-01');
  const out = buildDraft(resolveInputs(rawDirs), cfg);
  if (stable(out.lock) !== readFileSync(path.join(REGISTRY_DIR, 'ids.lock.json'), 'utf8')) f.problems.push('a second run changes ids.lock.json (it must be byte-identical and append-only)');
  const generatedAt = '2026-10-04T00:00:00Z';
  if (stable({ schema: 'cthd.crosswalk/1', generatedAt, rows: out.crossUs }) !== readFileSync(path.join(REGISTRY_DIR, 'crosswalk-us.json'), 'utf8')) f.problems.push('a second run changes crosswalk-us.json');
  if (stable({ schema: 'cthd.crosswalk/1', generatedAt, rows: out.crossBc }) !== readFileSync(path.join(REGISTRY_DIR, 'crosswalk-bc.json'), 'utf8')) f.problems.push('a second run changes crosswalk-bc.json');
  const committed = readJson('data/registry/draft-registry.json').records;
  if (JSON.stringify(committed) !== JSON.stringify(out.records)) f.problems.push('a second run changes the draft records');
  else f.notes.push('second run is byte-identical (ids.lock.json, crosswalks, draft records)');
  // Boundaries and joins: rebuild in memory from the committed draft and compare bytes.
  if (!existsSync(path.join(REGISTRY_DIR, 'boundaries-build.json'))) return;
  const footprint = exists('site/data/geo/footprint.json') ? readJson('site/data/geo/footprint.json') : null;
  const b = await buildBoundaries({ rawDirs: [...rawDirs, path.join(ROOT, '.cache', 'inputs')], records: committed, crossUs: readJson('data/registry/crosswalk-us.json'), crossBc: readJson('data/registry/crosswalk-bc.json'), footprint });
  const geoDir = path.join(ROOT, 'site', 'data', 'geo');
  let same = readFileSync(path.join(geoDir, 'boundaries-overview.topo.json'), 'utf8') === b.overviewText;
  for (const [id, text] of b.files) if (!existsSync(path.join(geoDir, 'boundaries', `${id}.json`)) || readFileSync(path.join(geoDir, 'boundaries', `${id}.json`), 'utf8') !== text) same = false;
  if (readdirSync(path.join(geoDir, 'boundaries')).filter((n) => n.endsWith('.json')).length !== b.files.size) same = false;
  if (stable({ schema: 'cthd.boundaries-build/1', report: b.report, nations: b.nations }) !== readFileSync(path.join(REGISTRY_DIR, 'boundaries-build.json'), 'utf8')) same = false;
  if (!same) f.problems.push('a second run changes the boundary files (overview, detail, or boundaries-build.json)');
  else f.notes.push('second run of 40-boundaries is byte-identical (overview, detail files, boundaries-build.json)');
  const zip = [...rawDirs, path.join(ROOT, '.cache', 'inputs')].map((d) => path.join(d, 'z_16ap26.zip')).find((p) => existsSync(p));
  if (!zip || !existsSync(path.join(REGISTRY_DIR, 'joins-build.json'))) { f.warnings.push('joins reproducibility skipped: z_16ap26.zip or joins-build.json is absent'); return; }
  const j = computeJoins({
    records: committed, boundaries: { nations: b.nations },
    detail: (id) => { const t = b.files.get(id); return t ? JSON.parse(t) : null; },
    nwsZones: zonesFromTopo(readJson('site/data/geo/nws-zones.topo.json'), 'zones'), ecccZones: zonesFromTopo(readJson('site/data/geo/eccc-regions.topo.json'), 'regions'),
    cwa: await cwaByForecastZone(readFileSync(zip)), citypages: readJson('data/registry/eccc-citypage-sites.json').sites, radar: readJson('site/data/ref/radar-sites.json').sites,
    gauges: gaugeCandidates(readJson('site/data/ref/gauges.json'), readJson('site/data/ref/wsc-stations.json')),
    gaugeOverrides: await readGaugeOverrides(),
  });
  if (stable({ schema: 'cthd.joins-build/1', report: j.report, nations: j.nations }) !== readFileSync(path.join(REGISTRY_DIR, 'joins-build.json'), 'utf8')) f.problems.push('a second run changes joins-build.json (the gauge or zone reference files changed since the last 70-joins run)');
  else f.notes.push('second run of 70-joins is byte-identical (joins-build.json)');
}

// ---------------------------------------------------------------------------------------------
// Review packet and crosswalk notes
// ---------------------------------------------------------------------------------------------

/** @param {string} s */
const esc = (s) => String(s).replace(/\|/g, '\\|');
/** @param {string[]} head @param {string[][]} rows */
const table = (head, rows) => [`| ${head.join(' | ')} |`, `| ${head.map(() => '---').join(' | ')} |`, ...rows.map((r) => `| ${r.map(esc).join(' | ')} |`)].join('\n');
/** @param {number} n */
const spell = (n) => {
  const w = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve'];
  return n <= 12 ? /** @type {string} */ (w[n]) : String(n);
};
/** @param {string} s */
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * @param {string} dir
 * @param {ReturnType<typeof buildDraft>} out
 * @param {{ boundaries: any, joins: any } | null} [extra] the boundary and join builds (wave 2)
 */
export function writePacket(dir, out, extra = null) {
  mkdirSync(dir, { recursive: true });
  const { records, report } = out;
  const rv = report.review ?? { reviewed: 0, draft: records.length, held: [] };
  const counts = countRegistry(records);
  const gUs = COUNT_GATES.usOutsideAlaska;
  const gSe = COUNT_GATES.southeastAlaska;
  const gBc = COUNT_GATES.britishColumbia;
  const usMet = counts.usOutsideAlaska >= gUs.min && counts.usOutsideAlaska <= gUs.max;
  const us = records.filter((r) => r.country === 'US');
  const bc = records.filter((r) => r.country === 'CA');
  const qnames = records.filter((r) => /[?�]/.test(r.name));
  const tzFlag = records.filter((r) => r.flags.includes('tz-needs-confirmation'));
  const tzOverride = records.filter((r) => r.timeZoneSource === 'override');
  /** @type {Record<string, string>} */
  const tzLookupWrong = {};
  for (const r of tzOverride) tzLookupWrong[r.id] = tzlookup(r.hq.lat, r.hq.lon);
  const larUnm = report.us.larUnmatched;
  const mismatchRows = out.crossUs.filter((r) => /after removing/.test(r.notes ?? ''));
  /** @type {Record<string, number>} */
  const tzCount = {};
  for (const r of records) tzCount[r.timeZone] = (tzCount[r.timeZone] ?? 0) + 1;
  /** @type {Record<string, number>} */
  const stateCount = {};
  for (const r of us) stateCount[r.id.slice(3, 5).toUpperCase()] = (stateCount[r.id.slice(3, 5).toUpperCase()] ?? 0) + 1;
  const sc = report.sourceCounts;
  const censusClassCounts = { G2101: sc.censusG2101, G2102: sc.censusG2102 };

  const caByCounty = new Map();
  for (const x of report.us.caOutside) { const k = x.county || 'no county found'; if (!caByCounty.has(k)) caByCounty.set(k, []); caByCounty.get(k).push(x.name); }

  const bld = extra?.boundaries ?? null;
  const jn = extra?.joins ?? null;
  const polyIds = new Set(Object.keys(bld?.nations ?? {}));
  const pointOnly = records.filter((r) => !polyIds.has(r.id));
  const cand = report.us.areaCandidates ?? [];
  const candRej = (report.us.areaCandidatesRejected ?? []).filter((/** @type {any} */ x) => x.why && !/more than one/.test(x.why) && x.tier === 1);
  const candAmb = (report.us.areaCandidatesRejected ?? []).filter((/** @type {any} */ x) => /more than one/.test(x.why));
  const larAndTrust = [...new Set(out.crossUs.filter((r) => r.sourceId === 'census-aiannh-2025' && r.sourceKey.endsWith('T') && out.crossUs.some((x) => x.nationId === r.nationId && x.sourceId === 'bia-lar')).map((r) => `${records.find((x) => x.id === r.nationId)?.name ?? r.nationId} ${r.sourceKey}`))];
  const sizes = bld?.report;
  const bcNoPoly = pointOnly.filter((r) => r.country === 'CA');
  const akNoPoly = pointOnly.filter((r) => r.country === 'US' && r.region === 'ak-se');
  const otherNoPoly = pointOnly.filter((r) => r.country === 'US' && r.region !== 'ak-se');
  const packet = `# Nation Registry Review Packet, Wave 2 (Draft)

Prepared 10/05/2026 for the maintainer by lane L5. ${rv.reviewed ? `Approved with amendments by the maintainer on 10/05/2026 (packet-amendments-2026-10-05.md): ${rv.reviewed} records are \`reviewed\` and ${rv.draft} ${rv.draft === 1 ? 'stays' : 'stay'} \`draft\`${rv.held.length ? ` (${rv.held.join(', ')})` : ''}. The decision tables below are kept as the record of what was asked.` : 'Every record is `review.status: draft`. Nothing in this packet is decided: each item below is a request for a ruling, and no record becomes `reviewed` until the maintainer approves it.'} Source files are pinned in \`data/registry/inputs.yaml\` with SHA-256 values; this packet is regenerated by \`node scripts/reference/90-validate.mjs --packet <folder> --raw <folders>\`.

## The Brief

The draft registry holds ${counts.total} Nations: ${counts.us} U.S. Tribes (${counts.usOutsideAlaska} outside Alaska and ${counts.southeastAlaska} in Southeast Alaska) and ${counts.britishColumbia} British Columbia First Nations. U.S. names come from the Federal Register notice of 01/30/2026 (91 FR 4102) and are cross-checked to the BIA Tribal Leaders Directory; British Columbia names are the ISC registered names. Headquarters points come from the Directory (U.S.) and the ISC location file (British Columbia), each with its source record id and retrieval date. ${rv.reviewed ? 'The footprint edges were ratified by the maintainer on 10/05/2026 (Chouteau County, Montana, added).' : 'The footprint edges are the Q2 proposal and remain unratified.'}${sizes ? ` Wave 2 adds land-area polygons for ${polyIds.size} Nations (${sizes.bySource['bia-lar']} BIA land area representations, ${sizes.bySource['census-aiannh-2025']} Census legal areas, and ${sizes.bySource['nrcan-aboriginal-lands-bc']} NRCan reserve polygons), and the joins to NWS zones, ECCC city pages and zones, radar, and gauges. ${spell(pointOnly.length)} Nations stay point-only (see Boundaries). Every polygon, match, and join is a draft; the polygons are representations, not jurisdiction.` : ' Boundaries, NWS zones, ECCC city pages, radar, and gauges are wave 2 joins and are empty in every record.'}

${cand.length ? `The land-area recall gap that the crosswalk review raised (twenty-one Tribes with no LAR or Census identifier) is closed by place-phrase candidates: ${cand.length} candidate matches are recorded as \`name-reviewed\` with \`reviewed: false\` for the maintainer to confirm (see Land Area Candidates). ` : ''}${usMet ? `The U.S. count outside Alaska (${counts.usOutsideAlaska}) is within the gate of ${gUs.min} to ${gUs.max}; the northern California county list reaches ${us.filter((r) => r.region === 'ca-n').length} Tribes.` : `The U.S. count outside Alaska (${counts.usOutsideAlaska}) is outside the gate of ${gUs.min} to ${gUs.max}; the northern California county list reaches ${us.filter((r) => r.region === 'ca-n').length} Tribes; see Decision One.`} ${qnames.length ? `${cap(spell(qnames.length))} British Columbia names carry the ISC \`?\` placeholder and need each Nation's own published spelling; see Names Containing a Question Mark.` : 'No displayed name carries the ISC `?` placeholder.'}

## Decisions Requested

${table(['No.', 'Decision', 'Where the evidence is', 'Default if no ruling'], [
  ['1', 'Footprint edges (Q2) and the count gate: widen northern California, or lower the gate', 'Counts and Gates; Northern California Candidates', 'Q2 proposal as built; count gate reported as a warning'],
  ['2', 'Montana: Blackfeet Nation and Chippewa Cree Tribe in or out', 'Included U.S. Nations (basis column); scope.yaml', 'Included provisionally so L6 contact rows resolve'],
  ['3', 'Nevada: only Duck Valley and Fort McDermitt, or every Nation in Elko and Humboldt counties', 'Explicit Excludes', 'Only Duck Valley and Fort McDermitt (Data Rulings)'],
  ['4', 'Elem Indian Colony: land in Lake County, office in Santa Rosa', 'scope.yaml', 'Included by scope.yaml'],
  ['5', 'Liard First Nation (Yukon headquarters, nine British Columbia reserves)', 'Explicit Excludes', 'Excluded'],
  ['6', "Spelling of the names that carry the ISC placeholder, from each Nation's own site", 'Names Containing a Question Mark', 'Draft names keep the placeholder and the flag'],
  ['7', 'Federal Register spelling questions (for example "PuliklaTribe")', 'Names and Their Sources', 'Name kept exactly as the notice prints it'],
  ['8', 'Time zones flagged for confirmation, including Duck Valley and Fort McDermitt (Q15) and the five draft corrections that replace a border-point lookup', 'Time Zones', 'Draft overrides stay in place and flagged; tz-lookup value kept for the rest'],
  ['9', 'Name display order (Q4) and any preferred-name overrides', 'Names and Their Sources', 'Full formal name first; no preferred names set'],
  ['10', 'Identifier slugs cut at eighty characters (for example Fort McDermitt) and L6 contact ids that differ', 'Id Notes', 'Ids stay as minted; L6 contact rows already match the lock'],
  ...(sizes ? [
    ['11', `Confirm or reject the ${cand.length} place-phrase land-area candidates (name-reviewed, unconfirmed)`, 'Land Area Candidates', 'Drawn as drafts with the crosswalk row marked unreviewed'],
    ['12', 'Columbia River land areas held for several Tribes (Celilo and The Dalles Unit): which Nations, if any, they belong to', 'Shared Land Areas', 'Assigned to no Nation and not drawn'],
    ['13', `${cap(spell(bcNoPoly.length))} British Columbia Nations have no reserve polygon (treaty settlement lands are not reserves): supply a treaty-lands source, or leave them point-only`, 'Boundaries', 'Point-only'],
    ['14', 'Off-reservation trust land of Nations that also have a LAR (for example Colville 0760T): draw it, or keep the contract rule that Census is used only where LAR has no polygon', 'Boundaries', 'Not drawn (LAR first)'],
    ['15', 'Alaska Native village areas (Census statistical areas) for Southeast Alaska: allow them, or keep the nineteen village Nations point-only', 'Boundaries', 'Point-only (statistical areas stay out)'],
    ['16', 'Join policies: zone overlap share (two percent), marine reach (ten kilometres), radar range (460 kilometres), nearby gauge radius (25 kilometres)', 'Joins', 'Policies as written; each is a constant in 70-joins.mjs'],
  ] : []),
])}

## Counts and Gates

${table(['Gate (blueprint 6.2)', 'Range', 'Actual', 'Result'], [
  ['U.S. Tribes outside Alaska', `${gUs.min} to ${gUs.max}`, String(counts.usOutsideAlaska), usMet ? 'met' : 'NOT MET'],
  ['Southeast Alaska', `${gSe.min} to ${gSe.max}`, String(counts.southeastAlaska), counts.southeastAlaska >= gSe.min && counts.southeastAlaska <= gSe.max ? 'met' : 'NOT MET'],
  ['British Columbia First Nations', `${gBc.min} to ${gBc.max}`, String(counts.britishColumbia), counts.britishColumbia >= gBc.min && counts.britishColumbia <= gBc.max ? 'met' : 'NOT MET'],
])}

U.S. Nations by state of the headquarters id prefix: ${Object.entries(stateCount).sort().map(([k, v]) => `${k} ${v}`).join(', ')}.

Source count reconciliation:

${table(['Source (file, date)', 'Rows read', 'Registry use'], [
  ['Federal Register notice (91 FR 4102, 01/30/2026)', `${sc.federalRegisterEntries} list entries (${sc.federalRegisterContiguous} contiguous 48 states, ${sc.federalRegisterAlaska} Alaska); the notice summary states 575 entities`, 'Formal U.S. names'],
  ['BIA Tribal Leaders Directory (10/04/2026)', `${sc.tldRows} rows (${sc.tldTribes} Tribes and ${sc.tldRows - sc.tldTribes} affiliates)`, `${us.length} U.S. Nations; affiliates never become Nations`],
  ['BIA Alaska Native Villages', `${sc.anvRows} rows`, 'Cross-check of Southeast Alaska village rows (same OBJECTID and name)'],
  ['BIA LAR', `${sc.larFeatures} features`, `Identifier crosswalk, and polygons of the matched areas (${sizes ? sizes.bySource['bia-lar'] : 0} features)`],
  ['Census TIGER 2025 AIANNH', `${sc.censusAiannhRows} rows`, `Identifier crosswalk (legal classes G2101 reservations and G2102 off-reservation trust land); polygons only for Nations with no LAR (${sizes ? sizes.bySource['census-aiannh-2025'] : 0} features)`],
  ['ISC First Nation locations', `${sc.iscLocationRows} rows (all of Canada)`, `${bc.length} British Columbia Nations`],
  ['ISC reserve relation', `${sc.iscReserveRows} rows`, `${report.bc.nrcanJoined} British Columbia polygons joined`],
  ['ISC tribal council relation', `${sc.iscCouncilRows} rows`, 'isc.tribalCouncil'],
  ['NRCan AL_TA BC', `${sc.nrcanPolygons} polygons`, `${report.bc.nrcanJoined} of ${report.bc.nrcanPolygons} joined to a First Nation (${((100 * report.bc.nrcanJoined) / Math.max(1, report.bc.nrcanPolygons)).toFixed(1)} percent; gate 95)`],
])}

The Federal Register list parse found ${sc.federalRegisterEntries} entries, and the notice's summary states 575. ${sc.federalRegisterSeeReferences} entries carry a "See" cross reference to another listing. The Directory lists ${sc.tldTribes} Tribe rows, equal to the parsed entries. The text of the notice does not explain the difference of ${sc.federalRegisterEntries - 575}; it is reported here and not resolved. No included Nation depends on it, because every included Nation matched its own entry.

## Included U.S. Nations

Rule: Washington, Oregon, and Idaho Tribes by Directory state; northern California by headquarters county (${CA_COUNTIES.join(', ')}); Southeast Alaska by headquarters borough or census area (${AK_SE_BOROUGHS.join(', ')}); plus the scope.yaml includes. Basis is each record's footprint basis.

${table(['Id', 'Formal name (Federal Register)', 'Kind', 'Jurisdictions', 'Basis', 'Directory object id', 'Time zone'], us.map((r) => [r.id, r.name, r.kind, r.jurisdictions.join(', '), /Footprint basis: (.*)\.$/.exec(r.review.notes)?.[1] ?? '', String(r.codes.biaTldObjectId), r.timeZone]))}

## Included British Columbia First Nations

Rule: headquarters inside, or within ${BC_TOLERANCE_KM} kilometres of, the Natural Earth British Columbia outline, or at least one reserve polygon in the NRCan British Columbia layer reached through the ISC reserve relation. ${report.bc.both} Nations satisfy both tests, ${report.bc.hqInBcOnly.length} only the headquarters-inside test, ${report.bc.nearOutline.length} have a headquarters outside the outline but within the tolerance (${report.bc.nearOutline.filter((/** @type {any} */ x) => x.reserves > 0).length} of them also have a reserve polygon and so pass the reserve test; ${spell(report.bc.nearOutline.filter((/** @type {any} */ x) => !x.reserves).length)} ${report.bc.nearOutline.filter((/** @type {any} */ x) => !x.reserves).length === 1 ? 'depends' : 'depend'} on the tolerance alone), and ${report.bc.reserveOnly.length} have a headquarters outside the tolerance and pass only the reserve test.

${table(['Id', 'ISC registered name', 'Time zone', 'Flags'], bc.map((r) => [r.id, r.name, r.timeZone, r.flags.join(', ')]))}

### Near the Outline (Headquarters Within ${BC_TOLERANCE_KM} Kilometres)

${report.bc.nearOutline.length ? table(['Band', 'Name', 'Kilometres from outline', 'Reserve polygons'], report.bc.nearOutline.map((/** @type {any} */ x) => [x.band, x.name, String(x.km), String(x.reserves)])) : 'None.'}

### Reserve Test Only (Headquarters Outside the Outline)

${report.bc.reserveOnly.length ? table(['Band', 'Name', 'Latitude', 'Longitude', 'Reserve polygons'], report.bc.reserveOnly.map((/** @type {any} */ x) => [x.band, x.name, x.lat.toFixed(4), x.lon.toFixed(4), String(x.reserves)])) : 'None.'}

## Explicit Excludes

${table(['Key', 'Reason'], [...(report.us.exclude ?? []).map((/** @type {any} */ x) => [`bia-tld:${x.name}`, x.reason]), ...(report.bc.excluded ?? []).map((/** @type {any} */ x) => [`isc:${x.band} (${x.name})`, x.reason])])}

Every other Directory Tribe outside the footprint rules is excluded by rule, not by a list. The Directory carries ${sc.tldTribes} Tribes; ${us.length} are in the draft. Affiliates (constituent bands and colonies listed under another Tribe) are never separate Nations; those in footprint states: ${report.us.affiliates.length ? report.us.affiliates.map((/** @type {any} */ a) => a.name).join('; ') : 'none'}.

## Northern California Candidates (Decision One)

The Q2 county proposal reaches ${us.filter((r) => r.region === 'ca-n').length} Tribes. The Directory lists ${report.us.caOutside.length} more California Tribes whose headquarters lie in other counties; adding them in full would bring the U.S. count outside Alaska to about ${counts.usOutsideAlaska + report.us.caOutside.length}. The counts by headquarters county follow so the maintainer can ratify a list or change the gate.

${table(['County of headquarters', 'Tribes', 'Names'], [...caByCounty.entries()].sort((a, b) => b[1].length - a[1].length).map(([k, v]) => [k, String(v.length), v.join('; ')]))}

Wave 2 will also test every Tribe whose land polygons (BIA LAR and Census) fall inside a footprint county but whose office does not (Elem Indian Colony is the known example) and list those for ruling.

## Names and Their Sources

■ Source of every U.S. name: the Federal Register notice (91 FR 4102, FR Doc. 2026-01899), \`nameSource.kind: federal-register\`. A Directory \`tribefullname\` that differs from the notice is listed below and never silently resolved. ${out.report.us.frMismatch.length ? `Records with no Federal Register match: ${out.report.us.frMismatch.map((/** @type {any} */ x) => x.name).join('; ')}.` : 'Every included Tribe matched a Federal Register entry.'}

■ Annotations removed from a listing (former names, cross references, constituent lists), kept as search aliases where they are former names:

${table(['Id', 'Federal Register entry', 'Name used'], out.report.frFootprintParentheticals.filter((/** @type {any} */ x) => x.raw !== x.name).map((/** @type {any} */ x) => [x.id, x.raw, x.name]))}

■ Parentheticals retained as part of the listed name:

${table(['Id', 'Name used'], out.report.frFootprintParentheticals.filter((/** @type {any} */ x) => x.raw === x.name).map((/** @type {any} */ x) => [x.id, x.name]))}

■ Directory names that matched the notice only after an annotation was removed: ${mismatchRows.length ? mismatchRows.map((r) => r.nationId).join('; ') : 'none'}.

■ Possible spelling errors in the notice itself (printed verbatim, not corrected): "PuliklaTribe of Yurok People" has no space between "Pulikla" and "Tribe". The notice's other included names were checked only for exact match to the Directory.

■ Display order (Q4) is not applied: no \`preferredName\` is set on any record because a preferred name must come from the Nation's own published site, which the maintainer rules on.

## Names Containing a Question Mark

${qnames.length ? table(['Id', 'ISC registered name', "ISC profile to check for the Nation's own spelling"], qnames.map((r) => [r.id, r.name, `https://fnp-ppn.aadnc-aandc.gc.ca/fnp/Main/Search/FNMain.aspx?BAND_NUMBER=${r.isc.bandNumber}&lang=eng`])) : 'No record carries ? or U+FFFD.'}

${cap(spell(qnames.length))} record${qnames.length === 1 ? '' : 's'} carry the ISC placeholder. Each is flagged \`name-orthography-needs-nation-source\`, cannot be marked \`reviewed\`, and blocks launch while displayed. The correction path is \`data/registry/names.yaml\` with the Nation's own published name and a source URL. Only names that contain a \`?\` or U+FFFD are listed here; other First Nation names may still differ from the Nation's own orthography and are left to the maintainer's review of the full list above.

## Time Zones

Every zone comes from \`@photostructure/tz-lookup\` at the headquarters point, except the ${tzOverride.length} overrides below (\`overrides.yaml\`, field \`timeZone\`, each with a source and reason${rv.reviewed ? '; ratified by the maintainer on 10/05/2026' : ', none ratified'}). Counts: ${Object.entries(tzCount).sort().map(([k, v]) => `${k} ${v}`).join(', ')}.

A validator gate in \`90-validate.mjs\` fails any record whose zone is not consistent with its first jurisdiction (\`TZ_BY_JURISDICTION\` in \`50-registry.mjs\`: for example Southeast Alaska must be an Alaska zone, and British Columbia must be a Canadian zone). The builder's lookup check found ${spell(tzOverride.filter((r) => !tzConsistent(r.jurisdictions, tzLookupWrong[r.id] ?? '')).length)} border-point lookups that were wrong by jurisdiction (the two Southeast Alaska records were an hour off). An override is a ratified zone and clears the flag (packet amendments 10/05/2026, A.3); a record without one is flagged when its lookup disagrees with its jurisdiction or needs local-practice confirmation:

${table(['Id', 'Lookup zone', 'Override zone'], tzOverride.map((r) => [r.id, tzLookupWrong[r.id] ?? '', r.timeZone]))}

Flagged \`tz-needs-confirmation\` (${tzFlag.length})${tzFlag.length ? ': Duck Valley and Fort McDermitt (Q15) without an override, any border-point lookup without an override, and every British Columbia Nation without an override in a zone other than `America/Vancouver` (local practice in the East Kootenay, Peace, Fort Nelson, and Creston areas differs).' : '.'}

${table(['Id', 'Zone'], tzFlag.map((r) => [r.id, r.timeZone]))}

## Crosswalk Exceptions

${table(['Check', 'Count', 'Detail'], [
  ['U.S. Tribes with a land-area LARtype and no exact LAR name match', String(larUnm.length), larUnm.map((/** @type {any} */ x) => x.name).join('; ') || 'none'],
  ['LAR names claimed by two Nations (ambiguous, skipped)', String(report.us.larAmbiguous.length), report.us.larAmbiguous.map((/** @type {any} */ x) => `${x.name} (${x.keys.join(', ')})`).join('; ') || 'none'],
  ['U.S. Tribes with a land-area LARtype and no Census legal-area name match', String(report.us.censusUnmatched.length), report.us.censusUnmatched.map((/** @type {any} */ x) => x.name).join('; ') || 'none'],
  [`Census areas whose name matched but whose internal point is over ${CENSUS_GUARD_KM} kilometres from the headquarters (not matched)`, String(report.us.censusRejected.length), report.us.censusRejected.map((/** @type {any} */ x) => `${x.name} ${x.geoid} (${x.km} km)`).join('; ') || 'none'],
  ['NRCan polygons not joined to a First Nation', String(report.bc.nrcanUnjoined.length), report.bc.nrcanUnjoined.map((/** @type {any} */ x) => `${x.alcode} ${x.name}`).join('; ') || 'none'],
])}

The method is in \`L5-crosswalk.md\`. ${rv.reviewed ? 'The `code` and `name-exact` rows of approved records are marked reviewed; every `name-reviewed` candidate stays unreviewed.' : 'No match is marked reviewed.'} The unmatched rows above are the counts after the place-phrase candidates of wave 2; the Tribes still unmatched have no land-area record of that name in the pinned files (Snoqualmie has a Census reservation and no LAR; Potter Valley, Scotts Valley, and Elem have a LAR and, for the first two, no Census area; the Coos, Lower Umpqua, and Siuslaw confederation has Census areas and no LAR).

## Land Area Candidates

Reservation names are rarely the Directory short names, so Tribes such as Yakama, Umatilla, Hoopa Valley, and Flathead had no exact LAR or Census match. For each Tribe with no land-area identifier, the place words of its Federal Register listing (including "previously listed as" and "includes" text) were compared with every unclaimed land-area name. A candidate is kept only when the whole place phrase appears in the listing (tier one) or the area name begins with a listing word (tier two), the area lies within ${CANDIDATE_KM.tier1} kilometres (tier one) or ${CANDIDATE_KM.tier2} kilometres (tier two) of the headquarters or is named in the listing's own "includes" list, and exactly one Nation claims it. Each is recorded as \`name-reviewed\` with \`reviewed: false\`, never as \`name-exact\`, and none is final until the maintainer confirms it.

${cand.length ? table(['Nation', 'Source', 'Area key', 'Area name', 'Tier', 'Kilometres from headquarters', 'Basis'], cand.map((/** @type {any} */ x) => [x.nationId, x.source, x.key, x.name, String(x.tier), String(x.km), x.viaIncludes ? 'listed in the entry includes clause' : 'place phrase and distance'])) : 'No candidates.'}

Rejected as too far (tier one, over the limit): ${candRej.length ? candRej.map((/** @type {any} */ x) => `${x.name} ${x.key} for ${x.nationId} (${x.km} km)`).join('; ') : 'none'}. Tier two candidates over fifteen kilometres are not listed (${(report.us.areaCandidatesRejected ?? []).filter((/** @type {any} */ x) => x.tier === 2).length} first-word coincidences such as the several areas that begin with "Fort" or "Big"). Claimed by more than one Nation: ${candAmb.length ? candAmb.map((/** @type {any} */ x) => `${x.name} ${x.key}`).join('; ') : 'none'}.

## Shared Land Areas

${table(['Source', 'Key', 'Name'], (report.us.sharedAreas ?? []).map((/** @type {any} */ x) => [x.source, x.key, x.name]))}

These Columbia River areas are described in the crosswalk review as held for more than one Tribe. No source in the build names which Nations they serve, so the build never assigns them by name and draws them for no Nation. The maintainer rules which Nations, if any, they belong to (Decision 12).

${sizes ? `## Boundaries

Policy (blueprint 4.2 and 6.2): BIA LAR first; Census legal classes (G2101 reservations and G2102 off-reservation trust land) only for a Nation with no LAR polygon; NRCan reserves for British Columbia through the ISC reserve relation by code. ${polyIds.size} of ${records.length} Nations have polygons. The overview file is ${sizes.overviewBytes.toLocaleString('en-US')} bytes against 614,400, and the ${sizes.detailFiles} detail files total ${sizes.detailBytes.toLocaleString('en-US')} bytes against 15,728,640. Features: ${Object.entries(sizes.bySource).map(([k, v]) => `${k} ${v}`).join(', ')}. Every feature carries source, id, and vintage (${Object.entries(sizes.vintages).map(([k, v]) => `${k} ${v}`).join(', ')}). Samples are interior points of the land areas computed on the final detail geometry and verified inside it.

${spell(pointOnly.length)} Nations stay point-only:

${table(['Group', 'Count', 'Reason', 'Nations'], [
  ['Southeast Alaska villages', String(akNoPoly.length), 'Alaska Native village areas are Census statistical areas, which stay out while boundary_policy.census_statistical_areas is false (Decision 15)', akNoPoly.map((r) => r.name).join('; ')],
  ['Other U.S.', String(otherNoPoly.length), 'No land-area record of that name in the pinned LAR or Census files', otherNoPoly.map((r) => r.name).join('; ')],
  ['British Columbia', String(bcNoPoly.length), 'No reserve polygon in NRCan reached through the ISC reserve relation; most are treaty Nations whose treaty settlement lands are not reserves (Decision 13)', bcNoPoly.map((r) => `${r.id} ${r.name}`).join('; ')],
])}

Off-reservation trust land (Census G2102) of Nations that also have a LAR is not drawn, because the contract uses Census only where LAR has no polygon (Decision 14): ${larAndTrust.length ? larAndTrust.join('; ') : 'none'}.

British Columbia reserve polygons: ${report.bc.nrcanJoined} of ${report.bc.nrcanPolygons} joined to a First Nation (${((100 * report.bc.nrcanJoined) / Math.max(1, report.bc.nrcanPolygons)).toFixed(1)} percent; gate 95). The unjoined polygons are listed in Crosswalk Exceptions. A reserve held by several bands is drawn once for each band, so ${sizes.bySource['nrcan-aboriginal-lands-bc']} features draw ${report.bc.nrcanJoined} polygons.

### Land Areas Inside the Footprint Held by No Nation

Legal LAR and Census areas whose interior point lies in the footprint and that no Nation holds in the crosswalk. Most are Nevada Tribes outside the Duck Valley and Fort McDermitt rule (Decision 3). Tribes whose land lies in the footprint while the office does not are found here.

${table(['Source', 'Key', 'Name', 'Footprint region'], sizes.unassignedInFootprint.map((/** @type {any} */ x) => [x.source, x.key, x.name, x.region]))}

## Joins

${jn ? `Every join is a documented policy in the header of \`70-joins.mjs\`; no value is invented, and a join that finds nothing stays empty.

${table(['Join', 'Rule', 'Result'], [
  ['NWS zones (U.S. Nations)', 'A zone is listed when it contains the headquarters, an interior sample, or the inner point of any land-area part, or covers at least two percent of the land area; a headquarters or a part in no zone takes the nearest zone within five kilometres. Marine zones within ten kilometres. Zone edges are simplified to about 1.2 kilometres, so a Nation beside a county line may list the neighboring county.', `${jn.report.nws.withWfo} of ${jn.report.nws.nations} Nations have a forecast office and zones`],
  ['ECCC (British Columbia)', 'Nearest of the 98 British Columbia city pages (a dated capture of the ECCC city page list), with the distance; public forecast zones by the same overlap rule.', `${jn.report.eccc.withCityPage} of ${jn.report.eccc.nations} have a city page; ${jn.report.eccc.withForecastZones} have a forecast zone (the others lie 47 to 59 kilometres from the nearest zone polygon in the pinned ECCC file)`],
  ['Radar', 'Nearest U.S. NWS site within 460 kilometres (the long range of WSR-88D base reflectivity), else none. ECCC radar sites have no machine-readable list, so that field stays empty.', `${jn.report.radar.withRadar} of ${records.length} Nations have a site; ${jn.report.radar.withoutRadar.length} British Columbia Nations are beyond range`],
  ['Gauges', 'NWPS gauges and Water Survey of Canada stations within 25 kilometres of the headquarters or an interior sample, ranked with the Nation\'s own country first, then NWS forecast points, then nearest; at most six; then the reviewed Nation entries of gauges-overrides.yaml (none today). "Nearby gauges", never "gauges affecting".', `${jn.report.gauges.withGauges} of ${records.length} Nations have at least one; ${jn.report.gauges.withoutGauges} have none within range`],
])}
` : 'The join build is not present.'}
` : ''}

## Id Notes

■ Ids come only from \`site/static/js/data/ids.js\` through \`assignNationId\` and are frozen in \`data/registry/ids.lock.json\` (${out.lock.entries.length} entries, append-only). U.S. ids use the formal (Federal Register) name, so an id never carries a "previously listed as" or "includes" annotation.

■ The eighty-character slug limit cuts long names at a word boundary (for example \`us-nv-fort-mcdermitt-paiute-and-shoshone-tribes-of-the-fort-mcdermitt-indian\`). Ids are permanent; the maintainer may prefer a shorter slug before the lock is committed, which is cheap now and costly later.

■ The two Lane L6 contact rows that once named other ids (Pit River, \`us-ca-pit-river-tribe-california\`, and the Yurok component, \`us-ca-puliklatribe-of-yurok-people\`) now carry the lock ids; \`validate:data\` no longer reports them.

## Remaining Work

${rv.reviewed ? `■ The held record${rv.held.length === 1 ? '' : 's'} (${rv.held.join(', ') || 'none'}) and the place-phrase land-area candidates need their own confirmation.` : '■ Maintainer rulings on the decisions above; no record becomes `reviewed` before the packet is approved.'}

■ Replace the Natural Earth outline scope aid with the L4 \`emcr-bc-boundaries\` outline for the British Columbia membership test.

■ A pinned refresh path for the ECCC city page list (\`data/registry/eccc-citypage-sites.json\` is a dated capture); a reducer in the L4 fetch step would let the monthly build refresh it.
`;
  writeFileSync(path.join(dir, 'L5-review-packet.md'), packet);

  const byMethod = (/** @type {any[]} */ rows) => {
    /** @type {Record<string, number>} */
    const m = {};
    for (const r of rows) m[`${r.sourceId} / ${r.matchMethod}`] = (m[`${r.sourceId} / ${r.matchMethod}`] ?? 0) + 1;
    return Object.entries(m).sort().map(([k, v]) => [k, String(v)]);
  };
  const cross = `# Nation Registry Crosswalk Notes, Wave 2 (Draft)

Prepared 10/05/2026 by lane L5. This file explains exactly how the BIA, Census, ISC, and NRCan identifiers and names were matched to registry Nations. The rows themselves are \`data/registry/crosswalk-us.json\` and \`data/registry/crosswalk-bc.json\`. ${rv.reviewed ? 'After the maintainer\'s approval of 10/05/2026, the `code` and `name-exact` rows of reviewed records carry `reviewed: true`; every other row carries `reviewed: false`.' : 'Every row has `reviewed: false`; no match is a reviewed match until the maintainer approves the packet.'} Match methods use the schema's words: \`code\` (an identifier equal in both sources), \`name-exact\` (a normalized name equal in both sources), \`name-reviewed\` (a place-phrase candidate that the build accepted under the rules below, awaiting the maintainer's confirmation; \`reviewed\` stays false) and \`manual\` (a person decided; none yet).

## The Brief

The registry is built from two directions. U.S. Nations start from the BIA Tribal Leaders Directory (and the Alaska Native Villages layer), take their formal name from the Federal Register notice, and pick up land identifiers from BIA LAR and Census AIANNH by name. British Columbia First Nations start from the ISC location file, take their band number as the id, and reach their reserve polygons by code through the ISC reserve relation to NRCan. Where a join is by name, it is by exact normalized name first, then by the place phrase of the Federal Register listing as a reviewable candidate (see Place-Phrase Candidates); a name claimed by two Nations is skipped as ambiguous rather than guessed.

## Name Normalization

One function (\`normName\` in \`scripts/reference/50-registry.mjs\`) serves every name comparison: Unicode NFKD, combining marks removed, lower case, \`&\` read as "and", every run of characters outside a to z and zero to nine collapsed to one space, trimmed. It is for matching only and never changes a displayed name.

## Row Counts

${table(['Source and method', 'Rows'], [...byMethod(out.crossUs), ...byMethod(out.crossBc)])}

## U.S. Matches

■ **BIA Tribal Leaders Directory (\`bia-tld\`).** The originating record. Only these fields are read: OBJECTID, tribefullname, tribealternatename, tribalcomponent, biaregion, biaagency, city, state, website, latitude, longitude, LARtype, pointlocation, tribeshortname, and tribalcomponentname. The allowlist is applied as each feature is read; leader names, individual emails, elections, and every other person field never leave the reader. Rows with \`tribalcomponent\` other than Tribe (${sc.tldRows - sc.tldTribes} affiliates) are never Nations. Headquarters points use the \`latitude\` and \`longitude\` attributes, not the Web Mercator geometry. \`pointlocation\` Tribal Office gives \`precision: office\`; City Center gives \`community\`. The id key is \`bia-tld:<tribefullname>\`.

■ **BIA Alaska Native Villages (\`bia-anv\`).** Rows whose Directory \`LARtype\` is Alaska Native Village are matched to the ANV layer by OBJECTID and identical \`tribefullname\` (the two layers share OBJECTIDs). They become \`kind: alaska-native-village\`, their headquarters source is \`bia-anv\`, and their id key is \`bia-anv:<tribefullname>\`. Metlakatla Indian Community, Annette Island Reserve has no ANV row and is a federally recognized Tribe with a land-area record; it keeps the Directory.

■ **Federal Register (\`federal-register-tribes\`).** Each of the ${sc.federalRegisterEntries} \`<FP>\` entries of the pinned notice XML is decoded and whitespace-folded. A Directory \`tribefullname\` matches an entry when the normalized strings are equal (\`name-exact\`); failing that, when it equals the entry or the Directory name with its trailing annotation removed (still \`name-exact\`, with a note naming the annotation). An annotation is a trailing parenthetical that begins "previously listed as", "See", "aka", "includes", or a constituent-count phrase; any other parenthetical (for example "(Klukwan)") is part of the listed name. The formal name is the entry without annotations; former names become search aliases. A Directory row with no match would fall back to the Directory name with \`matchMethod: manual\` and a listing in the packet; none occurred in the footprint.

■ **BIA LAR (\`bia-lar\`).** The LAR layer carries LARID, LARNAME, CLASSIFICATION, and acres, and no Tribe key, so the join is by name. A Nation's keys are its normalized \`tribalcomponentname\`, \`tribeshortname\`, and \`tribealternatename\`; a LAR matches when its normalized LARNAME equals a key. If two Nations in the draft share a key, the LAR is ambiguous and neither gets it (listed in the packet). A hit sets \`codes.biaLarIds\` and one \`name-exact\` row per LARID. Directory rows whose LARtype is Land Area Representation but that have no hit are listed in the packet.

■ **Census AIANNH (\`census-aiannh-2025\`).** Only legal classes are considered, and there are two of them in the pinned 2025 file: MTFCC G2101 (federally recognized reservations, GEOID suffix \`R\`, ${censusClassCounts.G2101} rows) and MTFCC G2102 (off-reservation trust land, GEOID suffix \`T\`, ${censusClassCounts.G2102} rows; examples are Colville 0760T, Spokane 3940T, Umatilla 4405T, and Rohnerville 3220T). The statistical classes (G2130 to G2160: Alaska Native village statistical areas, Oklahoma tribal statistical areas, and similar) stay out while \`boundary_policy.census_statistical_areas\` is false. The same keys are compared to the normalized Census NAME, and a reservation and its trust land share a NAME and a four-digit code (AIANNHCE). A hit sets \`codes.censusAiannhce\` (every matched code, four digits) and \`codes.censusGeoid\` (the single \`R\` GEOID when exactly one exists; with no \`R\`, the single \`T\` GEOID; else null), with one \`name-exact\` row per GEOID (reservation or trust land named in the row notes). A name match is refused when the area's internal point is more than ${CENSUS_GUARD_KM} kilometres from the Nation's headquarters, and the refusal is listed in the packet. G2120 (Hawaiian home lands) and G2170 (joint-use areas) are outside the footprint. Southeast Alaska villages skip this step because Alaska Native village areas are statistical.

■ **Place-Phrase Candidates (review M1).** A Tribe with no exact LAR or Census match is compared by place words: the Federal Register listing (formal name, "previously listed as" text, and any "includes" list) and the Directory names are reduced to lower case without accents, apostrophes, or generic words (Indian, Reservation, Rancheria, Colony, Tribe, Band, Community, the state names, and similar), and each unclaimed land-area name is reduced the same way. Tier one: every place word of the area name appears, in order, in the listing (Hoopa Valley, Yakama, Umatilla, Port Madison, Table Bluff for the Wiyot listing, Smith River for the Tolowa Dee-ni' listing). Tier two: the area name has two or more place words and only its first appears in the listing (Manchester for Manchester-Point Arena). A candidate is accepted only when the area lies within ${CANDIDATE_KM.tier1} kilometres (tier one) or ${CANDIDATE_KM.tier2} kilometres (tier two) of the headquarters, measured to the polygon for LAR and to the internal point for Census, or the area is named in the entry's own "includes" list (the six Pit River rancherias), and only when exactly one Nation claims the area. Accepted matches are \`name-reviewed\` with \`reviewed: false\`; a headquarters distance corroborates a candidate and never decides it. The Columbia River land areas that the review identified as held for several Tribes (LAR0055 Celilo, LAR0089 The Dalles Unit, and Census 0560T Celilo) are never assigned by name.

## British Columbia Matches

■ **ISC First Nation locations (\`isc-first-nations\`).** The originating record: BAND_NUMBER, BAND_NAME, LONGITUDE, LATITUDE. The id is \`ca-fn-<BAND_NUMBER>\` by construction. The CSV and the GeoPackage both export non-ASCII letters as \`?\`, so BAND_NAME is kept verbatim, the record is flagged when it carries \`?\` or U+FFFD, and a search alias with the question marks removed is added when that alias differs from the normalized name (${qnames.filter((r) => r.aliases.length).length} of the ${qnames.length} names with a question mark received one; for the others the normalized alias equals the normalized name, so none is added and search is unaffected).

■ **British Columbia membership.** ${out.records.filter((r) => r.country === 'CA').length} of ${sc.iscLocationRows} ISC rows. A band is in when its location is inside the Natural Earth British Columbia outline or within ${BC_TOLERANCE_KM} kilometres of it (the outline is coarse at inlets and along the Alaska line), or when at least one of its reserves is a polygon in the NRCan British Columbia layer. Liard First Nation passes only the reserve test and is excluded in \`scope.yaml\` for the maintainer's ruling.

■ **ISC reserve relation to NRCan (\`nrcan-aboriginal-lands-bc\`).** The relation's ADMIN_LAND_ID (five digits) equals the NRCan ALCODE exactly (\`code\`). Of ${report.bc.nrcanPolygons} NRCan polygons, ${report.bc.nrcanJoined} reach a British Columbia First Nation; ${report.bc.relationRowsWithoutPolygon} relation rows point at reserves outside the British Columbia layer and are ignored. No name fallback was needed, so there is no \`name-reviewed\` row.

■ **ISC tribal council relation.** BAND_NUMBER to TRIBAL_COUNCIL_NAME; several councils are joined with a semicolon. The council name is a non-person field.

## From Identifiers to Polygons

\`40-boundaries.mjs\` reads these crosswalk rows and draws, for each Nation, BIA LAR polygons first; Census legal areas only for a Nation with no LAR identifier; and NRCan reserves for British Columbia by ALCODE. A shared British Columbia reserve is drawn once for each band that holds it. No match is changed by the drawing step, and a feature whose crosswalk row is not a \`code\` or \`name-exact\` match carries the draft status of its row. The packet lists every U.S. Tribe that still has no LAR or Census identifier; those have no land-area record of that name in the pinned files and stay point-only.
`;
  writeFileSync(path.join(dir, 'L5-crosswalk.md'), cross);
}

export async function main(argv = process.argv.slice(2)) {
  const packet = argv.includes('--packet') ? argv[argv.indexOf('--packet') + 1] : undefined;
  if (packet) {
    const rawDirs = argv.flatMap((a, i) => (a === '--raw' ? [argv[i + 1] ?? ''] : []));
    if (!rawDirs.length) throw new Error('--packet needs --raw <folder>');
    const out = buildDraft(resolveInputs(rawDirs), loadConfig('1970-01-01'));
    writePacket(packet, out, exists('data/registry/boundaries-build.json') && exists('data/registry/joins-build.json')
      ? { boundaries: readJson('data/registry/boundaries-build.json'), joins: readJson('data/registry/joins-build.json') } : null);
    console.log(`90-validate: wrote L5-review-packet.md and L5-crosswalk.md to ${packet}`);
  }
  const f = await validate(argv);
  const summary = ['# Reference Summary: Nation Registry (Lane L5)', '', ...f.notes.map((n) => `- ${n}`), '', ...f.warnings.map((w) => `- warning: ${w}`), '', ...f.problems.map((p) => `- PROBLEM: ${p}`), ''].join('\n');
  mkdirSync(path.join(ROOT, 'reports'), { recursive: true });
  writeFileSync(path.join(ROOT, 'reports', 'reference-summary.md'), summary);
  for (const n of f.notes) console.log(`90-validate ok: ${n}`);
  for (const w of f.warnings) console.log(`90-validate warning: ${w}`);
  for (const p of f.problems) console.error(`90-validate: ${p}`);
  if (f.problems.length) { console.error(`90-validate failed: ${f.problems.length} problem(s)`); process.exitCode = 1; }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
