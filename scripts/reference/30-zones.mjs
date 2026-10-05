// @ts-check
/**
 * Reference step 30: NWS zones and ECCC forecast regions for the footprint (blueprint 3.7.5, 6.2).
 *
 *   inputs   nws-public-zones, nws-county-zones, nws-fire-zones, nws-coastal-marine-zones,
 *            nws-offshore-marine-zones, eccc-public-forecast-zones, .cache/work/footprint-regions.json (step 20)
 *   outputs  site/data/geo/nws-zones.topo.json     typed zones: one GeometryCollection "zones", id = typed key
 *            site/data/geo/footprint-ugc.json      typed keys, edge codes for the browser top-up, marineToRegion
 *            site/data/geo/eccc-regions.topo.json  British Columbia public forecast zones, id = CLC
 *            site/data/ref/radar-sites.json        NWS WSR-88D sites near the footprint (nws-radar-stations)
 *
 * Typed keys: forecast:WAZ558, county:WAC033, fire:WAZ658, marine:PZZ135 (blueprint 3.7.5). A zone is in the
 * footprint when its state is a whole-state member, or when it overlaps the footprint by at least
 * MIN_OVERLAP_KM2 (sliver mismatches between the NWS and Census boundaries measured at most 6 square
 * kilometers; real overlaps at least 137, so the threshold sits in the gap). Marine zones follow the Pacific
 * coast rule in marineLayer(). Every layer passes mapshaper -clean (allow-overlaps for the zone layers: NWS zones of different offices may overlap, and the default repair would give an overlap to one zone) before export. Output is deterministic.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GEO_DIR, WORK_DIR, loadFootprintDef, ms, stampFor } from './20-footprint.mjs';
import { inputPath, loadInputs } from './10-fetch-inputs.mjs';

export const MIN_OVERLAP_KM2 = 25;

/** Simplification interval in meters (Visvalingam) and quantization for the zone files. */
export const TUNING = {
  zonesIntervalM: 1200,
  zonesQuantization: 10000,
  ecccIntervalM: 1500,
  ecccQuantization: 10000,
};

/** Weather Forecast Offices whose marine zones serve the footprint's Pacific coast and Southeast Alaska. */
const MARINE_WFOS = ['SEW', 'PQR', 'MFR', 'EKA', 'ONP', 'MTR'];

/**
 * @typedef {{ type: 'forecast' | 'county' | 'fire', inputId: string, file: string, codeExpr: string, nameField: string }} LandType
 */

/** @type {LandType[]} */
export const LAND_TYPES = [
  { type: 'forecast', inputId: 'nws-public-zones', file: 'z.zip', codeExpr: "STATE+'Z'+ZONE", nameField: 'NAME' },
  { type: 'county', inputId: 'nws-county-zones', file: 'c.zip', codeExpr: "STATE+'C'+FIPS.slice(2)", nameField: 'COUNTYNAME' },
  { type: 'fire', inputId: 'nws-fire-zones', file: 'fz.zip', codeExpr: "STATE+'Z'+ZONE", nameField: 'NAME' },
];

/**
 * The typed key for an api.weather.gov zone URL or id: `.../zones/forecast/WAZ558` becomes forecast:WAZ558;
 * `coastal` and `offshore` zone types and any PZZ or PKZ id become marine:.
 * @param {string} urlOrPath
 * @returns {string | null}
 */
export function typedKeyFromUrl(urlOrPath) {
  const m = /\/zones\/([a-z]+)\/([A-Z]{2}[A-Z][0-9]{3})\/?$/.exec(urlOrPath);
  if (!m) return null;
  const kind = m[1] ?? '';
  const code = m[2] ?? '';
  if (/^P[ZK]Z/.test(code)) return `marine:${code}`;
  if (kind === 'forecast' || kind === 'county' || kind === 'fire') return `${kind}:${code}`;
  if (kind === 'coastal' || kind === 'offshore' || kind === 'marine') return `marine:${code}`;
  return null;
}

/** @param {unknown[]} list */
const jsList = (list) => JSON.stringify(list);

/**
 * Keys of land zones that are in the footprint, with the overlap evidence for the non-state members.
 * @param {{ zip: Buffer, regionsText: string, def: import('./20-footprint.mjs').FootprintDef, lt: LandType }} p
 * @returns {Promise<{ keys: string[], measured: { key: string, km2: number, fraction: number }[] }>}
 */
