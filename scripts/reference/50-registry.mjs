// @ts-check
/**
 * Reference builder 50: the draft Nation registry (blueprint 6.2 and 12.3, lane L5, wave 1).
 *
 *   node scripts/reference/50-registry.mjs --raw <folder> [--raw <folder> ...] [--minted-at YYYY-MM-DD]
 *   node scripts/reference/50-registry.mjs --pin --raw <folder> ...     (re-write the SHA-256 values in data/registry/inputs.yaml)
 *
 * The maintainer review packet and the crosswalk notes are written by `90-validate.mjs --packet <folder>`.
 *
 * Inputs (each verified against the SHA-256 pinned in data/registry/inputs.yaml before any byte is used):
 * BIA Tribal Leaders Directory (allowlisted fields only), BIA Alaska Native Villages, BIA LAR (attributes
 * only), the Federal Register Indian Entities notice, Census TIGER 2025 AIANNH (attributes only), ISC First
 * Nation locations and relation CSVs, NRCan AL_TA BC (attributes only), and two scope aids (Census county
 * cartographic boundaries and Natural Earth admin-1) used only to decide footprint membership.
 *
 * Outputs: data/registry/{ids.lock.json, crosswalk-us.json, crosswalk-bc.json, draft-registry.json}. The ids
 * lock is append-only (ids come only from site/static/js/data/ids.js, assignNationId). Every record is built as
 * `review.status: draft`; the maintainer's approval in data/registry/review.yaml (applyApproval) then marks the
 * approved records `reviewed`. No person field is ever read past the allowlist.
 *
 * Boundaries, NWS zones, ECCC city pages, radar, and gauges are wave 2 joins (they need L4 outputs) and are
 * left null or empty here; scripts/reference/70-joins.mjs projects the draft into site/data/registry.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { inflateRawSync } from 'node:zlib';
import tzlookup from '@photostructure/tz-lookup';
import { load as loadYaml, CORE_SCHEMA } from 'js-yaml';
import { assignNationId, hasNamePlaceholder } from '../../site/static/js/data/ids.js';
import { ROOT } from '../check/lib/pages.mjs';
import { parseCsv } from '../check/lib/data-files.mjs';

export const REGISTRY_DIR = path.join(ROOT, 'data', 'registry');
export const PINS_FILE = path.join(REGISTRY_DIR, 'inputs.yaml');

/** Download dates recorded as `retrievedAt`. The Federal Register notice was fetched the day after the bulk set. */
export const DOWNLOADED = Object.freeze({ bulk: '2026-10-04', federalRegister: '2026-10-05' });

/** Fields the BIA Tribal Leaders Directory may contribute (blueprint 5.2). Nothing else is ever read. */
export const TLD_ALLOW = Object.freeze(['OBJECTID', 'tribefullname', 'tribealternatename', 'tribalcomponent', 'biaregion',
  'biaagency', 'city', 'state', 'website', 'latitude', 'longitude', 'LARtype', 'pointlocation', 'tribeshortname', 'tribalcomponentname']);

export const FR_CITATION = 'Indian Entities Recognized by and Eligible To Receive Services From the United States Bureau of Indian Affairs, 91 FR 4102 (01/30/2026), FR Doc. 2026-01899';
export const FR_URL = 'https://www.federalregister.gov/documents/2026/01/30/2026-01899/indian-entities-recognized-by-and-eligible-to-receive-services-from-the-united-states-bureau-of';
export const SOURCE_URLS = Object.freeze({
  'bia-tld': 'https://services1.arcgis.com/UxqqIfhng71wUT9x/arcgis/rest/services/TribalLeadership_Directory/FeatureServer/0',
  'bia-anv': 'https://services1.arcgis.com/UxqqIfhng71wUT9x/arcgis/rest/services/AlaskaNativeVillages/FeatureServer/0',
  'isc-first-nations': 'https://data.sac-isc.gc.ca/geomatics/rest/directories/arcgisoutput/DonneesOuvertes_OpenData/Premiere_Nation_First_Nation/',
});

/** Footprint edges that are rules, not lists of Nations (footprint.yaml, ratified 10/05/2026). */
export const STATE_RULES = Object.freeze({
  Washington: { all: true, jurisdiction: 'WA', region: 'wa', st: 'wa' },
  Oregon: { all: true, jurisdiction: 'OR', region: 'or', st: 'or' },
  Idaho: { all: true, jurisdiction: 'ID', region: 'id', st: 'id' },
  California: { all: false, jurisdiction: 'CA-N', region: 'ca-n', st: 'ca' },
  Montana: { all: false, jurisdiction: 'MT-W', region: 'mt-w', st: 'mt' },
  Nevada: { all: false, jurisdiction: 'NV-N', region: 'nv-n', st: 'nv' },
  Alaska: { all: false, jurisdiction: 'AK-SE', region: 'ak-se', st: 'ak' },
});
export const CA_COUNTIES = Object.freeze(['Del Norte', 'Humboldt', 'Trinity', 'Mendocino', 'Siskiyou', 'Modoc', 'Shasta', 'Lassen', 'Tehama', 'Plumas', 'Lake']);
export const AK_SE_BOROUGHS = Object.freeze(['Yakutat', 'Hoonah-Angoon', 'Skagway', 'Haines', 'Juneau', 'Sitka', 'Petersburg', 'Wrangell', 'Ketchikan Gateway', 'Prince of Wales-Hyder']);
/** Scope-aid states: Alaska, California, Idaho, Montana, Nevada, Oregon, Washington. */
const STATEFP = ['02', '06', '16', '30', '32', '41', '53'];

/** A First Nation headquarters this close to the Natural Earth British Columbia outline counts as inside it. */
export const BC_TOLERANCE_KM = 10;

/** Time zones whose local practice commonly differs from the provincial or state default (blueprint 3.11). */
const TZ_CONFIRM = new Set(['America/Edmonton', 'America/Creston', 'America/Dawson_Creek', 'America/Fort_Nelson']);

/**
 * IANA zones that are consistent with a Nation's primary (first) jurisdiction. A headquarters point near a border
 * can resolve through `tz-lookup` to the zone across the line (Petersburg and Wrangell, Alaska, resolve to
 * America/Vancouver; Osoyoos, Lower Similkameen, and Pacheedaht, British Columbia, resolve to America/Los_Angeles),
 * so the builder flags such a lookup and the validator fails any record whose final zone is outside this table.
 * Blueprint 3.11 names the expected zones; Idaho, Oregon, and Nevada accept the neighboring zone that part of the
 * state observes.
 */
export const TZ_BY_JURISDICTION = Object.freeze(/** @type {Record<string, readonly string[]>} */ ({
  WA: ['America/Los_Angeles'],
  OR: ['America/Los_Angeles', 'America/Boise'],
  ID: ['America/Boise', 'America/Los_Angeles'],
  'CA-N': ['America/Los_Angeles'],
  'MT-W': ['America/Denver'],
  'NV-N': ['America/Los_Angeles', 'America/Boise', 'America/Denver'],
  'AK-SE': ['America/Sitka', 'America/Juneau', 'America/Yakutat', 'America/Metlakatla', 'America/Anchorage'],
  BC: ['America/Vancouver', 'America/Edmonton', 'America/Creston', 'America/Dawson_Creek', 'America/Fort_Nelson'],
}));

/**
 * True when the zone is allowed for the first jurisdiction (an unknown jurisdiction is not consistent).
 * @param {string[] | undefined} jurisdictions @param {string} tz
 */
export function tzConsistent(jurisdictions, tz) {
  const allowed = TZ_BY_JURISDICTION[jurisdictions?.[0] ?? ''];
  return Boolean(allowed && allowed.includes(tz));
}

/** Census legal land classes: G2101 reservations (type R) and G2102 off-reservation trust land (type T). Statistical areas are G2130 to G2160; G2120 (Hawaiian home lands) and G2170 (joint-use areas) are outside the footprint. */
export const CENSUS_LEGAL_MTFCC = Object.freeze(['G2101', 'G2102']);

/** A Census area whose internal point lies farther than this from a Nation's headquarters is not matched by name alone. */
export const CENSUS_GUARD_KM = 300;

// ---------------------------------------------------------------------------------------------
// Small parsers (pure, exported for tests)
// ---------------------------------------------------------------------------------------------

/**
 * Minimal zip reader (stored and deflated entries); no dependency.
 * @param {Buffer} buf
 * @returns {Map<string, Buffer>}
 */
