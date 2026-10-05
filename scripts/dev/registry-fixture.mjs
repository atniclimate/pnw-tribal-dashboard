// @ts-check
/**
 * Build the five-Nation registry fixture in tests/fixtures/registry/ (blueprint 12.1 and 12.3, lane L0).
 *
 *   node scripts/dev/registry-fixture.mjs --raw <folder with the 10/04/2026 bulk downloads>
 *
 * Inputs (read only): bia_tld.geojson (allowlisted fields only; no person keys are read or written),
 * bia_anv.geojson, bia_lar.geojson, isc_fn_csv.zip, Relation_*_Tribal_Council_CSV.zip,
 * Relation_*_Reserve_CSV.zip, AL_TA_BC_SHP_eng.zip, plus the dated NWS /points and ECCC city page captures
 * already in tests/fixtures/upstream/. The fixture is for tests and local development only, is never
 * deployed, and every record stays `review.status: draft`.
 *
 * Development tool only; L5's reference pipeline builds the real registry.
 */
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateRawSync } from 'node:zlib';
import tzlookup from '@photostructure/tz-lookup';
import { assignNationId, hasNamePlaceholder } from '../../site/static/js/data/ids.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT = path.join(ROOT, 'tests', 'fixtures', 'registry');
const UPSTREAM = path.join(ROOT, 'tests', 'fixtures', 'upstream');
const RETRIEVED = '2026-10-04';

/** Fields the BIA Tribal Leaders Directory may contribute (blueprint 5.2). Nothing else is read. */
const TLD_ALLOW = ['OBJECTID', 'tribefullname', 'tribealternatename', 'tribalcomponent', 'biaregion', 'biaagency',
  'city', 'state', 'website', 'latitude', 'longitude', 'LARtype'];

const SOURCES = {
  'bia-tld': 'https://services1.arcgis.com/UxqqIfhng71wUT9x/arcgis/rest/services/TribalLeadership_Directory/FeatureServer/0',
  'bia-anv': 'https://services1.arcgis.com/UxqqIfhng71wUT9x/arcgis/rest/services/AlaskaNativeVillages/FeatureServer/0',
  'bia-lar': 'https://biamaps.geoplatform.gov/server/rest/services/DivLTR/BIA_AIAN_National_LAR/FeatureServer/0',
  'isc-first-nations': 'https://data.sac-isc.gc.ca/geomatics/rest/directories/arcgisoutput/DonneesOuvertes_OpenData/Premiere_Nation_First_Nation/',
  'nrcan-aboriginal-lands-bc': 'https://ftp.maps.canada.ca/pub/nrcan_rncan/vector/geobase_al_ta/shp_eng/AL_TA_BC_SHP_eng.zip',
};

/** The five fixture Nations: one each in Washington, Oregon, Idaho, British Columbia, and Southeast Alaska. */
const PICKS = [
  { kind: 'us', tldObjectId: 359, state: 'wa', region: 'wa', jur: 'WA', larIds: ['LAR0069'], points: 'lummi-hq' },
  { kind: 'us', tldObjectId: 343, state: 'or', region: 'or', jur: 'OR', larIds: ['LAR0083'], points: 'siletz-hq' },
  { kind: 'us', tldObjectId: 374, state: 'id', region: 'id', jur: 'ID', larIds: ['LAR0061'], points: 'fort-hall-hq' },
  { kind: 'anv', anvObjectId: 173, state: 'ak', region: 'ak-se', jur: 'AK-SE', larIds: [], points: 'kasaan-hq' },
  { kind: 'fn', bandNumber: 602, region: 'bc', jur: 'BC', citypage: 'bc-77' },
];

/** @param {string[]} argv @param {string} name */
function arg(argv, name) {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
}

/**
 * Minimal zip reader (stored and deflated entries) so the tool needs no extra dependency.
 * @param {Buffer} buf
 * @returns {Map<string, Buffer>}
 */
function unzip(buf) {
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

/** @param {string} text */
function parseCsv(text) {
  /** @type {string[][]} */
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i += 1; } else if (c === '"') quoted = false; else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; } else if (c === '\n') { row.push(field.replace(/\r$/, '')); rows.push(row); row = []; field = ''; } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  const [head, ...body] = rows;
  if (!head) return [];
  return body.filter((r) => r.length === head.length).map((r) => Object.fromEntries(head.map((h, i) => [h, r[i] ?? ''])));
}

