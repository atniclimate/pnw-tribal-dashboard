// @ts-check
/**
 * Reference builder 90: registry validation gates, review packet, and crosswalk notes (blueprint 6.2, 6.6, and
 * 12.3, lane L5, wave 1 part). Other lanes extend this file with their own gates in wave 2.
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
 * joined to a First Nation; every record `draft` until the maintainer approves the packet; wave 2 joins pending.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import tzlookup from '@photostructure/tz-lookup';
import { ROOT } from '../check/lib/pages.mjs';
import { loadAjv, parseDataFile, personKeyHits } from '../check/lib/data-files.mjs';
import { BC_TOLERANCE_KM, CA_COUNTIES, AK_SE_BOROUGHS, CENSUS_GUARD_KM, REGISTRY_DIR, buildDraft, loadConfig, resolveInputs, stable, tzConsistent } from './50-registry.mjs';
import { PENDING_JOINS, compact, project } from './70-joins.mjs';

/** Expected Nation counts (blueprint 6.2; adjustable by a reviewed pull request). */
export const COUNT_GATES = Object.freeze({
  usOutsideAlaska: Object.freeze({ min: 120, max: 170 }),
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
 *   bc?: { nrcanPolygons: number, nrcanJoined: number } | null, ratified: boolean, files?: string[] }} c
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
    if (r.review?.status !== 'draft') f.warnings.push(`${r.id}: review.status is ${r.review?.status}; wave 1 leaves every record draft until the maintainer approves the packet`);
    if (/[?�]/.test(r.name)) {
      if (r.review?.status !== 'draft') f.problems.push(`${r.id}: name "${r.name}" carries ? or U+FFFD and cannot be reviewed`);
      else if (!r.flags.includes('name-orthography-needs-nation-source')) f.problems.push(`${r.id}: name carries ? or U+FFFD without the name-orthography-needs-nation-source flag`);
    }
    for (const a of r.aliases) if (a.toLowerCase() === String(r.name).toLowerCase()) f.problems.push(`${r.id}: alias equals the name`);
    if (!r.nameSource?.url || !r.hq?.sourceId || !r.timeZone) f.problems.push(`${r.id}: missing name source, headquarters provenance, or time zone`);
    if (r.country === 'US' && r.kind === 'first-nation') f.problems.push(`${r.id}: kind first-nation on a U.S. Nation`);
    // Time zone consistent with jurisdiction: an Alaska record in a Pacific zone or a British Columbia record in a United States zone fails.
    if (!tzConsistent(r.jurisdictions, r.timeZone)) f.problems.push(`${r.id}: time zone ${r.timeZone} is not consistent with jurisdiction ${r.jurisdictions?.[0] ?? '(none)'}; correct it in data/registry/overrides.yaml (field timeZone) and keep the tz-needs-confirmation flag until the maintainer ratifies it`);  }
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
  f.warnings.push(`wave 2 joins pending (fields stay null or empty): ${PENDING_JOINS.join(', ')}`);
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
  const g = registryGates({
    records, lock: exists('data/registry/ids.lock.json') ? readJson('data/registry/ids.lock.json') : { entries: [] },
    redirects: exists('data/registry/id-redirects.json') ? readJson('data/registry/id-redirects.json') : { redirects: {} }, previousIds,
    bc: draft?.bc ?? null, ratified: footprint?.ratified === true,
  });
  f.problems.push(...g.problems); f.warnings.push(...g.warnings); f.notes.push(...g.notes);
  if (draft) {
    const same = JSON.stringify(draft.records.map((/** @type {any} */ r) => r.id)) === JSON.stringify(records.map((r) => r.id));
    if (!same) f.problems.push('site/data/registry/nations does not match data/registry/draft-registry.json; run 70-joins');
    else {
      const out = project(draft, readJson('data/registry/id-redirects.json'));
      for (const r of out.records) if (stable(r) !== readFileSync(path.join(ROOT, 'site/data/registry/nations', `${r.id}.json`), 'utf8')) { f.problems.push(`site/data/registry/nations/${r.id}.json differs from the projection of the draft`); break; }
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
 */
export function writePacket(dir, out) {
  mkdirSync(dir, { recursive: true });
  const { records, report } = out;
  const counts = countRegistry(records);
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

  const packet = `# Nation Registry Review Packet, Wave 1 (Draft)

Prepared 10/05/2026 for the maintainer by lane L5. Every record is \`review.status: draft\`. Nothing in this packet is decided: each item below is a request for a ruling, and no record becomes \`reviewed\` until the maintainer approves it. Source files are pinned in \`data/registry/inputs.yaml\` with SHA-256 values; this packet is regenerated by \`node scripts/reference/90-validate.mjs --packet <folder> --raw <folders>\`.

## The Brief

The draft registry holds ${counts.total} Nations: ${counts.us} U.S. Tribes (${counts.usOutsideAlaska} outside Alaska and ${counts.southeastAlaska} in Southeast Alaska) and ${counts.britishColumbia} British Columbia First Nations. U.S. names come from the Federal Register notice of 01/30/2026 (91 FR 4102) and are cross-checked to the BIA Tribal Leaders Directory; British Columbia names are the ISC registered names. Headquarters points come from the Directory (U.S.) and the ISC location file (British Columbia), each with its source record id and retrieval date. The footprint edges are the Q2 proposal and remain unratified. Boundaries, NWS zones, ECCC city pages, radar, and gauges are wave 2 joins and are empty in every record.

Two findings need the maintainer first. The U.S. count outside Alaska (${counts.usOutsideAlaska}) is below the blueprint gate of 120 to 170 because the proposed northern California county list reaches only ${us.filter((r) => r.region === 'ca-n').length} Tribes; see Decision One. ${cap(spell(qnames.length))} British Columbia names carry the ISC \`?\` placeholder and need each Nation's own published spelling; see Names Containing a Question Mark.

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
  ['10', 'Identifier slugs cut at eighty characters (for example Fort McDermitt) and L6 contact ids that differ', 'Id Notes', 'Ids stay as minted; L6 re-keys two contact rows'],
])}

## Counts and Gates

${table(['Gate (blueprint 6.2)', 'Range', 'Actual', 'Result'], [
  ['U.S. Tribes outside Alaska', '120 to 170', String(counts.usOutsideAlaska), counts.usOutsideAlaska >= 120 && counts.usOutsideAlaska <= 170 ? 'met' : 'NOT MET (warning while the footprint is unratified)'],
  ['Southeast Alaska', '15 to 25', String(counts.southeastAlaska), counts.southeastAlaska >= 15 && counts.southeastAlaska <= 25 ? 'met' : 'NOT MET'],
  ['British Columbia First Nations', '195 to 210', String(counts.britishColumbia), counts.britishColumbia >= 195 && counts.britishColumbia <= 210 ? 'met' : 'NOT MET'],
])}

U.S. Nations by state of the headquarters id prefix: ${Object.entries(stateCount).sort().map(([k, v]) => `${k} ${v}`).join(', ')}.

Source count reconciliation:

${table(['Source (file, date)', 'Rows read', 'Registry use'], [
  ['Federal Register notice (91 FR 4102, 01/30/2026)', `${sc.federalRegisterEntries} list entries (${sc.federalRegisterContiguous} contiguous 48 states, ${sc.federalRegisterAlaska} Alaska); the notice summary states 575 entities`, 'Formal U.S. names'],
  ['BIA Tribal Leaders Directory (10/04/2026)', `${sc.tldRows} rows (${sc.tldTribes} Tribes and ${sc.tldRows - sc.tldTribes} affiliates)`, `${us.length} U.S. Nations; affiliates never become Nations`],
  ['BIA Alaska Native Villages', `${sc.anvRows} rows`, 'Cross-check of Southeast Alaska village rows (same OBJECTID and name)'],
  ['BIA LAR', `${sc.larFeatures} features`, 'Identifier crosswalk now; polygons in wave 2'],
  ['Census TIGER 2025 AIANNH', `${sc.censusAiannhRows} rows`, 'Identifier crosswalk now (legal classes G2101 reservations and G2102 off-reservation trust land); polygons in wave 2'],
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

Rule: headquarters inside, or within ${BC_TOLERANCE_KM} kilometres of, the Natural Earth British Columbia outline, or at least one reserve polygon in the NRCan British Columbia layer reached through the ISC reserve relation. ${report.bc.both} Nations satisfy both tests, ${report.bc.hqInBcOnly.length} only the headquarters-inside test, ${report.bc.nearOutline.length} have a headquarters outside the outline but within the tolerance (${report.bc.nearOutline.filter((/** @type {any} */ x) => x.reserves > 0).length} of them also have a reserve polygon and so pass the reserve test; ${report.bc.nearOutline.filter((/** @type {any} */ x) => !x.reserves).length} depend on the tolerance alone), and ${report.bc.reserveOnly.length} have a headquarters outside the tolerance and pass only the reserve test.

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

Every zone comes from \`@photostructure/tz-lookup\` at the headquarters point, except the ${tzOverride.length} draft overrides below (\`overrides.yaml\`, field \`timeZone\`, each with a source and reason, none ratified). Counts: ${Object.entries(tzCount).sort().map(([k, v]) => `${k} ${v}`).join(', ')}.

A validator gate in \`90-validate.mjs\` fails any record whose zone is not consistent with its first jurisdiction (\`TZ_BY_JURISDICTION\` in \`50-registry.mjs\`: for example Southeast Alaska must be an Alaska zone, and British Columbia must be a Canadian zone). The gate found ${spell(tzOverride.length)} border-point lookups that were wrong by jurisdiction (the two Southeast Alaska records were an hour off); they are corrected by draft overrides and stay flagged until the maintainer ratifies them:

${table(['Id', 'Lookup zone', 'Draft override zone'], tzOverride.map((r) => [r.id, tzLookupWrong[r.id] ?? '', r.timeZone]))}

Flagged \`tz-needs-confirmation\` (${tzFlag.length}): Duck Valley and Fort McDermitt (Q15), the five draft corrections above, and every British Columbia Nation in a zone other than \`America/Vancouver\` (local practice in the East Kootenay, Peace, Fort Nelson, and Creston areas differs).

${table(['Id', 'Zone'], tzFlag.map((r) => [r.id, r.timeZone]))}

## Crosswalk Exceptions

${table(['Check', 'Count', 'Detail'], [
  ['U.S. Tribes with a land-area LARtype and no exact LAR name match', String(larUnm.length), larUnm.map((/** @type {any} */ x) => x.name).join('; ') || 'none'],
  ['LAR names claimed by two Nations (ambiguous, skipped)', String(report.us.larAmbiguous.length), report.us.larAmbiguous.map((/** @type {any} */ x) => `${x.name} (${x.keys.join(', ')})`).join('; ') || 'none'],
  ['U.S. Tribes with a land-area LARtype and no Census legal-area name match', String(report.us.censusUnmatched.length), report.us.censusUnmatched.map((/** @type {any} */ x) => x.name).join('; ') || 'none'],
  [`Census areas whose name matched but whose internal point is over ${CENSUS_GUARD_KM} kilometres from the headquarters (not matched)`, String(report.us.censusRejected.length), report.us.censusRejected.map((/** @type {any} */ x) => `${x.name} ${x.geoid} (${x.km} km)`).join('; ') || 'none'],
  ['NRCan polygons not joined to a First Nation', String(report.bc.nrcanUnjoined.length), report.bc.nrcanUnjoined.map((/** @type {any} */ x) => `${x.alcode} ${x.name}`).join('; ') || 'none'],
])}

The method is in \`L5-crosswalk.md\`. No match is marked reviewed; wave 2 resolves the unmatched rows with the polygons in hand.

## Id Notes

■ Ids come only from \`site/static/js/data/ids.js\` through \`assignNationId\` and are frozen in \`data/registry/ids.lock.json\` (${out.lock.entries.length} entries, append-only). U.S. ids use the formal (Federal Register) name, so an id never carries a "previously listed as" or "includes" annotation.

■ The eighty-character slug limit cuts long names at a word boundary (for example \`us-nv-fort-mcdermitt-paiute-and-shoshone-tribes-of-the-fort-mcdermitt-indian\`). Ids are permanent; the maintainer may prefer a shorter slug before the lock is committed, which is cheap now and costly later.

■ Lane L6 contact rows name two ids that differ from the lock: Pit River (\`us-ca-pit-river-tribe-california\` here) and the Yurok component (\`us-ca-puliklatribe-of-yurok-people\` here). L6 minted from the Directory name with its annotation; L6 should re-key those rows.

## Wave 2 Work Remaining

■ Boundary polygons from BIA LAR, Census AIANNH (legal classes), and NRCan (BC reserves), with sources, ids, and vintages on every feature, the overview file, and interior \`samples\`.

■ NWS typed zone keys, ECCC city page and forecast zones, radar stations, and nearby gauges (needs L4 and L7 outputs).

■ A check of Tribes whose land lies in the footprint while the office does not.

■ Replace the Natural Earth outline scope aid with the L4 \`emcr-bc-boundaries\` outline once it is pinned.
`;
  writeFileSync(path.join(dir, 'L5-review-packet.md'), packet);

  const byMethod = (/** @type {any[]} */ rows) => {
    /** @type {Record<string, number>} */
    const m = {};
    for (const r of rows) m[`${r.sourceId} / ${r.matchMethod}`] = (m[`${r.sourceId} / ${r.matchMethod}`] ?? 0) + 1;
    return Object.entries(m).sort().map(([k, v]) => [k, String(v)]);
  };
  const cross = `# Nation Registry Crosswalk Notes, Wave 1 (Draft)

Prepared 10/05/2026 by lane L5. This file explains exactly how the BIA, Census, ISC, and NRCan identifiers and names were matched to registry Nations. The rows themselves are \`data/registry/crosswalk-us.json\` and \`data/registry/crosswalk-bc.json\`. Every row has \`reviewed: false\`; no match is a reviewed match until the maintainer approves the packet. Match methods use the schema's words: \`code\` (an identifier equal in both sources), \`name-exact\` (a normalized name equal in both sources), \`name-reviewed\` and \`manual\` (a person decided; none yet).

## The Brief

The registry is built from two directions. U.S. Nations start from the BIA Tribal Leaders Directory (and the Alaska Native Villages layer), take their formal name from the Federal Register notice, and pick up land identifiers from BIA LAR and Census AIANNH by name. British Columbia First Nations start from the ISC location file, take their band number as the id, and reach their reserve polygons by code through the ISC reserve relation to NRCan. Where a join is by name, it is by exact normalized name only, and a name claimed by two Nations is skipped as ambiguous rather than guessed.

## Name Normalization

One function (\`normName\` in \`scripts/reference/50-registry.mjs\`) serves every name comparison: Unicode NFKD, combining marks removed, lower case, \`&\` read as "and", every run of characters outside a to z and zero to nine collapsed to one space, trimmed. It is for matching only and never changes a displayed name.

## Row Counts

${table(['Source and method', 'Rows'], [...byMethod(out.crossUs), ...byMethod(out.crossBc)])}

## U.S. Matches

■ **BIA Tribal Leaders Directory (\`bia-tld\`).** The originating record. Only these fields are read: OBJECTID, tribefullname, tribealternatename, tribalcomponent, biaregion, biaagency, city, state, website, latitude, longitude, LARtype, pointlocation, tribeshortname, and tribalcomponentname. The allowlist is applied as each feature is read; leader names, individual emails, elections, and every other person field never leave the reader. Rows with \`tribalcomponent\` other than Tribe (${sc.tldRows - sc.tldTribes} affiliates) are never Nations. Headquarters points use the \`latitude\` and \`longitude\` attributes, not the Web Mercator geometry. \`pointlocation\` Tribal Office gives \`precision: office\`; City Center gives \`community\`. The id key is \`bia-tld:<tribefullname>\`.

■ **BIA Alaska Native Villages (\`bia-anv\`).** Rows whose Directory \`LARtype\` is Alaska Native Village are matched to the ANV layer by OBJECTID and identical \`tribefullname\` (the two layers share OBJECTIDs). They become \`kind: alaska-native-village\`, their headquarters source is \`bia-anv\`, and their id key is \`bia-anv:<tribefullname>\`. Metlakatla Indian Community, Annette Island Reserve has no ANV row and is a federally recognized Tribe with a land-area record; it keeps the Directory.

■ **Federal Register (\`federal-register-tribes\`).** Each of the ${sc.federalRegisterEntries} \`<FP>\` entries of the pinned notice XML is decoded and whitespace-folded. A Directory \`tribefullname\` matches an entry when the normalized strings are equal (\`name-exact\`); failing that, when it equals the entry or the Directory name with its trailing annotation removed (still \`name-exact\`, with a note naming the annotation). An annotation is a trailing parenthetical that begins "previously listed as", "See", "aka", "includes", or a constituent-count phrase; any other parenthetical (for example "(Klukwan)") is part of the listed name. The formal name is the entry without annotations; former names become search aliases. A Directory row with no match would fall back to the Directory name with \`matchMethod: manual\` and a listing in the packet; none occurred in the footprint.

■ **BIA LAR (\`bia-lar\`).** The LAR layer carries LARID, LARNAME, CLASSIFICATION, and acres, and no Tribe key, so the join is by name. A Nation's keys are its normalized \`tribalcomponentname\`, \`tribeshortname\`, and \`tribealternatename\`; a LAR matches when its normalized LARNAME equals a key. If two Nations in the draft share a key, the LAR is ambiguous and neither gets it (listed in the packet). A hit sets \`codes.biaLarIds\` and one \`name-exact\` row per LARID. Directory rows whose LARtype is Land Area Representation but that have no hit are listed in the packet.

■ **Census AIANNH (\`census-aiannh-2025\`).** Only legal classes are considered, and there are two of them in the pinned 2025 file: MTFCC G2101 (federally recognized reservations, GEOID suffix \`R\`, ${censusClassCounts.G2101} rows) and MTFCC G2102 (off-reservation trust land, GEOID suffix \`T\`, ${censusClassCounts.G2102} rows; examples are Colville 0760T, Spokane 3940T, Umatilla 4405T, and Rohnerville 3220T). The statistical classes (G2120 and higher: Alaska Native village areas, Oklahoma tribal statistical areas, and similar) stay out while \`boundary_policy.census_statistical_areas\` is false. The same keys are compared to the normalized Census NAME, and a reservation and its trust land share a NAME and a four-digit code (AIANNHCE). A hit sets \`codes.censusAiannhce\` (every matched code, four digits) and \`codes.censusGeoid\` (the single \`R\` GEOID when exactly one exists; with no \`R\`, the single \`T\` GEOID; else null), with one \`name-exact\` row per GEOID (reservation or trust land named in the row notes). A name match is refused when the area's internal point is more than ${CENSUS_GUARD_KM} kilometres from the Nation's headquarters, and the refusal is listed in the packet. Southeast Alaska villages skip this step because Alaska Native village areas are statistical.

## British Columbia Matches

■ **ISC First Nation locations (\`isc-first-nations\`).** The originating record: BAND_NUMBER, BAND_NAME, LONGITUDE, LATITUDE. The id is \`ca-fn-<BAND_NUMBER>\` by construction. The CSV and the GeoPackage both export non-ASCII letters as \`?\`, so BAND_NAME is kept verbatim, the record is flagged when it carries \`?\` or U+FFFD, and a search alias with the question marks removed is added when that alias differs from the normalized name (${qnames.filter((r) => r.aliases.length).length} of the ${qnames.length} names with a question mark received one; for the others the normalized alias equals the normalized name, so none is added and search is unaffected).

■ **British Columbia membership.** ${out.records.filter((r) => r.country === 'CA').length} of ${sc.iscLocationRows} ISC rows. A band is in when its location is inside the Natural Earth British Columbia outline or within ${BC_TOLERANCE_KM} kilometres of it (the outline is coarse at inlets and along the Alaska line), or when at least one of its reserves is a polygon in the NRCan British Columbia layer. Liard First Nation passes only the reserve test and is excluded in \`scope.yaml\` for the maintainer's ruling.

■ **ISC reserve relation to NRCan (\`nrcan-aboriginal-lands-bc\`).** The relation's ADMIN_LAND_ID (five digits) equals the NRCan ALCODE exactly (\`code\`). Of ${report.bc.nrcanPolygons} NRCan polygons, ${report.bc.nrcanJoined} reach a British Columbia First Nation; ${report.bc.relationRowsWithoutPolygon} relation rows point at reserves outside the British Columbia layer and are ignored. No name fallback was needed, so there is no \`name-reviewed\` row.

■ **ISC tribal council relation.** BAND_NUMBER to TRIBAL_COUNCIL_NAME; several councils are joined with a semicolon. The council name is a non-person field.

## What Is Not Matched Yet

Boundary polygons are wave 2. The identifiers above are ready for \`40-boundaries.mjs\`, which uses BIA LAR first, Census only where LAR has no polygon, and NRCan for British Columbia reserves. The packet lists every U.S. Tribe that did not reach a LAR or Census identifier by exact name; those need a person or a polygon check, not a fuzzy match.
`;
  writeFileSync(path.join(dir, 'L5-crosswalk.md'), cross);
}

export async function main(argv = process.argv.slice(2)) {
  const packet = argv.includes('--packet') ? argv[argv.indexOf('--packet') + 1] : undefined;
  if (packet) {
    const rawDirs = argv.flatMap((a, i) => (a === '--raw' ? [argv[i + 1] ?? ''] : []));
    if (!rawDirs.length) throw new Error('--packet needs --raw <folder>');
    const out = buildDraft(resolveInputs(rawDirs), loadConfig('1970-01-01'));
    writePacket(packet, out);
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