async function landKeys({ zip, regionsText, def, lt }) {
  const whole = jsList(def.states);
  const out = await ms(
    `-i in.zip -each ${JSON.stringify(`k='${lt.type}:'+${lt.codeExpr}`)} ` +
      `-each ${JSON.stringify(`inside=${whole}.includes(STATE)`)} ` +
      `-filter-fields k,inside,STATE -each "za=this.area" -o format=geojson all.json`,
    { 'in.zip': zip },
  );
  const all = JSON.parse(String(out['all.json']));
  const wholeKeys = all.features.filter((/** @type {any} */ f) => f.properties.inside).map((/** @type {any} */ f) => f.properties.k);
  const clipped = await ms(
    `-i in.zip -filter ${JSON.stringify(`!${whole}.includes(STATE)`)} ` +
      `-each ${JSON.stringify(`k='${lt.type}:'+${lt.codeExpr}; za=this.area`)} -filter-fields k,za ` +
      `-clip regions.json -each "ia=this.area" -o format=geojson clip.json`,
    { 'in.zip': zip, 'regions.json': regionsText },
  );
  const measured = JSON.parse(String(clipped['clip.json'])).features.map((/** @type {any} */ f) => ({
    key: f.properties.k,
    km2: f.properties.ia / 1e6,
    fraction: f.properties.ia / f.properties.za,
  }));
  const edge = measured.filter((/** @type {{ key: string, km2: number }} */ m) => m.km2 >= MIN_OVERLAP_KM2).map((/** @type {{ key: string }} */ m) => m.key);
  return { keys: [...wholeKeys, ...edge].sort(), measured: measured.sort((/** @type {{ key: string }} */ a, /** @type {{ key: string }} */ b) => (a.key < b.key ? -1 : 1)) };
}

/**
 * Latitude bands of the Pacific coast by region, from the footprint polygons themselves (vertices west of
 * -123 degrees), so marine zones map to the region whose coast they front.
 * @param {string} regionsText
 */
export function coastBands(regionsText) {
  /** @type {Record<string, [number, number]>} */
  const bands = {};
  for (const f of JSON.parse(regionsText).features) {
    const code = f.properties.region;
    if (!['wa', 'or', 'ca-n'].includes(code)) continue;
    const polys = f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates;
    let lo = 90;
    let hi = -90;
    for (const poly of polys) {
      for (const [lon, lat] of poly[0]) {
        if (lon < -123 && lat > 38 && lat < 49.1) { lo = Math.min(lo, lat); hi = Math.max(hi, lat); }
      }
    }
    bands[code] = [lo, hi];
  }
  return bands;
}

/**
 * Region for a marine zone from its label latitude: the region whose coast band contains it, else the
 * nearest band.
 * @param {number} lat
 * @param {Record<string, [number, number]>} bands
 */
export function regionForMarine(lat, bands) {
  let best = 'wa';
  let bestD = Infinity;
  for (const code of Object.keys(bands).sort()) {
    const [lo, hi] = /** @type {[number, number]} */ (bands[code]);
    const d = lat < lo ? lo - lat : lat > hi ? lat - hi : 0;
    if (d < bestD) { bestD = d; best = code; }
  }
  return best;
}

/**
 * Marine zones in scope: coastal and offshore zones of the offices that serve the footprint coast whose
 * latitude range overlaps the footprint's Pacific coast band (zones wholly south of the northern California
 * footprint edge are out), plus every Southeast Alaska (AJK) zone.
 * @param {{ mzZip: Buffer, ozZip: Buffer, bands: Record<string, [number, number]> }} p
 */