/** @param {number} x */
const r5 = (x) => Math.round(x * 1e5) / 1e5;
/** @param {any} coords */
function roundCoords(coords) {
  return typeof coords[0] === 'number' ? [r5(coords[0]), r5(coords[1])] : coords.map(roundCoords);
}
/** @param {any} geom @param {number[]} box */
function extend(geom, box) {
  const walk = (/** @type {any} */ c) => {
    if (typeof c[0] === 'number') {
      box[0] = Math.min(box[0] ?? Infinity, c[0]); box[1] = Math.min(box[1] ?? Infinity, c[1]);
      box[2] = Math.max(box[2] ?? -Infinity, c[0]); box[3] = Math.max(box[3] ?? -Infinity, c[1]);
    } else c.forEach(walk);
  };
  walk(geom.coordinates);
}
/** @param {number} lat @param {number} lon @param {number} lat2 @param {number} lon2 */
function haversineKm(lat, lon, lat2, lon2) {
  const rad = Math.PI / 180;
  const a = Math.sin(((lat2 - lat) * rad) / 2) ** 2 + Math.cos(lat * rad) * Math.cos(lat2 * rad) * Math.sin(((lon2 - lon) * rad) / 2) ** 2;
  return 2 * 6371.0088 * Math.asin(Math.sqrt(a));
}
/** @param {string} url */
const zoneCode = (url) => url.split('/').pop() ?? '';

