// @ts-check
/**
 * Reference step 20: the footprint and the outline layers (blueprint 6.2).
 *
 *   inputs   census-states-500k, census-counties-500k, emcr-regions, data/pipeline/footprint.yaml
 *   outputs  site/data/geo/footprint.json        the footprint, one dissolved feature per jurisdiction
 *            site/data/geo/outlines.topo.json    states, province, and footprint counties for the tile-free map
 *            site/data/geo/bc-regions.json       Emergency Management and Climate Readiness response regions
 *            .cache/work/footprint-regions.json  full-resolution regions for step 30 (never committed)
 *
 * The footprint is WA, OR, ID, BC, and the county and borough lists in footprint.yaml (draft until the
 * maintainer ratifies Q2). Output is deterministic: no wall-clock values, stamps come from input vintages.
 * Every geometry layer passes mapshaper -clean before export.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CORE_SCHEMA, load } from 'js-yaml';
import mapshaper from 'mapshaper';
import { ROOT, inputPath, loadInputs } from './10-fetch-inputs.mjs';

export const FOOTPRINT_FILE = path.join(ROOT, 'data', 'pipeline', 'footprint.yaml');
export const GEO_DIR = path.join(ROOT, 'site', 'data', 'geo');
export const WORK_DIR = path.join(ROOT, '.cache', 'work');

/** Region codes and display names (RegionCode in site/static/js/types.d.ts). */
export const REGIONS = /** @type {const} */ ({
  wa: 'Washington',
  or: 'Oregon',
  id: 'Idaho',
  bc: 'British Columbia',
  'ca-n': 'Northern California',
  'mt-w': 'Western Montana',
  'nv-n': 'Northern Nevada',
  'ak-se': 'Southeast Alaska',
});

/** Region code for each U.S. state in the footprint: whole states first, then the county-list states. */
export const STATE_REGION = /** @type {Record<string, keyof typeof REGIONS>} */ ({
  WA: 'wa', OR: 'or', ID: 'id', CA: 'ca-n', MT: 'mt-w', NV: 'nv-n', AK: 'ak-se',
});

/** Simplification intervals in meters (Visvalingam), and coordinate precision in degrees. */
export const TUNING = {
  footprintIntervalM: 800,
  footprintPrecision: 0.001,
  outlinesIntervalM: 1500,
  outlinesQuantization: 10000,
  bcRegionsIntervalM: 800,
  bcRegionsPrecision: 0.001,
};

/** The window the outline map covers: the footprint plus a margin, so neighboring states read as context. */
const OUTLINE_BBOX = [-142, 37.5, -108, 61];

/**
 * @typedef {{ ratified: boolean, ratifiedOn: string | null, states: string[], provinces: string[],
 *             counties: Record<string, string[]>, notes?: string }} FootprintDef
 */

/** @returns {Promise<FootprintDef>} */
export async function loadFootprintDef() {
  return /** @type {FootprintDef} */ (load(await readFile(FOOTPRINT_FILE, 'utf8'), { schema: CORE_SCHEMA }));
}

/**
 * ISO instant derived from input vintages: the latest vintage of the named inputs at 00:00:00Z.
 * @param {import('./10-fetch-inputs.mjs').PinnedInput[]} inputs
 * @param {string[]} ids
 */
export function stampFor(inputs, ids) {
  const vs = ids.map((id) => {
    const hit = inputs.find((i) => i.id === id);
    if (!hit) throw new Error(`input "${id}" is not pinned`);
    return hit.vintage;
  });
  return `${vs.sort().at(-1)}T00:00:00Z`;
}

/**
 * Run mapshaper commands over in-memory files.
 * @param {string} commands
 * @param {Record<string, Buffer | string>} files
 * @returns {Promise<Record<string, Buffer | string>>}
 */
export async function ms(commands, files) {
  return /** @type {Record<string, Buffer | string>} */ (await mapshaper.applyCommands(commands, files));
}

/** @param {unknown[]} list */
const jsList = (list) => JSON.stringify(list);

/**
 * Full-resolution region polygons: one feature per RegionCode, property `region`.
 * @param {{ statesZip: Buffer, countiesZip: Buffer, emcrJson: Buffer, def: FootprintDef }} p
 * @returns {Promise<string>} GeoJSON text
 */