async function marineLayer({ mzZip, ozZip, bands }) {
  const coastLo = Math.min(...Object.values(bands).map((b) => b[0]));
  const coastHi = Math.max(...Object.values(bands).map((b) => b[1]));
  const sel =
    `(${jsList(MARINE_WFOS)}.includes(WFO) && /^PZZ/.test(ID) && this.bounds[3] >= ${coastLo} && this.bounds[1] <= ${coastHi}) || ` +
    `(WFO=='AJK' && /^PKZ/.test(ID))`;
  /** @type {any[]} */
  const features = [];
  for (const [zip, name] of /** @type {const} */ ([[mzZip, 'mz.zip'], [ozZip, 'oz.zip']])) {
    const out = await ms(
      `-i ${name} -filter ${JSON.stringify(sel)} -each "key='marine:'+ID; name=NAME; lat=LAT; lon=LON; wfo=WFO" ` +
        `-filter-fields key,name,lat,lon,wfo -clean allow-overlaps -simplify visvalingam interval=${TUNING.zonesIntervalM} keep-shapes -clean allow-overlaps ` +
        `-o format=geojson out.json`,
      { [name]: zip },
    );
    features.push(...JSON.parse(String(out['out.json'])).features);
  }
  features.sort((a, b) => (a.properties.key < b.properties.key ? -1 : 1));
  return features;
}

/** @param {unknown} v */
const ser = (v) => JSON.stringify(v) + '\n';

/**
 * @param {{ inputs: import('./10-fetch-inputs.mjs').PinnedInput[], def: import('./20-footprint.mjs').FootprintDef, regionsText: string }} p
 */
export async function buildZones({ inputs, def, regionsText }) {
  const stamp = stampFor(inputs, [...LAND_TYPES.map((t) => t.inputId), 'nws-coastal-marine-zones', 'nws-offshore-marine-zones', 'eccc-public-forecast-zones']);
  /** @type {Record<string, any>} */
  const layers = {};
  /** @type {Record<string, { keys: string[], measured: any[] }>} */
  const evidence = {};
  /** @type {Record<string, Buffer | string>} */
  const topoInputs = {};
  for (const lt of LAND_TYPES) {
    const zip = await readFile(inputPath(inputs, lt.inputId));
    const { keys, measured } = await landKeys({ zip, regionsText, def, lt });
    evidence[lt.type] = { keys, measured };
    const out = await ms(
      `-i in.zip -each ${JSON.stringify(`key='${lt.type}:'+${lt.codeExpr}; name=${lt.nameField}`)} ` +
        `-filter ${JSON.stringify(`${jsList(keys)}.includes(key)`)} -filter-fields key,name -sort key ` +
        `-clean allow-overlaps -simplify visvalingam interval=${TUNING.zonesIntervalM} keep-shapes -clean allow-overlaps -o format=geojson out.json`,
      { 'in.zip': zip },
    );
    layers[lt.type] = JSON.parse(String(out['out.json']));
    if (layers[lt.type].features.length !== keys.length) {
      throw new Error(`${lt.type}: expected ${keys.length} zones, kept ${layers[lt.type].features.length}`);
    }
  }
  const bands = coastBands(regionsText);
  const marineFeatures = await marineLayer({
    mzZip: await readFile(inputPath(inputs, 'nws-coastal-marine-zones')),
    ozZip: await readFile(inputPath(inputs, 'nws-offshore-marine-zones')),
    bands,
  });
  /** @type {Record<string, string>} */
  const marineToRegion = {};
  for (const f of marineFeatures) {
    const code = f.properties.key.slice('marine:'.length);
    marineToRegion[code] = f.properties.wfo === 'AJK' ? 'ak-se' : regionForMarine(f.properties.lat, bands);
    f.properties = { key: f.properties.key, name: f.properties.name };
  }
  layers.marine = { type: 'FeatureCollection', features: marineFeatures };
  evidence.marine = { keys: marineFeatures.map((f) => f.properties.key), measured: [] };

  // One TopoJSON: a single GeometryCollection "zones" whose geometry ids are the typed keys.
  const names = ['forecast', 'county', 'fire', 'marine'];
  for (const n of names) topoInputs[`${n}.json`] = JSON.stringify(layers[n]);
  const topo = await ms(
    `-i ${names.map((n) => `${n}.json`).join(' ')} combine-files -merge-layers target=* name=zones ` +
      `-o format=topojson quantization=${TUNING.zonesQuantization} id-field=key zones.topo.json`,
    topoInputs,
  );
  const zonesTopo = JSON.parse(String(topo['zones.topo.json']));

  // footprint-ugc.json
  const zones = names.flatMap((n) => /** @type {{ keys: string[] }} */ (evidence[n]).keys).sort();
  const wholeStates = new Set(def.states);
  const edgeCodes = [...new Set(zones
    .map((k) => k.split(':')[1] ?? '')
    .filter((code) => /^PKZ/.test(code) || (!/^PZZ/.test(code) && !wholeStates.has(code.slice(0, 2)))))].sort();
  const ugc = {
    schema: 'cthd.footprint-ugc/1',
    generatedAt: stamp,
    zones,
    edgeCodes,
    marineToRegion: Object.fromEntries(Object.entries(marineToRegion).sort(([a], [b]) => (a < b ? -1 : 1))),
  };

  // eccc-regions.topo.json
  const msc = await readFile(inputPath(inputs, 'eccc-public-forecast-zones'));
  const eccc = await ms(
    `-i msc.zip -filter "PROVINCE_C=='BC'" -each "id=CLC; name=NAME" -filter-fields id,name -sort id -rename-layers regions ` +
      `-clean -simplify visvalingam interval=${TUNING.ecccIntervalM} keep-shapes -clean ` +
      `-o format=topojson quantization=${TUNING.ecccQuantization} id-field=id eccc.topo.json`,
    { 'msc.zip': await extractMscLayer(msc) },
  );
  const ecccTopo = JSON.parse(String(eccc['eccc.topo.json']));
  return { zonesTopo, ugc, ecccTopo, evidence, marineFeatures };
}