export function unzip(buf) {
  /** @type {Map<string, Buffer>} */
  const out = new Map();
  let eocd = buf.length - 22;
  while (eocd >= 0 && buf.readUInt32LE(eocd) !== 0x06054b50) eocd -= 1;
  if (eocd < 0) throw new Error('not a zip file');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  for (let i = 0; i < count; i += 1) {
    const method = buf.readUInt16LE(p + 10);
    const size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    const lNameLen = buf.readUInt16LE(local + 26);
    const lExtraLen = buf.readUInt16LE(local + 28);
    const data = buf.subarray(local + 30 + lNameLen + lExtraLen, local + 30 + lNameLen + lExtraLen + size);
    out.set(name, method === 0 ? Buffer.from(data) : inflateRawSync(data));
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

/** @param {string} s */
export function decodeEntities(s) {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}

/** @param {string} s */
const collapse = (s) => s.replace(/\s+/g, ' ').trim();

/**
 * Entries of the Federal Register Indian Entities notice (one `<FP>` element each), in two sections.
 * @param {string} xml
 * @returns {{ section: 'contiguous' | 'alaska', raw: string }[]}
 */
export function parseFederalRegister(xml) {
  const split = xml.search(/Native Entities Within the State of Alaska/);
  /** @type {{ section: 'contiguous' | 'alaska', raw: string }[]} */
  const out = [];
  for (const m of xml.matchAll(/<FP[^>]*>([\s\S]*?)<\/FP>/g)) {
    const raw = collapse(decodeEntities((m[1] ?? '').replace(/<[^>]+>/g, '')));
    if (raw) out.push({ section: (m.index ?? 0) > split && split >= 0 ? 'alaska' : 'contiguous', raw });
  }
  return out;
}

const ANNOTATION = /^(previously listed as|see |aka |includes |four constituent|six component)/i;

/**
 * Split a Federal Register entry into its formal name and annotations. A trailing parenthetical group is an
 * annotation (a former name, a cross reference, or a list of constituent bands) when it begins with
 * "previously listed as", "See", "aka", "includes", or a constituent-count phrase; otherwise it is part of the
 * listed name, as in "Chilkat Indian Village (Klukwan)" and "Wampanoag Tribe of Gay Head (Aquinnah)".
 * @param {string} raw
 * @returns {{ name: string, annotations: string[], former: string[] }}
 */
export function splitFrEntry(raw) {
  let name = raw;
  /** @type {string[]} */
  const annotations = [];
  /** @type {string[]} */
  const former = [];
  for (;;) {
    const m = /^(.*?)\s*\(([^()]*(?:\([^()]*\)[^()]*)*)\)\s*$/.exec(name);
    if (!m || !ANNOTATION.test((m[2] ?? '').trim())) break;
    annotations.unshift(collapse(m[2] ?? ''));
    const prev = /^previously listed as (.*)$/i.exec((m[2] ?? '').trim());
    if (prev) former.push(collapse((prev[1] ?? '').replace(/\)\s*$/, '')));
    name = (m[1] ?? '').trim();
  }
  return { name, annotations, former };
}

/** @param {unknown} s */
export const normName = (s) => String(s ?? '').normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim();

/** @param {number} x */
export const r5 = (x) => Math.round(x * 1e5) / 1e5;

/**
 * Words that carry no place identity in a land-area or Tribe name. They are removed before the place phrases of a
 * Federal Register listing and a land-area name are compared (review M1).
 */
const GENERIC_WORDS = new Set(['indian', 'indians', 'reservation', 'rancheria', 'rancherias', 'colony', 'reserve', 'community', 'tribe', 'tribes', 'tribal',
  'band', 'bands', 'nation', 'of', 'the', 'and', 'in', 'village', 'california', 'oregon', 'washington', 'idaho', 'montana', 'nevada', 'alaska', 'confederated',
  'pomo', 'unit', 'ranch', 'or', 'for', 'a']);

/**
 * Place tokens of a name: lower case, accents and apostrophes removed, generic words dropped.
 * @param {unknown} s
 * @returns {string[]}
 */
export function placeTokens(s) {
  return String(s ?? '').normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/['’‘`]/g, '').replace(/&/g, ' and ')
    .split(/[^a-z0-9]+/).filter((t) => t && !GENERIC_WORDS.has(t));
}

/** @param {string[]} hay @param {string[]} needle */
function containsRun(hay, needle) {
  if (!needle.length) return false;
  for (let i = 0; i + needle.length <= hay.length; i += 1) if (needle.every((t, k) => hay[i + k] === t)) return true;
  return false;
}

/**
 * How a land-area name relates to the place words of a Tribe's listing.
 * Tier 1: every place word of the area appears, in order, as one run in the listing. Tier 2: the area name has two
 * or more place words and only its first appears in the listing. Anything else is no candidate (0).
 * @param {string[]} listingTokens @param {unknown} areaName
 * @returns {0 | 1 | 2}
 */
export function areaCandidateTier(listingTokens, areaName) {
  const core = placeTokens(areaName);
  if (!core.length) return 0;
  if (containsRun(listingTokens, core)) return 1;
  if (core.length >= 2 && listingTokens.includes(/** @type {string} */ (core[0]))) return 2;
  return 0;
}

/**
 * Land areas held for more than one Tribe. A name match never assigns them to one Nation (review N3): the Celilo and
 * The Dalles Unit land-area records of BIA LAR and the Celilo trust land of the Census file. The build cannot say
 * which Nations they serve, so they stay unassigned until the maintainer rules.
 */
export const SHARED_AREAS = Object.freeze({
  lar: Object.freeze({ LAR0055: 'Celilo', LAR0089: 'The Dalles Unit' }),
  censusNames: Object.freeze(['celilo']),
});

/**
 * The shared LAR set used at every stage (review R2): the named list united with every feature that the pinned LAR file
 * itself classifies as other than "1" (CLASSIFICATION "3" marks the areas held for several Tribes; LAR0055 and LAR0089
 * were the only two of 335 at the 2026 pin). A refresh that adds a new shared area is caught by the classification, and
 * an alias added to a Directory name can no longer assign one by exact name.
 * @param {Record<string, any>[]} lar features' properties (LARID, LARNAME, CLASSIFICATION)
 * @returns {Map<string, string>} LARID to its name
 */
export function sharedLarAreas(lar) {
  /** @type {Map<string, string>} */
  const out = new Map(Object.entries(SHARED_AREAS.lar));
  for (const l of lar) {
    const c = l.CLASSIFICATION;
    if (c !== undefined && c !== null && String(c) !== '1' && !out.has(String(l.LARID))) out.set(String(l.LARID), String(l.LARNAME));
  }
  return out;
}

/** Whether a Census legal area is one of the shared areas, by its normalized name. @param {unknown} name */
export const isSharedCensusName = (name) => SHARED_AREAS.censusNames.includes(normName(name));

/**
 * Exact-name LAR stage (pure): LAR ids whose normalized LARNAME equals one of a Tribe's Directory names, when exactly one
 * Tribe holds that name and the area is not shared.
 * @param {string[]} keys normalized Directory names of one Tribe
 * @param {Map<string, { LARID: unknown }>} larBy normalized LARNAME to feature
 * @param {Map<string, Set<string>>} keyOwners normalized name to the Tribes that hold it
 * @param {Map<string, string>} sharedLar from sharedLarAreas
 * @returns {string[]}
 */
export function exactLarIds(keys, larBy, keyOwners, sharedLar) {
  const hit = keys.filter((k) => larBy.has(k) && keyOwners.get(k)?.size === 1 && !sharedLar.has(String(larBy.get(k)?.LARID)));
  return [...new Set(hit.map((k) => String(larBy.get(k)?.LARID)))].sort();
}

/**
 * Exact-name Census stage (pure): legal areas whose normalized NAME equals one of a Tribe's Directory names, shared areas
 * excluded, one row per GEOID.
 * @template {{ geoid: string, name: string }} T
 * @param {string[]} keys @param {Map<string, T[]>} censusBy
 * @returns {T[]}
 */
export function exactCensusRows(keys, censusBy) {
  const rows = keys.flatMap((k) => censusBy.get(k) ?? []);
  return rows.filter((a, i) => !isSharedCensusName(a.name) && rows.findIndex((b) => b.geoid === a.geoid) === i);
}

/**
 * Largest distance, in kilometres, from a headquarters to a land area for a tier one and tier two candidate. Tier one is
 * wide because a Census internal point of a scattered area (Coos, Lower Umpqua, and Siuslaw is 112 km from the office) or
 * an office in another county (Elem, 62 km) is far from the headquarters; the full place phrase must still appear in the listing.
 */
export const CANDIDATE_KM = Object.freeze({ tier1: 120, tier2: 15 });

/** @param {number[]} pt @param {number[][]} ring */
function inRing(pt, ring) {
  let c = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = /** @type {number[]} */ (ring[i]);
    const b = /** @type {number[]} */ (ring[j]);
    if ((a[1] ?? 0) > (pt[1] ?? 0) !== (b[1] ?? 0) > (pt[1] ?? 0) && (pt[0] ?? 0) < (((b[0] ?? 0) - (a[0] ?? 0)) * ((pt[1] ?? 0) - (a[1] ?? 0))) / ((b[1] ?? 0) - (a[1] ?? 0)) + (a[0] ?? 0)) c = !c;
  }
  return c;
}

/**
 * Point in Polygon or MultiPolygon geometry (holes honored).
 * @param {number} lon @param {number} lat @param {any} geom
 */
export function pointInGeometry(lon, lat, geom) {
  const polys = geom.type === 'Polygon' ? [geom.coordinates] : geom.coordinates;
  return polys.some((/** @type {number[][][]} */ p) => inRing([lon, lat], /** @type {number[][]} */ (p[0])) && !p.slice(1).some((h) => inRing([lon, lat], h)));
}

/** @param {number} lat @param {number} lon @param {number} lat2 @param {number} lon2 */
export function haversineKm(lat, lon, lat2, lon2) {
  const rad = Math.PI / 180;
  const a = Math.sin(((lat2 - lat) * rad) / 2) ** 2 + Math.cos(lat * rad) * Math.cos(lat2 * rad) * Math.sin(((lon2 - lon) * rad) / 2) ** 2;
  return 2 * 6371.0088 * Math.asin(Math.sqrt(a));
}

/**
 * Approximate distance in kilometres from a point to the outline of a Polygon or MultiPolygon (planar, equirectangular
 * at the point's latitude; adequate for a tolerance of a few kilometres).
 * @param {number} lon @param {number} lat @param {any} geom
 */
export function distanceToOutlineKm(lon, lat, geom) {
  const kx = 111.32 * Math.cos((lat * Math.PI) / 180);
  const ky = 110.57;
  const polys = geom.type === 'Polygon' ? [geom.coordinates] : geom.coordinates;
  let best = Infinity;
  for (const p of polys) {
    for (const ring of p) {
      for (let i = 1; i < ring.length; i += 1) {
        const ax = (ring[i - 1][0] - lon) * kx, ay = (ring[i - 1][1] - lat) * ky;
        const bx = (ring[i][0] - lon) * kx, by = (ring[i][1] - lat) * ky;
        const dx = bx - ax, dy = by - ay;
        const len2 = dx * dx + dy * dy;
        const u = len2 === 0 ? 0 : Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2));
        best = Math.min(best, Math.hypot(ax + u * dx, ay + u * dy));
      }
    }
  }
  return best;
}