async function main() {
  const raw = arg(process.argv, 'raw');
  if (!raw) throw new Error('usage: registry-fixture.mjs --raw <folder>');
  const read = (/** @type {string} */ f) => readFile(path.join(raw, f));
  const tld = JSON.parse((await read('bia_tld.geojson')).toString('utf8'));
  const anv = JSON.parse((await read('bia_anv.geojson')).toString('utf8'));
  const lar = JSON.parse((await read('bia_lar.geojson')).toString('utf8'));
  const isc = parseCsv([...unzip(await read('isc_fn_csv.zip')).values()][0]?.toString('utf8').replace(/^\uFEFF/, '') ?? '');
  const councils = parseCsv([...unzip(await read('Relation_Premiere_Nation_conseil_tribal_Relation_First_Nation_Tribal_Council_CSV.zip')).values()][0]?.toString('utf8').replace(/^\uFEFF/, '') ?? '');
  const reserves = parseCsv([...unzip(await read('Relation_Premiere_Nation_reserve_Relation_First_Nation_Reserve_CSV.zip')).values()][0]?.toString('utf8').replace(/^\uFEFF/, '') ?? '');
  const citypages = JSON.parse(await readFile(path.join(UPSTREAM, 'eccc-citypage-realtime', '2026-10-05-bc-cranbrook.json'), 'utf8'));

  /** @type {import('../../site/static/js/types.js').IdsLock} */
  let lock = { schema: 'cthd.ids-lock/1', entries: [] };
  /** @type {any[]} */
  const records = [];
  /** @type {any[]} */
  const hqFeatures = [];
  await mkdir(path.join(OUT, 'nations'), { recursive: true });
  await mkdir(path.join(OUT, 'geo', 'boundaries'), { recursive: true });

  for (const pick of PICKS) {
    /** @type {any} */
    let rec;
    if (pick.kind === 'us' || pick.kind === 'anv') {
      const srcFc = pick.kind === 'us' ? tld : anv;
      const srcId = pick.kind === 'us' ? 'bia-tld' : 'bia-anv';
      const objectId = pick.kind === 'us' ? pick.tldObjectId : pick.anvObjectId;
      const f = srcFc.features.find((/** @type {any} */ x) => x.properties.OBJECTID === objectId);
      if (!f) throw new Error(`${srcId} OBJECTID ${objectId} not found`);
      /** @type {Record<string, any>} */
      const p = Object.fromEntries(TLD_ALLOW.filter((k) => k in f.properties).map((k) => [k, f.properties[k]]));
      const name = String(p.tribefullname).trim();
      const assigned = assignNationId(lock, { key: `${srcId}:${name}`, name, country: 'US', state: pick.state ?? '' }, RETRIEVED);
      lock = assigned.lock;
      const id = assigned.id;
      const lat = Number(p.latitude);
      const lon = Number(p.longitude);
      const pts = JSON.parse(await readFile(path.join(UPSTREAM, 'nws-points', `2026-10-05-${pick.points}.json`), 'utf8')).properties;
      /** @type {number[]} */
      const box = [];
      const parts = [];
      const feats = [];
      for (const larId of pick.larIds ?? []) {
        const lf = lar.features.find((/** @type {any} */ x) => x.properties.LARID === larId);
        if (!lf) throw new Error(`LAR ${larId} missing`);
        extend(lf.geometry, box);
        parts.push({ sourceId: 'bia-lar', featureId: larId, kind: 'land-area-representation', vintage: RETRIEVED });
        feats.push({ type: 'Feature', properties: { nationId: id, name, source: 'bia-lar', sourceFeatureId: larId, vintage: RETRIEVED,
          kind: 'land-area-representation', sourceName: lf.properties.LARNAME }, geometry: { type: lf.geometry.type, coordinates: roundCoords(lf.geometry.coordinates) } });
      }
      const hasPolygon = feats.length > 0;
      if (hasPolygon) {
        await writeFile(path.join(OUT, 'geo', 'boundaries', `${id}.json`), JSON.stringify({ type: 'FeatureCollection', features: feats }) + '\n');
      }
      const dLat = 10 / 111.32;
      const dLon = 10 / (111.32 * Math.cos((lat * Math.PI) / 180));
      const bbox = hasPolygon ? box.map(r5) : [r5(lon - dLon), r5(lat - dLat), r5(lon + dLon), r5(lat + dLat)];
      const tz = tzlookup(lat, lon);
      rec = {
        id, castId: null, name,
        nameSource: { kind: srcId, citation: `${srcId === 'bia-tld' ? 'BIA Tribal Leaders Directory' : 'BIA Alaska Native Villages'}, tribefullname, OBJECTID ${objectId}`, url: SOURCES[srcId], retrievedAt: RETRIEVED },
        preferredName: null, preferredNameSource: null,
        aliases: p.tribealternatename ? [String(p.tribealternatename)] : [],
        kind: pick.kind === 'anv' ? 'alaska-native-village' : 'us-federally-recognized-tribe',
        country: 'US', jurisdictions: [pick.jur], region: pick.region,
        hq: { lat, lon, precision: 'office', sourceId: srcId, sourceRecordId: String(objectId), retrievedAt: RETRIEVED, reviewed: false },
        samples: [[lat, lon]],
        bbox,
        boundary: hasPolygon
          ? { status: 'polygon', detailRef: `geo/boundaries/${id}.json`, parts }
          : { status: 'point-only', detailRef: null, parts: [] },
        timeZone: tz, timeZoneSource: 'tz-lookup',
        units: 'us',
        nws: {
          wfo: [pts.cwa], point: [lat, lon],
          forecastZones: [`forecast:${zoneCode(pts.forecastZone)}`],
          countyZones: [`county:${zoneCode(pts.county)}`],
          fireZones: pts.fireWeatherZone ? [`fire:${zoneCode(pts.fireWeatherZone)}`] : [],
          marineZones: [],
        },
        eccc: null,
        radar: { nexrad: pts.radarStation ?? null, ridgeLoop: pts.radarStation ?? null, eccc: null },
        gauges: [], contactIds: [], website: null, isc: null,
        codes: { biaLarIds: pick.larIds ?? [], censusAiannhce: [], censusGeoid: null,
          biaTldObjectId: pick.kind === 'us' ? objectId : null, biaAnvObjectId: pick.kind === 'anv' ? objectId : null, iscBandNumber: null },
        review: { status: 'draft', reviewedAt: null, notes: 'Registry test fixture built by scripts/dev/registry-fixture.mjs; not for display.' },
        flags: [],
      };
    } else {
      const row = isc.find((r) => Number(r.BAND_NUMBER) === pick.bandNumber);
      if (!row) throw new Error(`ISC band ${pick.bandNumber} missing`);
      const name = row.BAND_NAME ?? '';
      const assigned = assignNationId(lock, { key: `isc:${pick.bandNumber}`, name, country: 'CA', bandNumber: pick.bandNumber ?? 0 }, RETRIEVED);
      lock = assigned.lock;
      const id = assigned.id;
      const lat = r5(Number(row.LATITUDE));
      const lon = r5(Number(row.LONGITUDE));
      const codes = reserves.filter((r) => Number(r.BAND_NUMBER) === pick.bandNumber).map((r) => r.ADMIN_LAND_ID ?? '');
      const tmp = await mkdtemp(path.join(tmpdir(), 'cthd-reg-'));
      const outFile = path.join(tmp, 'reserves.json');
      const expr = `${JSON.stringify(codes)}.includes(ALCODE)`;
      execFileSync(process.execPath, [path.join(ROOT, 'node_modules', 'mapshaper', 'bin', 'mapshaper'), '-i', path.join(raw, 'AL_TA_BC_SHP_eng.zip'),
        '-filter', expr, '-o', outFile, 'format=geojson', 'precision=0.00001'], { stdio: 'pipe' });
      const fc = JSON.parse(await readFile(outFile, 'utf8'));
      await rm(tmp, { recursive: true, force: true });
      /** @type {number[]} */
      const box = [];
      const parts = [];
      const feats = [];
      for (const f of fc.features) {
        const pr = f.properties;
        const rev = String(pr.REVDATE);
        const vintage = `${rev.slice(0, 4)}-${rev.slice(4, 6)}-${rev.slice(6, 8)}`;
        extend(f.geometry, box);
        parts.push({ sourceId: 'nrcan-aboriginal-lands-bc', featureId: pr.ALCODE, kind: 'indian-reserve', vintage });
        feats.push({ type: 'Feature', properties: { nationId: id, name, source: 'nrcan-aboriginal-lands-bc', sourceFeatureId: pr.ALCODE, vintage,
          kind: 'indian-reserve', sourceName: pr.NAME1 }, geometry: f.geometry });
      }
      await writeFile(path.join(OUT, 'geo', 'boundaries', `${id}.json`), JSON.stringify({ type: 'FeatureCollection', features: feats }) + '\n');
      const council = councils.find((r) => Number(r.BAND_NUMBER) === pick.bandNumber);
      const site = citypages.features.find((/** @type {any} */ f) => f.properties.identifier === pick.citypage);
      const [slon, slat] = site.geometry.coordinates;
      const flags = [];
      if (hasNamePlaceholder(name)) flags.push('name-orthography-needs-nation-source');
      flags.push('tz-needs-confirmation');
      rec = {
        id, castId: null, name,
        nameSource: { kind: 'isc-registered-name', citation: `ISC First Nations location file, BAND_NAME for BAND_NUMBER ${pick.bandNumber}`, url: SOURCES['isc-first-nations'], retrievedAt: RETRIEVED },
        preferredName: null, preferredNameSource: null, aliases: [],
        kind: 'first-nation', country: 'CA', jurisdictions: ['BC'], region: 'bc',
        hq: { lat, lon, precision: 'community', sourceId: 'isc-first-nations', sourceRecordId: String(pick.bandNumber), retrievedAt: RETRIEVED, reviewed: false },
        samples: [[lat, lon]],
        bbox: box.map(r5),
        boundary: { status: 'polygon', detailRef: `geo/boundaries/${id}.json`, parts },
        timeZone: tzlookup(lat, lon), timeZoneSource: 'tz-lookup',
        units: 'metric',
        nws: null,
        eccc: { citypageId: pick.citypage, citypageName: site.properties.name.en, distanceKm: Math.round(haversineKm(lat, lon, slat, slon) * 10) / 10, forecastZones: [] },
        radar: { nexrad: null, ridgeLoop: null, eccc: null },
        gauges: [], contactIds: [], website: null,
        isc: { bandNumber: pick.bandNumber, tribalCouncil: council?.TRIBAL_COUNCIL_NAME ?? null },
        codes: { biaLarIds: [], censusAiannhce: [], censusGeoid: null, biaTldObjectId: null, biaAnvObjectId: null, iscBandNumber: pick.bandNumber },
        review: { status: 'draft', reviewedAt: null, notes: 'Registry test fixture built by scripts/dev/registry-fixture.mjs; not for display. The ISC name carries the ? placeholder.' },
        flags,
      };
    }
    records.push(rec);
    hqFeatures.push({ type: 'Feature', properties: { nationId: rec.id, name: rec.name, hasBoundary: rec.boundary.status === 'polygon' },
      geometry: { type: 'Point', coordinates: [rec.hq.lon, rec.hq.lat] } });
    await writeFile(path.join(OUT, 'nations', `${rec.id}.json`), JSON.stringify(rec, null, 2) + '\n');
    console.log(rec.id, rec.timeZone, rec.boundary.status);
  }
  const index = {
    schema: 'cthd.nations-index/1',
    generatedAt: `${RETRIEVED}T00:00:00Z`,
    nations: records.map((r) => ({ id: r.id, name: r.name, preferredName: r.preferredName, aliases: r.aliases, jurisdictions: r.jurisdictions,
      region: r.region, kind: r.kind, hq: [r.hq.lat, r.hq.lon], tz: r.timeZone, hasBoundary: r.boundary.status === 'polygon' })),
  };
  await writeFile(path.join(OUT, 'nations-index.json'), JSON.stringify(index, null, 2) + '\n');
  await writeFile(path.join(OUT, 'geo', 'hq-points.json'), JSON.stringify({ type: 'FeatureCollection', features: hqFeatures }, null, 2) + '\n');
  await writeFile(path.join(OUT, 'ids.lock.json'), JSON.stringify(lock, null, 2) + '\n');
}

await main();