/**
 * mapshaper reads a zip holding one shapefile; the MSC package holds hundreds, so the one layer is
 * extracted by name from the central directory with the standard library.
 * @param {Buffer} zip
 * @returns {Promise<Buffer>} a zip containing only land_PubStdZone_detail_unproj.*
 */
async function extractMscLayer(zip) {
  const { inflateRawSync } = await import('node:zlib');
  const want = /^land_PubStdZone_detail_unproj\.(shp|dbf|shx|prj|cpg)$/;
  /** @type {{ name: string, data: Buffer }[]} */
  const files = [];
  // Locate the end-of-central-directory record.
  let eocd = zip.length - 22;
  while (eocd >= 0 && zip.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  if (eocd < 0) throw new Error('not a zip file');
  const count = zip.readUInt16LE(eocd + 10);
  let p = zip.readUInt32LE(eocd + 16);
  for (let i = 0; i < count; i++) {
    if (zip.readUInt32LE(p) !== 0x02014b50) throw new Error('bad central directory');
    const method = zip.readUInt16LE(p + 10);
    const csize = zip.readUInt32LE(p + 20);
    const nlen = zip.readUInt16LE(p + 28);
    const elen = zip.readUInt16LE(p + 30);
    const clen = zip.readUInt16LE(p + 32);
    const local = zip.readUInt32LE(p + 42);
    const name = zip.toString('utf8', p + 46, p + 46 + nlen);
    p += 46 + nlen + elen + clen;
    if (!want.test(name)) continue;
    const lnlen = zip.readUInt16LE(local + 26);
    const lelen = zip.readUInt16LE(local + 28);
    const raw = zip.subarray(local + 30 + lnlen + lelen, local + 30 + lnlen + lelen + csize);
    files.push({ name, data: method === 8 ? inflateRawSync(raw) : Buffer.from(raw) });
  }
  if (files.length < 3) throw new Error('MSC layer land_PubStdZone_detail_unproj not found in the package');
  return buildStoredZip(files.sort((a, b) => (a.name < b.name ? -1 : 1)));
}

/** CRC-32 for the stored zip writer. */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
/** @param {Buffer} b */
function crc32(b) {
  let c = 0xffffffff;
  for (let i = 0; i < b.length; i++) c = (CRC_TABLE[(c ^ (b[i] ?? 0)) & 0xff] ?? 0) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * A minimal stored (uncompressed) zip, so mapshaper can open the extracted shapefile parts as one archive.
 * @param {{ name: string, data: Buffer }[]} files
 */
function buildStoredZip(files) {
  /** @type {Buffer[]} */
  const parts = [];
  /** @type {Buffer[]} */
  const central = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name);
    const crc = crc32(f.data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0, 6); lh.writeUInt16LE(0, 8);
    lh.writeUInt16LE(0, 10); lh.writeUInt16LE(0x21, 12); lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(f.data.length, 18); lh.writeUInt32LE(f.data.length, 22); lh.writeUInt16LE(name.length, 26); lh.writeUInt16LE(0, 28);
    parts.push(lh, name, f.data);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0, 8); ch.writeUInt16LE(0, 10);
    ch.writeUInt16LE(0, 12); ch.writeUInt16LE(0x21, 14); ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(f.data.length, 20);
    ch.writeUInt32LE(f.data.length, 24); ch.writeUInt16LE(name.length, 28); ch.writeUInt32LE(offset, 42);
    central.push(ch, name);
    offset += 30 + name.length + f.data.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cd, end]);
}