export async function buildRegions({ statesZip, countiesZip, emcrJson, def }) {
  const regionOf = JSON.stringify(STATE_REGION);
  const parts = [];
  // Whole states.
  const stateOut = await ms(
    `-i states.zip -filter ${JSON.stringify(`${jsList(def.states)}.includes(STUSPS)`)} ` +
      `-each ${JSON.stringify(`region=${regionOf}[STUSPS]`)} -filter-fields region -o format=geojson states.json`,
    { 'states.zip': statesZip },
  );
  parts.push(['states.json', stateOut['states.json']]);
  // County-list states, dissolved per state.
  for (const [st, names] of Object.entries(def.counties)) {
    const out = await ms(
      `-i counties.zip -filter ${JSON.stringify(`STUSPS=='${st}' && ${jsList(names)}.includes(NAME)`)} ` +
        `-each ${JSON.stringify(`n=1`)} -dissolve n copy-fields=STUSPS ` +
        `-each ${JSON.stringify(`region=${regionOf}[STUSPS]`)} -filter-fields region -o format=geojson c-${st}.json`,
      { 'counties.zip': countiesZip },
    );
    const j = JSON.parse(String(out[`c-${st}.json`]));
    if (j.features.length !== 1) throw new Error(`county list for ${st} produced ${j.features.length} features`);
    parts.push([`c-${st}.json`, out[`c-${st}.json`]]);
  }
  // British Columbia: the whole province, the dissolved response regions.
  const bc = await ms(
    `-i emcr.json -each "n=1" -dissolve n -each "region='bc'" -filter-fields region -o format=geojson bc.json`,
    { 'emcr.json': emcrJson },
  );
  parts.push(['bc.json', bc['bc.json']]);
  const features = parts.flatMap(([, text]) => JSON.parse(String(text)).features);
  features.sort((/** @type {any} */ a, /** @type {any} */ b) => (a.properties.region < b.properties.region ? -1 : 1));
  return JSON.stringify({ type: 'FeatureCollection', features });
}

/** @param {any} f */
function describeRegion(f) {
  const code = /** @type {keyof typeof REGIONS} */ (f.properties.region);
  return { region: code, name: REGIONS[code] };
}

/**
 * @param {{ inputs: import('./10-fetch-inputs.mjs').PinnedInput[], def: FootprintDef }} p
 */