/** @param {string} s */
const sha256 = (s) => createHash('sha256').update(s).digest('hex');
/** @param {Buffer} b */
const sha256Buf = (b) => createHash('sha256').update(b).digest('hex');

// ---------------------------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------------------------

/**
 * Pinned inputs as listed in data/registry/inputs.yaml, resolved against one or more raw folders.
 * @param {string[]} rawDirs
 * @param {{ verify?: boolean, only?: string[] }} [opts] `only` limits the call to those input ids (the boundary builder needs three)
 */
export function resolveInputs(rawDirs, opts = {}) {
  /** @type {{ inputs: any[] }} */
  const pins = /** @type {any} */ (loadYaml(readFileSync(PINS_FILE, 'utf8'), { schema: CORE_SCHEMA }));
  /** @type {Record<string, { pin: any, path: string }>} */
  const byId = {};
  for (const pin of pins.inputs) {
    if (opts.only && !opts.only.includes(pin.id)) continue;
    const found = rawDirs.map((d) => path.join(d, pin.file)).find((p) => existsSync(p));
    if (!found) throw new Error(`pinned input ${pin.id} (${pin.file}) not found in ${rawDirs.join(', ')}`);
    if (opts.verify !== false) {
      const got = sha256Buf(readFileSync(found));
      if (got !== pin.sha256) throw new Error(`input ${pin.id}: SHA-256 ${got} does not match the pin ${pin.sha256}`);
    }
    byId[pin.id] = { pin, path: found };
  }
  return byId;
}

/** @param {Record<string, { pin: any, path: string }>} inputs @param {string} id */
const bytes = (inputs, id) => readFileSync(/** @type {{ path: string }} */ (inputs[id]).path);

/** First member of a zip whose name matches. @param {Buffer} zip @param {RegExp} re */
function zipMember(zip, re) {
  for (const [name, data] of unzip(zip)) if (re.test(name)) return data;
  throw new Error(`no zip member matches ${re}`);
}

/** @param {Buffer} data */
const csvRows = (data) => parseCsv(data.toString('utf8').replace(/^\uFEFF/, ''));

/**
 * Run mapshaper on one input and return the parsed GeoJSON (temp files are removed).
 * @param {Buffer} zip @param {string[]} args mapshaper arguments after the input name
 * @param {string} shpPattern
 */