/** Radar sites within this great-circle distance of the footprint are kept (WSR-88D useful range is about 230 km). */
export const RADAR_RANGE_KM = 250;

/**
 * @param {number} lat1 @param {number} lon1 @param {number} lat2 @param {number} lon2
 */
export function haversineKm(lat1, lon1, lat2, lon2) {
  const rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad;
  const dLon = (lon2 - lon1) * rad;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371.0088 * Math.asin(Math.sqrt(a));
}

/**
 * NWS WSR-88D sites within RADAR_RANGE_KM of any footprint vertex, with the coordinates and API record the
 * NWS publishes for each. Environment and Climate Change Canada radar sites carry no machine-readable
 * coordinates in any ECCC open-data product, so none are listed (open item for lane L12).
 * @param {{ inputs: import('./10-fetch-inputs.mjs').PinnedInput[], regionsText: string }} p
 */
export async function buildRadar({ inputs, regionsText }) {
  /** @type {{ stations: { id: string, name: string, stationType: string, lon: number, lat: number }[] }} */
  const list = JSON.parse(await readFile(inputPath(inputs, 'nws-radar-stations'), 'utf8'));
  /** @type {[number, number][]} */
  const pts = [];
  /** @param {any} c */
  const walk = (c) => { if (typeof c[0] === 'number') pts.push([c[0], c[1]]); else c.forEach(walk); };
  for (const f of JSON.parse(regionsText).features) walk(f.geometry.coordinates);
  const sites = list.stations
    .filter((s) => s.stationType === 'WSR-88D')
    .filter((s) => pts.some(([lon, lat]) => Math.abs(lat - s.lat) < 3 && haversineKm(s.lat, s.lon, lat, lon) <= RADAR_RANGE_KM))
    .map((s) => ({
      id: s.id,
      agency: 'NWS',
      name: s.name,
      lat: Math.round(s.lat * 1e5) / 1e5,
      lon: Math.round(s.lon * 1e5) / 1e5,
      ridge: true,
      sourceUrl: `https://api.weather.gov/radar/stations/${s.id}`,
    }));
  return {
    schema: 'cthd.radar-sites/1',
    generatedAt: stampFor(inputs, ['nws-radar-stations']),
    sites,
  };
}

export async function main() {
  const inputs = await loadInputs();
  const def = await loadFootprintDef();
  const regionsText = await readFile(path.join(WORK_DIR, 'footprint-regions.json'), 'utf8').catch(() => {
    throw new Error('run scripts/reference/20-footprint.mjs first (it writes .cache/work/footprint-regions.json)');
  });
  const { zonesTopo, ugc, ecccTopo, evidence } = await buildZones({ inputs, def, regionsText });
  await mkdir(GEO_DIR, { recursive: true });
  await writeFile(path.join(GEO_DIR, 'nws-zones.topo.json'), ser(zonesTopo));
  await writeFile(path.join(GEO_DIR, 'footprint-ugc.json'), ser(ugc));
  await writeFile(path.join(GEO_DIR, 'eccc-regions.topo.json'), ser(ecccTopo));
  const radar = await buildRadar({ inputs, regionsText });
  await mkdir(path.join(GEO_DIR, '..', 'ref'), { recursive: true });
  await writeFile(path.join(GEO_DIR, '..', 'ref', 'radar-sites.json'), ser(radar));
  await mkdir(WORK_DIR, { recursive: true });
  await writeFile(path.join(WORK_DIR, 'zone-overlap-evidence.json'), JSON.stringify(evidence, null, 1));
  const counts = Object.entries(evidence).map(([k, v]) => `${k} ${v.keys.length}`).join(', ');
  console.log(`zones: ${counts}; nws-zones.topo.json ${ser(zonesTopo).length} bytes; eccc-regions.topo.json ${ser(ecccTopo).length} bytes; marineToRegion ${Object.keys(ugc.marineToRegion).length}; edgeCodes ${ugc.edgeCodes.length}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