export async function buildFootprint({ inputs, def }) {
  const statesZip = await readFile(inputPath(inputs, 'census-states-500k'));
  const countiesZip = await readFile(inputPath(inputs, 'census-counties-500k'));
  const emcrJson = await readFile(inputPath(inputs, 'emcr-regions'));
  const stamp = stampFor(inputs, ['census-states-500k', 'census-counties-500k', 'emcr-regions']);

  const regionsText = await buildRegions({ statesZip, countiesZip, emcrJson, def });
  const regions = JSON.parse(regionsText);
  if (regions.features.length !== Object.keys(REGIONS).length) {
    throw new Error(`expected ${Object.keys(REGIONS).length} regions, got ${regions.features.length}`);
  }

  // footprint.json: simplified, cleaned, three-decimal coordinates, one feature per region.
  const fp = await ms(
    `-i regions.json -clean -simplify visvalingam interval=${TUNING.footprintIntervalM} keep-shapes ` +
      `-clean -o format=geojson precision=${TUNING.footprintPrecision} fp.json`,
    { 'regions.json': regionsText },
  );
  const fpJson = JSON.parse(String(fp['fp.json']));
  for (const f of fpJson.features) f.properties = { ...describeRegion(f), ratified: def.ratified };
  const footprint = {
    type: 'FeatureCollection',
    ratified: def.ratified,
    generatedAt: stamp,
    sources: ['census-cartographic-boundaries', 'emcr-bc-boundaries'],
    features: fpJson.features,
  };

  // outlines.topo.json: states (clipped to the outline window), province, and footprint counties.
  const bboxArg = OUTLINE_BBOX.join(',');
  const outStates = await ms(
    `-i states.zip -filter "['WA','OR','ID','CA','MT','NV','AK','UT','WY'].includes(STUSPS)" ` +
      `-each "id=STUSPS; name=NAME" -filter-fields id,name -clip bbox=${bboxArg} -clean ` +
      `-simplify visvalingam interval=${TUNING.outlinesIntervalM} keep-shapes -clean -o format=geojson st.json`,
    { 'states.zip': statesZip },
  );
  const outCounties = await ms(
    `-i counties.zip -filter ${JSON.stringify(
      Object.entries(def.counties).map(([st, ns]) => `(STUSPS=='${st}' && ${jsList(ns)}.includes(NAME))`).join(' || '),
    )} -each "id=GEOID; name=NAME; state=STUSPS" -filter-fields id,name,state -sort id ` +
      `-clip bbox=${bboxArg} -clean -simplify visvalingam interval=${TUNING.outlinesIntervalM} keep-shapes -clean -o format=geojson co.json`,
    { 'counties.zip': countiesZip },
  );
  const matched = JSON.parse(String(outCounties['co.json'])).features;
  for (const [st, names] of Object.entries(def.counties)) {
    const got = matched.filter((/** @type {any} */ f) => f.properties.state === st).map((/** @type {any} */ f) => f.properties.name);
    const missing = names.filter((n) => !got.includes(n));
    if (missing.length) throw new Error(`footprint.yaml names ${st} counties not found in the Census file: ${missing.join(', ')}`);
  }
  const outBc = await ms(
    `-i emcr.json -each "n=1" -dissolve n -each "id='BC'; name='British Columbia'" -filter-fields id,name -clean ` +
      `-simplify visvalingam interval=${TUNING.outlinesIntervalM} keep-shapes -clean -o format=geojson bc.json`,
    { 'emcr.json': emcrJson },
  );
  const topo = await ms(
    `-i st.json co.json bc.json combine-files -rename-layers states,counties,province ` +
      `-o format=topojson quantization=${TUNING.outlinesQuantization} target=* outlines.topo.json`,
    { 'st.json': /** @type {string} */ (outStates['st.json']), 'co.json': /** @type {string} */ (outCounties['co.json']), 'bc.json': /** @type {string} */ (outBc['bc.json']) },
  );
  const outlines = JSON.parse(String(topo['outlines.topo.json']));

  // bc-regions.json: the response regions as GeoJSON.
  const bcr = await ms(
    `-i emcr.json -each "regionNumber=REGION_NUMBER; name=REGION_NAME" -filter-fields regionNumber,name -sort regionNumber ` +
      `-clean -simplify visvalingam interval=${TUNING.bcRegionsIntervalM} keep-shapes -clean ` +
      `-o format=geojson precision=${TUNING.bcRegionsPrecision} bcr.json`,
    { 'emcr.json': emcrJson },
  );
  const bcRegionsJson = JSON.parse(String(bcr['bcr.json']));
  for (const f of bcRegionsJson.features) {
    f.properties = { ...f.properties, source: 'emcr-bc-boundaries', vintage: inputs.find((i) => i.id === 'emcr-regions')?.vintage };
  }
  const bcRegions = {
    type: 'FeatureCollection',
    generatedAt: stamp,
    sources: ['emcr-bc-boundaries'],
    features: bcRegionsJson.features,
  };
  return { regionsText, footprint, outlines, bcRegions };
}

/** @param {unknown} v */
const ser = (v) => JSON.stringify(v) + '\n';

export async function main() {
  const inputs = await loadInputs();
  const def = await loadFootprintDef();
  const { regionsText, footprint, outlines, bcRegions } = await buildFootprint({ inputs, def });
  await mkdir(GEO_DIR, { recursive: true });
  await mkdir(WORK_DIR, { recursive: true });
  await writeFile(path.join(WORK_DIR, 'footprint-regions.json'), regionsText);
  await writeFile(path.join(GEO_DIR, 'footprint.json'), ser(footprint));
  await writeFile(path.join(GEO_DIR, 'outlines.topo.json'), ser(outlines));
  await writeFile(path.join(GEO_DIR, 'bc-regions.json'), ser(bcRegions));
  console.log(`footprint.json ${ser(footprint).length} bytes, outlines.topo.json ${ser(outlines).length} bytes, bc-regions.json ${ser(bcRegions).length} bytes (ratified: ${def.ratified})`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