function mapshaperGeojson(zip, shpPattern, args) {
  const tmp = mkdtempSync(path.join(tmpdir(), 'cthd-reg-'));
  try {
    let shp = '';
    for (const [name, data] of unzip(zip)) {
      writeFileSync(path.join(tmp, path.basename(name)), data);
      if (new RegExp(shpPattern).test(name)) shp = path.join(tmp, path.basename(name));
    }
    const out = path.join(tmp, 'out.json');
    execFileSync(process.execPath, [path.join(ROOT, 'node_modules', 'mapshaper', 'bin', 'mapshaper'), '-i', shp, ...args, '-o', out, 'format=geojson', 'precision=0.00001'], { stdio: 'pipe' });
    return JSON.parse(readFileSync(out, 'utf8'));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/** Attribute table of a zipped shapefile (geometry dropped) as CSV rows. @param {Buffer} zip @param {string} shpPattern */
function shapefileAttributes(zip, shpPattern) {
  const tmp = mkdtempSync(path.join(tmpdir(), 'cthd-reg-'));
  try {
    let shp = '';
    for (const [name, data] of unzip(zip)) {
      writeFileSync(path.join(tmp, path.basename(name)), data);
      if (new RegExp(shpPattern).test(name)) shp = path.join(tmp, path.basename(name));
    }
    const out = path.join(tmp, 'attr.csv');
    execFileSync(process.execPath, [path.join(ROOT, 'node_modules', 'mapshaper', 'bin', 'mapshaper'), '-i', shp, '-drop', 'geometry', '-o', out], { stdio: 'pipe' });
    return parseCsv(readFileSync(out, 'utf8'));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------------------------
// The maintainer's approval (data/registry/review.yaml)
// ---------------------------------------------------------------------------------------------

/**
 * @typedef {{ approvedOn: string, approver: string, decision: string, holds?: { nationId: string, reason: string }[] }} Approval
 */

/** Crosswalk methods an approval marks reviewed; `name-reviewed` candidates and `manual` rows are confirmed one by one. */
export const APPROVED_MATCH_METHODS = Object.freeze(['code', 'name-exact']);

/**
 * Check the shape of review.yaml (it has no catalog schema; a malformed approval must never mark a record reviewed).
 * @param {unknown} v
 * @returns {Approval | null}
 */
export function readApproval(v) {
  if (v === null || v === undefined) return null;
  const a = /** @type {any} */ (v);
  const iso = /^\d{4}-\d{2}-\d{2}$/;
  if (typeof a !== 'object' || !iso.test(String(a.approvedOn ?? '')) || !a.approver || !a.decision) throw new Error('data/registry/review.yaml needs approvedOn (YYYY-MM-DD), approver, and decision');
  for (const h of a.holds ?? []) if (!h?.nationId || !h?.reason) throw new Error('data/registry/review.yaml: every hold needs nationId and reason');
  const extra = Object.keys(a).filter((k) => !['approvedOn', 'approver', 'decision', 'holds'].includes(k));
  if (extra.length) throw new Error(`data/registry/review.yaml: unknown keys ${extra.join(', ')}`);
  return a;
}

/**
 * Apply the maintainer's approval in place (pure over its arguments). A record becomes `reviewed` only when its id was
 * minted on or before the approval date, it is not held, and it carries no flag; its headquarters becomes reviewed and
 * its `code` and `name-exact` crosswalk rows become reviewed. Every other record stays draft, with the reason in its notes.
 * @param {Rec[]} records
 * @param {any[]} crossRows the U.S. and British Columbia crosswalk rows
 * @param {{ entries: { id: string, mintedAt: string }[] }} lock
 * @param {Approval | null} approval
 * @returns {{ reviewed: number, draft: number, held: string[], flagged: string[], newer: string[] }}
 */
export function applyApproval(records, crossRows, lock, approval) {
  const out = { reviewed: 0, draft: records.length, held: /** @type {string[]} */ ([]), flagged: /** @type {string[]} */ ([]), newer: /** @type {string[]} */ ([]) };
  if (!approval) return out;
  const minted = new Map(lock.entries.map((e) => [e.id, e.mintedAt]));
  const holds = new Map((approval.holds ?? []).map((h) => [h.nationId, h.reason]));
  const ref = `${approval.decision}; approver: ${approval.approver}`;
  const date = approval.approvedOn.split('-');
  const us = `${date[1]}/${date[2]}/${date[0]}`;
  /** @type {Set<string>} */
  const approved = new Set();
  for (const r of records) {
    const basis = String(r.review.notes).replace(/^Draft built by scripts\/reference\/50-registry\.mjs\. /, '');
    const at = minted.get(r.id);
    if (holds.has(r.id)) {
      out.held.push(r.id);
      r.review.notes = `Held as draft by the approval of ${us} (${ref}): ${holds.get(r.id)} ${basis}`;
    } else if (r.flags.length) {
      out.flagged.push(r.id);
      r.review.notes = `Not covered by the approval of ${us} (${ref}): the record carries ${r.flags.join(', ')}. ${basis}`;
    } else if (!at || at > approval.approvedOn) {
      out.newer.push(r.id);
      r.review.notes = `Not covered by the approval of ${us} (${ref}): the id was minted after it. ${basis}`;
    } else {
      r.review = { status: 'reviewed', reviewedAt: approval.approvedOn, notes: `Approved with amendments ${us} (${ref}). ${basis}` };
      r.hq.reviewed = true;
      approved.add(r.id);
    }
  }
  for (const row of crossRows) if (approved.has(row.nationId) && APPROVED_MATCH_METHODS.includes(row.matchMethod)) row.reviewed = true;
  out.reviewed = approved.size;
  out.draft = records.length - approved.size;
  return out;
}

// ---------------------------------------------------------------------------------------------
// The build
// ---------------------------------------------------------------------------------------------

/** @typedef {Record<string, any>} Rec */

/**
 * @param {Record<string, { pin: any, path: string }>} inputs
 * @param {{ lock: any, scope: { include: any[], exclude: any[] }, overrides: any[], names: any[], mintedAt: string, review?: Approval | null }} cfg
 */
export function buildDraft(inputs, cfg) {
  // ---- BIA Tribal Leaders Directory: allowlist applied the moment a feature is read ----
  /** @type {Rec[]} */
  const tld = JSON.parse(bytes(inputs, 'bia-tld').toString('utf8')).features.map((/** @type {any} */ f) =>
    Object.fromEntries(TLD_ALLOW.filter((k) => k in f.properties).map((k) => [k, f.properties[k]])));
  /** @type {Rec[]} */
  const anv = JSON.parse(bytes(inputs, 'bia-anv').toString('utf8')).features.map((/** @type {any} */ f) =>
    Object.fromEntries(TLD_ALLOW.filter((k) => k in f.properties).map((k) => [k, f.properties[k]])));
  const anvByObjectId = new Map(anv.map((r) => [r.OBJECTID, r]));
  /** @type {Rec[]} */
  const lar = JSON.parse(bytes(inputs, 'bia-lar').toString('utf8')).features.map((/** @type {any} */ f) => ({
    LARID: f.properties.LARID, LARNAME: f.properties.LARNAME, CLASSIFICATION: f.properties.CLASSIFICATION, geometry: f.geometry }));
  const census = shapefileAttributes(bytes(inputs, 'census-aiannh-2025'), 'aiannh\\.shp$')
    .map((r) => ({ ce: r.AIANNHCE ?? '', geoid: r.GEOID ?? '', name: r.NAME ?? '', lsad: r.LSAD ?? '', mtfcc: r.MTFCC ?? '', classfp: r.CLASSFP ?? '', comptyp: r.COMPTYP ?? '',
      lat: Number(r.INTPTLAT), lon: Number(r.INTPTLON) }));
  const frEntries = parseFederalRegister(bytes(inputs, 'federal-register-tribes').toString('utf8')).map((e) => ({ ...e, ...splitFrEntry(e.raw) }));
  const frByRaw = new Map(frEntries.map((e) => [normName(e.raw), e]));
  const frByName = new Map(frEntries.map((e) => [normName(e.name), e]));

  // ---- scope aids ----
  const counties = mapshaperGeojson(bytes(inputs, 'census-counties-500k'), 'cb_2024_us_county_500k\\.shp$', ['-filter', `${JSON.stringify(STATEFP)}.includes(STATEFP)`]);
  const bcPoly = mapshaperGeojson(bytes(inputs, 'natural-earth-admin1'), 'ne_10m_admin_1_states_provinces\\.shp$', ['-filter', "iso_3166_2=='CA-BC'"]).features[0].geometry;
  /** @param {number} lon @param {number} lat */
  const countyAt = (lon, lat) => counties.features.find((/** @type {any} */ f) => pointInGeometry(lon, lat, f.geometry))?.properties;

  const includeKeys = new Map(cfg.scope.include.map((e) => [e.key, e]));
  const excludeKeys = new Map(cfg.scope.exclude.map((e) => [e.key, e]));
  /** @param {string} id @param {string} field */
  const override = (id, field) => cfg.overrides.filter((o) => o.nationId === id && o.field === field).at(-1);

  /** @type {any} */
  let lock = cfg.lock;
  /** @type {Rec[]} */
  const records = [];
  /** @type {any[]} */
  const crossUs = [];
  /** @type {any[]} */
  const decisions = [];
  /** @type {Record<string, any>} */
  const report = { us: { include: [], exclude: [], affiliates: [], frMismatch: [], caOutside: [], akOutside: [] }, bc: {} };

  // ---- U.S. ----
  const larKeyOwners = new Map();
  /** @type {any[]} */
  const usCandidates = [];
  for (const row of tld) {
    const name = String(row.tribefullname ?? '').trim();
    const state = row.state ?? null;
    const rule = state ? /** @type {any} */ (STATE_RULES)[state] : undefined;
    const isAnv = row.LARtype === 'Alaska Native Village';
    const key = `${isAnv ? 'bia-anv' : 'bia-tld'}:${name}`;
    const tldKey = `bia-tld:${name}`;
    const lon = Number(row.longitude);
    const lat = Number(row.latitude);
    if (row.tribalcomponent !== 'Tribe') {
      if (rule && rule.all) report.us.affiliates.push({ objectId: row.OBJECTID, name, state });
      continue;
    }
    if (!rule) continue;
    let basis = '';
    let county = '';
    if (excludeKeys.has(tldKey)) { report.us.exclude.push({ objectId: row.OBJECTID, name, state, reason: excludeKeys.get(tldKey).reason }); continue; }
    if (rule.all) basis = `state ${state} (whole state is in the footprint)`;
    else if (includeKeys.has(tldKey)) basis = `scope.yaml include: ${includeKeys.get(tldKey).reason}`;
    else if (state === 'California' || state === 'Alaska') {
      const c = countyAt(lon, lat);
      county = c ? `${c.NAMELSAD} (${c.STUSPS})` : '';
      const list = state === 'California' ? CA_COUNTIES : AK_SE_BOROUGHS;
      if (c && list.includes(c.NAME)) basis = `${state === 'California' ? 'county' : 'borough or census area'} ${c.NAMELSAD} (footprint.yaml, ratified 10/05/2026)`;
      else report.us[state === 'California' ? 'caOutside' : 'akOutside'].push({ objectId: row.OBJECTID, name, county, city: row.city ?? '' });
    }
    if (!basis) continue;
    usCandidates.push({ row, name, key, tldKey, isAnv, rule, basis, county, lat, lon });
  }
  usCandidates.sort((a, b) => a.key.localeCompare(b.key, 'en'));

  for (const c of usCandidates) {
    const { row, name: tldName, isAnv, rule } = c;
    // Names: the Federal Register list is the formal-name source; TLD tribefullname is cross-checked to it.
    let fr = frByRaw.get(normName(tldName));
    let matchNote = '';
    let frMethod = 'name-exact';
    if (!fr) {
      const stripped = splitFrEntry(tldName).name;
      fr = frByName.get(normName(tldName)) ?? frByName.get(normName(stripped));
      if (fr) matchNote = `Directory name "${tldName}" matches the Federal Register listing "${fr.raw}" after removing a parenthetical annotation.`;
    }
    const formal = fr ? fr.name : tldName;
    if (!fr) {
      report.us.frMismatch.push({ objectId: row.OBJECTID, name: tldName });
      frMethod = 'manual';
    }
    const assigned = assignNationId(lock, { key: c.key, name: formal, country: 'US', state: rule.st }, cfg.mintedAt);
    lock = assigned.lock;
    const id = assigned.id;
    const names = cfg.names.find((n) => n.nationId === id);
    const hqOv = override(id, 'hq');
    const hq = {
      lat: hqOv ? hqOv.value.lat : r5(c.lat), lon: hqOv ? hqOv.value.lon : r5(c.lon),
      precision: row.pointlocation === 'Tribal Office' ? 'office' : 'community',
      sourceId: isAnv ? 'bia-anv' : 'bia-tld', sourceRecordId: String(row.OBJECTID), retrievedAt: DOWNLOADED.bulk, reviewed: false,
    };
    const jOv = override(id, 'jurisdictions');
    const regionOv = override(id, 'region');
    const tzOv = override(id, 'timeZone');
    const lookupTz = tzlookup(hq.lat, hq.lon);
    const tz = tzOv ? tzOv.value : lookupTz;
    const jurisdictions = jOv ? jOv.value : [rule.jurisdiction];
    /** @type {string[]} */
    const flags = [];
    // Without a timeZone override, Duck Valley and Fort McDermitt (Q15) and any lookup that disagrees with the jurisdiction
    // (a border-point lookup) are flagged. An override in overrides.yaml is a ratified zone (packet amendments 10/05/2026, A.3),
    // so it clears the flag.
    if (!tzOv && (id.includes('duck-valley') || id.includes('fort-mcdermitt') || !tzConsistent(jurisdictions, lookupTz))) flags.push('tz-needs-confirmation');
    const aliasSet = new Map();
    for (const a of [row.tribealternatename, row.tribeshortname, row.tribalcomponentname, ...(fr ? fr.former : []), ...(c.isAnv ? [] : [])]) {
      const v = a ? collapse(String(a)) : '';
      if (v && normName(v) !== normName(formal) && !aliasSet.has(normName(v))) aliasSet.set(normName(v), v);
    }
    for (const a of override(id, 'aliases')?.value ?? []) if (!aliasSet.has(normName(a))) aliasSet.set(normName(a), a);
    // A names.yaml correction keeps the registered (Federal Register) form as a search alias (for example "PuliklaTribe").
    if (names && normName(formal) !== normName(names.name) && !aliasSet.has(normName(formal))) aliasSet.set(normName(formal), formal);
    const anvRow = anvByObjectId.get(row.OBJECTID);
    const rec = {
      id, castId: null, name: names ? names.name : formal,
      nameSource: names
        ? { kind: 'names-override', citation: `data/registry/names.yaml: ${names.notes ?? 'the Nation\'s own published name'}`, url: names.sourceUrl, retrievedAt: names.verifiedAt }
        : fr
          ? { kind: 'federal-register', citation: `${FR_CITATION}; entry "${fr.raw}"`, url: FR_URL, retrievedAt: DOWNLOADED.federalRegister }
          : { kind: isAnv ? 'bia-anv' : 'bia-tld', citation: `${isAnv ? 'BIA Alaska Native Villages' : 'BIA Tribal Leaders Directory'}, tribefullname, OBJECTID ${row.OBJECTID} (no Federal Register match)`, url: SOURCE_URLS[isAnv ? 'bia-anv' : 'bia-tld'], retrievedAt: DOWNLOADED.bulk },
      preferredName: names?.preferredName ?? null,
      preferredNameSource: names?.preferredName ? { url: names.sourceUrl, verifiedAt: names.verifiedAt } : null,
      aliases: [...aliasSet.values()].sort((a, b) => a.localeCompare(b, 'en')),
      kind: isAnv ? 'alaska-native-village' : 'us-federally-recognized-tribe',
      country: 'US', jurisdictions, region: regionOv ? regionOv.value : rule.region,
      hq, samples: [[hq.lat, hq.lon]], bbox: [0, 0, 0, 0],
      boundary: { status: 'point-only', detailRef: null, parts: [] },
      timeZone: tz, timeZoneSource: tzOv ? 'override' : 'tz-lookup', units: 'us',
      nws: null, eccc: null, radar: { nexrad: null, ridgeLoop: null, eccc: null }, gauges: [], contactIds: [], website: null, isc: null,
      codes: { biaLarIds: [], censusAiannhce: [], censusGeoid: null, biaTldObjectId: row.OBJECTID, biaAnvObjectId: anvRow ? anvRow.OBJECTID : null, iscBandNumber: null },
      review: { status: 'draft', reviewedAt: null, notes: `Draft built by scripts/reference/50-registry.mjs. Footprint basis: ${c.basis.replace(/\.$/, '')}.` },
      flags,
    };
    // crosswalk rows
    crossUs.push({ nationId: id, sourceId: isAnv ? 'bia-anv' : 'bia-tld', sourceKey: `OBJECTID ${row.OBJECTID}`, matchMethod: 'code', reviewed: false, notes: `${isAnv ? 'bia-anv' : 'bia-tld'} is the originating record; key ${c.key}.` });
    if (isAnv) crossUs.push({ nationId: id, sourceId: 'bia-tld', sourceKey: `OBJECTID ${row.OBJECTID}`, matchMethod: 'code', reviewed: false, notes: 'Same OBJECTID and identical tribefullname in the Tribal Leaders Directory.' });
    crossUs.push({ nationId: id, sourceId: 'federal-register-tribes', sourceKey: fr ? fr.raw : tldName, matchMethod: frMethod, reviewed: false,
      notes: fr ? (matchNote || 'tribefullname equals the Federal Register entry after entity decoding and whitespace folding.') : 'No Federal Register entry matched; the Directory name is carried and listed for review.' });
    // LAR and Census candidates by exact normalized name against the tribal short, component, and alternate names.
    const keys = [row.tribalcomponentname, row.tribeshortname, row.tribealternatename].map(normName).filter(Boolean);
    c.keys = [...new Set(keys)];
    // The listing text the land-area candidate step reads: the Federal Register entry (annotations included, for former
    // names and "includes" lists) and the Directory names. `includesText` is the part after "includes", if any.
    c.listing = [fr ? fr.raw : tldName, row.tribalcomponentname, row.tribeshortname, row.tribealternatename].filter(Boolean).join(' ; ');
    c.includesText = /\(\s*includes\s+([^)]*)\)/i.exec(fr ? fr.raw : '')?.[1] ?? '';
    decisions.push({ c, rec });
    records.push(rec);
    for (const k of c.keys) { if (!larKeyOwners.has(k)) larKeyOwners.set(k, new Set()); larKeyOwners.get(k).add(id); }
  }
  // LAR / Census matching after all candidates are known, so a name claimed by two Nations is ambiguous.
  const larBy = new Map();
  for (const l of lar) larBy.set(normName(l.LARNAME), l);
  /** @type {Map<string, any[]>} */
  const censusBy = new Map();
  for (const a of census.filter((x) => CENSUS_LEGAL_MTFCC.includes(x.mtfcc))) { const k = normName(a.name); if (!censusBy.has(k)) censusBy.set(k, []); /** @type {any[]} */ (censusBy.get(k)).push(a); }
  report.us.larUnmatched = [];
  report.us.censusUnmatched = [];
  report.us.censusRejected = [];
  report.us.larAmbiguous = [];
  // Shared areas are never assigned by name at any stage (review R2); a name that reaches one is reported instead.
  const sharedLar = sharedLarAreas(lar);
  report.us.sharedAreasDerived = [...sharedLar.entries()].filter(([k]) => !(k in SHARED_AREAS.lar)).map(([key, name]) => ({ source: 'bia-lar', key, name, basis: 'CLASSIFICATION other than 1 in the pinned LAR file' }));
  report.us.sharedNameMatchesBlocked = [];
  for (const { c, rec } of decisions) {
    for (const k of c.keys) {
      if (larBy.has(k) && sharedLar.has(larBy.get(k).LARID)) report.us.sharedNameMatchesBlocked.push({ id: rec.id, source: 'bia-lar', key: larBy.get(k).LARID, name: larBy.get(k).LARNAME });
      for (const a of censusBy.get(k) ?? []) if (isSharedCensusName(a.name)) report.us.sharedNameMatchesBlocked.push({ id: rec.id, source: 'census-aiannh-2025', key: a.geoid, name: a.name });
    }
    const amb = c.keys.filter((/** @type {string} */ k) => larBy.has(k) && larKeyOwners.get(k).size > 1 && !sharedLar.has(larBy.get(k).LARID));
    const larIds = exactLarIds(c.keys, larBy, larKeyOwners, sharedLar);
    if (amb.length && !larIds.length) report.us.larAmbiguous.push({ id: rec.id, name: rec.name, keys: amb });
    if (!c.isAnv) {
      if (larIds.length) {
        rec.codes.biaLarIds = larIds;
        for (const lid of larIds) crossUs.push({ nationId: rec.id, sourceId: 'bia-lar', sourceKey: lid, matchMethod: 'name-exact', reviewed: false,
          notes: `LARNAME "${larBy.get(normName(lar.find((l) => l.LARID === lid)?.LARNAME)).LARNAME}" equals a Directory short, component, or alternate name of this Tribe.` });
      } else if (c.row.LARtype === 'Land Area Representation') report.us.larUnmatched.push({ id: rec.id, name: rec.name });
    }
    const cHits = [...new Set(c.keys.flatMap((/** @type {string} */ k) => (censusBy.get(k) ?? []).filter((/** @type {any} */ a) => !isSharedCensusName(a.name)).map((/** @type {any} */ a) => a.geoid)))];
    const cRows = exactCensusRows(c.keys, censusBy);
    const owned0 = cRows.filter((/** @type {any} */ a) => larKeyOwners.get(normName(a.name))?.size === 1);
    // Guard (review M9): a same-named area far from the headquarters is not this Nation's land; listed in the packet, never matched.
    const owned = owned0.filter((/** @type {any} */ a) => !Number.isFinite(a.lat) || haversineKm(c.lat, c.lon, a.lat, a.lon) <= CENSUS_GUARD_KM);
    for (const a of owned0) if (!owned.includes(a)) report.us.censusRejected.push({ id: rec.id, geoid: a.geoid, name: a.name, km: Math.round(haversineKm(c.lat, c.lon, a.lat, a.lon)) });
    if (owned.length && !c.isAnv) {
      rec.codes.censusAiannhce = [...new Set(owned.map((/** @type {any} */ a) => a.ce))].sort();
      // R is a reservation and T is off-reservation trust land of the same Census code. One R is the primary GEOID; with no R, a single T is.
      const rGeo = owned.filter((/** @type {any} */ a) => a.geoid.endsWith('R'));
      const tGeo = owned.filter((/** @type {any} */ a) => a.geoid.endsWith('T'));
      rec.codes.censusGeoid = rGeo.length === 1 ? rGeo[0].geoid : !rGeo.length && tGeo.length === 1 ? tGeo[0].geoid : null;
      for (const a of owned) crossUs.push({ nationId: rec.id, sourceId: 'census-aiannh-2025', sourceKey: a.geoid, matchMethod: 'name-exact', reviewed: false,
        notes: `Census NAME "${a.name}" (MTFCC ${a.mtfcc}, ${a.mtfcc === 'G2102' ? 'legal off-reservation trust land' : 'legal reservation'}, COMPTYP ${a.comptyp}, CLASSFP ${a.classfp}) equals a Directory short, component, or alternate name.` });
    } else if (!c.isAnv && cHits.length === 0 && c.row.LARtype === 'Land Area Representation') report.us.censusUnmatched.push({ id: rec.id, name: rec.name });
  }

  // ---- Land-area candidates by place phrase (review M1) ----
  // Reservation names are rarely the Directory short names, so a Tribe such as Yakama or Umatilla has no exact LAR or Census
  // match. The place words of the Federal Register listing (including its "previously listed as" and "includes" text) are compared
  // with each unclaimed land-area name. A candidate is accepted only when it is corroborated (within CANDIDATE_KM of the
  // headquarters, or named in the listing's own "includes" list) and claimed by exactly one Nation. Every accepted match is
  // `name-reviewed` with `reviewed: false`: a person confirms it in the packet. The shared Columbia River areas are never assigned.
  report.us.areaCandidates = [];
  report.us.areaCandidatesRejected = [];
  report.us.sharedAreas = [];
  const claimedLar = new Set(records.flatMap((r) => r.codes.biaLarIds));
  const claimedCe = new Set(records.flatMap((r) => r.codes.censusAiannhce));
  /** @type {{ nationId: string, kind: 'lar' | 'census', key: string, name: string, tier: number, km: number, accepted: boolean, viaIncludes: boolean }[]} */
  const cands = [];
  for (const { c, rec } of decisions) {
    if (c.isAnv) continue;
    const listing = placeTokens(c.listing);
    const includes = placeTokens(c.includesText);
    if (!rec.codes.biaLarIds.length) {
      for (const l of lar) {
        if (claimedLar.has(l.LARID)) continue;
        if (sharedLar.has(String(l.LARID))) continue;
        const tier = areaCandidateTier(listing, l.LARNAME);
        if (!tier) continue;
        const viaIncludes = containsRun(includes, placeTokens(l.LARNAME));
        const km = pointInGeometry(c.lon, c.lat, l.geometry) ? 0 : distanceToOutlineKm(c.lon, c.lat, l.geometry);
        cands.push({ nationId: rec.id, kind: 'lar', key: l.LARID, name: l.LARNAME, tier, km: Math.round(km * 10) / 10, viaIncludes, accepted: viaIncludes || km <= (tier === 1 ? CANDIDATE_KM.tier1 : CANDIDATE_KM.tier2) });
      }
    }
    if (!rec.codes.censusAiannhce.length) {
      for (const a of census.filter((x) => CENSUS_LEGAL_MTFCC.includes(x.mtfcc))) {
        if (claimedCe.has(a.ce)) continue;
        if (isSharedCensusName(a.name)) continue;
        const tier = areaCandidateTier(listing, a.name);
        if (!tier) continue;
        const viaIncludes = containsRun(includes, placeTokens(a.name));
        const km = Number.isFinite(a.lat) ? haversineKm(c.lat, c.lon, a.lat, a.lon) : Infinity;
        cands.push({ nationId: rec.id, kind: 'census', key: a.geoid, name: a.name, tier, km: Math.round(km * 10) / 10, viaIncludes, accepted: viaIncludes || km <= (tier === 1 ? CANDIDATE_KM.tier1 : CANDIDATE_KM.tier2) });
      }
    }
  }
  for (const s of lar.filter((l) => sharedLar.has(String(l.LARID)))) report.us.sharedAreas.push({ source: 'bia-lar', key: s.LARID, name: s.LARNAME });
  for (const s of census.filter((x) => CENSUS_LEGAL_MTFCC.includes(x.mtfcc) && isSharedCensusName(x.name))) report.us.sharedAreas.push({ source: 'census-aiannh-2025', key: s.geoid, name: s.name });
  // Census areas that share a code (reservation and trust land) are one claim.
  /** @param {typeof cands[number]} x */
  const claimKey = (x) => (x.kind === 'census' ? `census:${x.key.slice(0, 4)}` : `lar:${x.key}`);
  /** @type {Map<string, Set<string>>} */
  const claimants = new Map();
  for (const x of cands.filter((y) => y.accepted)) { const k = claimKey(x); if (!claimants.has(k)) claimants.set(k, new Set()); /** @type {Set<string>} */ (claimants.get(k)).add(x.nationId); }
  /** @type {Map<string, any[]>} */
  const newCensus = new Map();
  for (const x of cands) {
    const owners = claimants.get(claimKey(x));
    if (!x.accepted) { report.us.areaCandidatesRejected.push({ ...x, why: `${x.km} km from the headquarters (limit ${x.tier === 1 ? CANDIDATE_KM.tier1 : CANDIDATE_KM.tier2} for tier ${x.tier})` }); continue; }
    if (!owners || owners.size !== 1) { report.us.areaCandidatesRejected.push({ ...x, why: 'claimed by more than one Nation' }); continue; }
    const rec = /** @type {Rec} */ (records.find((r) => r.id === x.nationId));
    const basis = x.viaIncludes ? 'named in the "includes" list of the Federal Register entry' : `${x.km} km from the headquarters`;
    const how = `Place words of the area name ${x.tier === 1 ? 'appear in' : 'begin with a word of'} the Tribe's Federal Register listing (tier ${x.tier}); ${basis}.`;
    if (x.kind === 'lar') {
      rec.codes.biaLarIds = [...new Set([...rec.codes.biaLarIds, x.key])].sort();
      crossUs.push({ nationId: rec.id, sourceId: 'bia-lar', sourceKey: x.key, matchMethod: 'name-reviewed', reviewed: false, notes: `LARNAME "${x.name}": ${how} Candidate for the maintainer to confirm.` });
    } else {
      const a = /** @type {any} */ (census.find((z) => z.geoid === x.key));
      if (!newCensus.has(rec.id)) newCensus.set(rec.id, []);
      /** @type {any[]} */ (newCensus.get(rec.id)).push(a);
      crossUs.push({ nationId: rec.id, sourceId: 'census-aiannh-2025', sourceKey: x.key, matchMethod: 'name-reviewed', reviewed: false,
        notes: `Census NAME "${x.name}" (MTFCC ${a.mtfcc}, ${a.mtfcc === 'G2102' ? 'legal off-reservation trust land' : 'legal reservation'}, COMPTYP ${a.comptyp}, CLASSFP ${a.classfp}): ${how} Candidate for the maintainer to confirm.` });
    }
    report.us.areaCandidates.push({ nationId: rec.id, source: x.kind === 'lar' ? 'bia-lar' : 'census-aiannh-2025', key: x.key, name: x.name, tier: x.tier, km: x.km, viaIncludes: x.viaIncludes });
  }
  for (const [id, rows] of newCensus) {
    const rec = /** @type {Rec} */ (records.find((r) => r.id === id));
    rec.codes.censusAiannhce = [...new Set(rows.map((a) => a.ce))].sort();
    const rGeo = rows.filter((a) => a.geoid.endsWith('R'));
    const tGeo = rows.filter((a) => a.geoid.endsWith('T'));
    rec.codes.censusGeoid = rGeo.length === 1 ? rGeo[0].geoid : !rGeo.length && tGeo.length === 1 ? tGeo[0].geoid : null;
  }
  const hasCensusRows = (/** @type {string} */ id) => records.find((r) => r.id === id)?.codes.censusAiannhce.length;
  report.us.larUnmatched = report.us.larUnmatched.filter((/** @type {any} */ x) => !records.find((r) => r.id === x.id)?.codes.biaLarIds.length);
  report.us.censusUnmatched = report.us.censusUnmatched.filter((/** @type {any} */ x) => !hasCensusRows(x.id));

  // ---- British Columbia ----
  const iscRows = csvRows(zipMember(bytes(inputs, 'isc-locations'), /\.csv$/i));
  const councils = csvRows(zipMember(bytes(inputs, 'isc-tribal-council'), /\.csv$/i));
  const reserves = csvRows(zipMember(bytes(inputs, 'isc-reserve'), /\.csv$/i));
  const nrcan = shapefileAttributes(bytes(inputs, 'nrcan-aboriginal-lands-bc'), 'AL_TA_BC_[^/]*\\.shp$');
  const nrcanByCode = new Map(nrcan.map((r) => [r.ALCODE, r]));
  const reservesByBand = new Map();
  for (const r of reserves) { const b = r.BAND_NUMBER ?? ''; if (!reservesByBand.has(b)) reservesByBand.set(b, []); reservesByBand.get(b).push(r); }
  const councilByBand = new Map();
  for (const r of councils) { const b = r.BAND_NUMBER ?? ''; if (!councilByBand.has(b)) councilByBand.set(b, []); councilByBand.get(b).push(r.TRIBAL_COUNCIL_NAME ?? ''); }
  /** @type {any[]} */
  const crossBc = [];
  /** @type {any[]} */
  const bcBands = [];
  report.bc = { iscRows: iscRows.length, hqInBcOnly: [], nearOutline: [], reserveOnly: [], both: 0 };
  for (const b of iscRows.slice().sort((x, y) => Number(x.BAND_NUMBER) - Number(y.BAND_NUMBER))) {
    const lat = Number(b.LATITUDE);
    const lon = Number(b.LONGITUDE);
    const bn = b.BAND_NUMBER ?? '';
    const bcReserves = (reservesByBand.get(bn) ?? []).filter((/** @type {any} */ r) => nrcanByCode.has(r.ADMIN_LAND_ID));
    const finite = Number.isFinite(lat) && Number.isFinite(lon);
    const inside = finite && pointInGeometry(lon, lat, bcPoly);
    // The Natural Earth outline is coarse at inlets and the Alaska line, so a headquarters within BC_TOLERANCE_KM of it
    // still counts as inside British Columbia (listed in the packet as "near the outline").
    const nearKm = finite && !inside ? distanceToOutlineKm(lon, lat, bcPoly) : Infinity;
    const near = nearKm <= BC_TOLERANCE_KM;
    const inBc = inside || near;
    const ex = excludeKeys.get(`isc:${bn}`);
    if (ex) { report.bc.excluded = [...(report.bc.excluded ?? []), { band: bn, name: b.BAND_NAME, reason: ex.reason }]; continue; }
    const inc = includeKeys.get(`isc:${bn}`);
    if (!(inBc || bcReserves.length || inc)) continue;
    if (inside && bcReserves.length) report.bc.both += 1;
    else if (inside) report.bc.hqInBcOnly.push({ band: bn, name: b.BAND_NAME });
    else if (near) report.bc.nearOutline.push({ band: bn, name: b.BAND_NAME, km: Math.round(nearKm * 10) / 10, reserves: bcReserves.length });
    else report.bc.reserveOnly.push({ band: bn, name: b.BAND_NAME, lat, lon, reserves: bcReserves.length });
    bcBands.push({ b, lat, lon, bn, bcReserves, inBc });
  }
  for (const { b, lat, lon, bn, bcReserves, inBc } of bcBands) {
    const name = String(b.BAND_NAME ?? '').trim();
    const assigned = assignNationId(lock, { key: `isc:${bn}`, name, country: 'CA', bandNumber: Number(bn) }, cfg.mintedAt);
    lock = assigned.lock;
    const id = assigned.id;
    const names = cfg.names.find((n) => n.nationId === id);
    const tzOv = override(id, 'timeZone');
    const lookupTz = tzlookup(r5(lat), r5(lon));
    const tz = tzOv ? tzOv.value : lookupTz;
    /** @type {string[]} */
    const flags = [];
    const shown = names ? names.name : name;
    if (hasNamePlaceholder(shown)) flags.push('name-orthography-needs-nation-source');
    // A ratified timeZone override clears both the local-practice and the border-point checks (packet amendments 10/05/2026, A.3).
    if (!tzOv && (TZ_CONFIRM.has(tz) || !tzConsistent(['BC'], lookupTz))) flags.push('tz-needs-confirmation');
    const aliasSet = new Map();
    if (hasNamePlaceholder(name)) {
      const plain = collapse(name.replace(/[?�]/g, ''));
      if (plain && normName(plain) !== normName(shown)) aliasSet.set(normName(plain), plain);
    }
    const council = [...new Set(councilByBand.get(bn) ?? [])].sort().join('; ') || null;
    const rec = {
      id, castId: null, name: shown,
      nameSource: names
        ? { kind: 'names-override', citation: `data/registry/names.yaml: ${names.notes ?? 'the Nation\'s own published name'}`, url: names.sourceUrl, retrievedAt: names.verifiedAt }
        : { kind: 'isc-registered-name', citation: `ISC First Nations location file, BAND_NAME for BAND_NUMBER ${bn}`, url: SOURCE_URLS['isc-first-nations'], retrievedAt: DOWNLOADED.bulk },
      preferredName: names?.preferredName ?? null,
      preferredNameSource: names?.preferredName ? { url: names.sourceUrl, verifiedAt: names.verifiedAt } : null,
      aliases: [...aliasSet.values()],
      kind: 'first-nation', country: 'CA', jurisdictions: ['BC'], region: 'bc',
      hq: { lat: r5(lat), lon: r5(lon), precision: 'community', sourceId: 'isc-first-nations', sourceRecordId: bn, retrievedAt: DOWNLOADED.bulk, reviewed: false },
      samples: [[r5(lat), r5(lon)]], bbox: [0, 0, 0, 0],
      boundary: { status: 'point-only', detailRef: null, parts: [] },
      timeZone: tz, timeZoneSource: tzOv ? 'override' : 'tz-lookup', units: 'metric',
      nws: null, eccc: null, radar: { nexrad: null, ridgeLoop: null, eccc: null }, gauges: [], contactIds: [], website: null,
      isc: { bandNumber: Number(bn), tribalCouncil: council },
      codes: { biaLarIds: [], censusAiannhce: [], censusGeoid: null, biaTldObjectId: null, biaAnvObjectId: null, iscBandNumber: Number(bn) },
      review: { status: 'draft', reviewedAt: null, notes: `Draft built by scripts/reference/50-registry.mjs. BC basis: ${inBc ? 'headquarters inside, or within ' + BC_TOLERANCE_KM + ' km of, the British Columbia outline' : 'headquarters outside the British Columbia outline'}; ${bcReserves.length} reserve polygon${bcReserves.length === 1 ? '' : 's'} joined through the ISC reserve relation.` },
      flags,
    };
    records.push(rec);
    crossBc.push({ nationId: id, sourceId: 'isc-first-nations', sourceKey: `BAND_NUMBER ${bn}`, matchMethod: 'code', reviewed: false, notes: 'ISC location file is the originating record; id is ca-fn-<band number>.' });
    for (const r of bcReserves.slice().sort((/** @type {any} */ x, /** @type {any} */ y) => String(x.ADMIN_LAND_ID).localeCompare(String(y.ADMIN_LAND_ID)))) {
      crossBc.push({ nationId: id, sourceId: 'nrcan-aboriginal-lands-bc', sourceKey: `ALCODE ${r.ADMIN_LAND_ID}`, matchMethod: 'code', reviewed: false,
        notes: `ISC reserve relation ADMIN_LAND_ID equals NRCan ALCODE (relation name ${r.ADMIN_LAND_EN ?? ''}; NRCan NAME1 ${nrcanByCode.get(r.ADMIN_LAND_ID)?.NAME1 ?? ''}).` });
    }
  }
  const joined = new Set(crossBc.filter((r) => r.sourceId === 'nrcan-aboriginal-lands-bc').map((r) => r.sourceKey.replace('ALCODE ', '')));
  report.bc.nrcanPolygons = nrcan.length;
  report.bc.nrcanJoined = nrcan.filter((r) => joined.has(r.ALCODE ?? '')).length;
  report.bc.nrcanUnjoined = nrcan.filter((r) => !joined.has(r.ALCODE ?? '')).map((r) => ({ alcode: r.ALCODE, name: r.NAME1, type: r.ALTYPE }));
  report.bc.relationRowsWithoutPolygon = reserves.filter((r) => !nrcanByCode.has(r.ADMIN_LAND_ID ?? '')).length;
  report.sourceCounts = {
    federalRegisterEntries: frEntries.length, federalRegisterContiguous: frEntries.filter((e) => e.section === 'contiguous').length,
    federalRegisterAlaska: frEntries.filter((e) => e.section === 'alaska').length,
    federalRegisterSeeReferences: frEntries.filter((e) => /\(\s*See (?!Supplementary)/i.test(e.raw)).length,
    tldRows: tld.length, tldTribes: tld.filter((r) => r.tribalcomponent === 'Tribe').length, anvRows: anv.length, larFeatures: lar.length,
    censusAiannhRows: census.length, censusG2101: census.filter((x) => x.mtfcc === 'G2101').length, censusG2102: census.filter((x) => x.mtfcc === 'G2102').length, iscLocationRows: iscRows.length, iscReserveRows: reserves.length, iscCouncilRows: councils.length, nrcanPolygons: nrcan.length,
  };
  report.frFootprintParentheticals = records.filter((r) => r.nameSource.kind === 'federal-register').map((r) => {
    const raw = /entry "(.*)"$/.exec(r.nameSource.citation)?.[1] ?? '';
    return { id: r.id, raw, name: r.name };
  }).filter((x) => x.raw !== x.name || /\(/.test(x.raw));
  for (const o of [...cfg.overrides, ...cfg.names]) {
    if (!records.some((r) => r.id === o.nationId)) throw new Error(`overrides.yaml or names.yaml names ${o.nationId}, which is not a Nation in scope`);
  }
  // An alias never equals another Nation's name (the names gate): search keys that collide are dropped.
  const allNames = new Set(records.map((r) => normName(r.name)));
  for (const r of records) r.aliases = r.aliases.filter((/** @type {string} */ a) => !allNames.has(normName(a)));
  report.review = applyApproval(records, [...crossUs, ...crossBc], lock, cfg.review ?? null);
  records.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  crossUs.sort((a, b) => (a.nationId + a.sourceId + a.sourceKey).localeCompare(b.nationId + b.sourceId + b.sourceKey, 'en'));
  crossBc.sort((a, b) => (a.nationId + a.sourceId + a.sourceKey).localeCompare(b.nationId + b.sourceId + b.sourceKey, 'en'));
  return { records, lock, crossUs, crossBc, report };
}

// ---------------------------------------------------------------------------------------------
// Config files and output
// ---------------------------------------------------------------------------------------------

/** @param {string} file @param {any} fallback */
function readYamlOr(file, fallback) {
  return existsSync(file) ? loadYaml(readFileSync(file, 'utf8'), { schema: CORE_SCHEMA }) : fallback;
}

/** Stable JSON text: two-space indent, trailing newline. @param {unknown} v */
export const stable = (v) => `${JSON.stringify(v, null, 2)}\n`;

export function loadConfig(mintedAt = new Date().toISOString().slice(0, 10)) {
  const lockFile = path.join(REGISTRY_DIR, 'ids.lock.json');
  return {
    lock: existsSync(lockFile) ? JSON.parse(readFileSync(lockFile, 'utf8')) : { schema: 'cthd.ids-lock/1', entries: [] },
    scope: readYamlOr(path.join(REGISTRY_DIR, 'scope.yaml'), { include: [], exclude: [] }),
    overrides: readYamlOr(path.join(REGISTRY_DIR, 'overrides.yaml'), []),
    names: readYamlOr(path.join(REGISTRY_DIR, 'names.yaml'), []),
    review: readApproval(readYamlOr(path.join(REGISTRY_DIR, 'review.yaml'), null)),
    mintedAt,
  };
}

/**
 * Write the pins file from the raw folders (development: run once, review the diff, commit).
 * @param {string[]} rawDirs
 */
function pin(rawDirs) {
  const existing = readYamlOr(PINS_FILE, { inputs: [] });
  let text = readFileSync(PINS_FILE, 'utf8');
  for (const p of existing.inputs) {
    const found = rawDirs.map((d) => path.join(d, p.file)).find((f) => existsSync(f));
    if (!found) throw new Error(`cannot pin ${p.file}`);
    // Replace only the SHA-256 value of this input so the file's comments and layout survive.
    const re = new RegExp(`(- id: ${p.id}\\n(?:    .*\\n)*?    sha256: )'?[0-9a-f]{64}'?`);
    if (!re.test(text)) throw new Error(`no sha256 line for ${p.id}`);
    text = text.replace(re, `$1${sha256Buf(readFileSync(found))}`);
  }
  writeFileSync(PINS_FILE, text);
}

/** @param {string[]} argv @param {string} name */
const args = (argv, name) => argv.flatMap((a, i) => (a === `--${name}` ? [argv[i + 1] ?? ''] : []));

export async function main(argv = process.argv.slice(2)) {
  const rawDirs = args(argv, 'raw').length ? args(argv, 'raw') : (process.env.CTHD_RAW ?? '').split(path.delimiter).filter(Boolean);
  if (!rawDirs.length) throw new Error('usage: 50-registry.mjs --raw <folder> [--raw <folder>] [--minted-at YYYY-MM-DD] | --pin');
  if (argv.includes('--pin')) { pin(rawDirs); console.log(`pinned ${PINS_FILE}`); return; }
  const inputs = resolveInputs(rawDirs);
  const mintedAt = args(argv, 'minted-at')[0] ?? new Date().toISOString().slice(0, 10);
  const cfg = loadConfig(mintedAt);
  const before = cfg.lock.entries.length;
  const out = buildDraft(inputs, cfg);
  mkdirSync(REGISTRY_DIR, { recursive: true });
  writeFileSync(path.join(REGISTRY_DIR, 'ids.lock.json'), stable(out.lock));
  const generatedAt = `${DOWNLOADED.bulk}T00:00:00Z`;
  writeFileSync(path.join(REGISTRY_DIR, 'crosswalk-us.json'), stable({ schema: 'cthd.crosswalk/1', generatedAt, rows: out.crossUs }));
  writeFileSync(path.join(REGISTRY_DIR, 'crosswalk-bc.json'), stable({ schema: 'cthd.crosswalk/1', generatedAt, rows: out.crossBc }));
  writeFileSync(path.join(REGISTRY_DIR, 'draft-registry.json'), stable({
    schema: 'cthd.draft-registry/1', generatedAt,
    inputs: Object.values(inputs).map((i) => ({ id: i.pin.id, sha256: i.pin.sha256, vintage: i.pin.vintage })),
    stats: out.report.sourceCounts, bc: { nrcanPolygons: out.report.bc.nrcanPolygons, nrcanJoined: out.report.bc.nrcanJoined, nrcanUnjoined: out.report.bc.nrcanUnjoined },
    records: out.records,
  }));
  console.log(`50-registry: ${out.records.length} records (${out.records.filter((r) => r.country === 'US').length} U.S., ${out.records.filter((r) => r.country === 'CA').length} British Columbia; ${out.report.review.reviewed} reviewed, ${out.report.review.draft} draft${out.report.review.held.length ? `, held: ${out.report.review.held.join(', ')}` : ''}${out.report.review.flagged.length ? `, flagged: ${out.report.review.flagged.join(', ')}` : ''}); ${out.lock.entries.length - before} ids minted`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();

export { sha256 };
