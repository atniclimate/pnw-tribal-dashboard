// @ts-check
/**
 * Reference step 60 (blueprint 6.2): site/data/ref/gauges.json and site/data/ref/wsc-stations.json.
 *
 *   node scripts/reference/60-gauges.mjs [--out site/data/ref]
 *
 * NWPS gauges by tiled footprint bounding boxes; /gauges/{lid} for the official thresholds (concurrency four,
 * 250 ms between request starts); active real-time British Columbia stations from ECCC; reviewed corrections
 * from data/registry/gauges-overrides.yaml. Thresholds are copied verbatim with the retrieval date; -9999 becomes
 * null and stays null. No category is computed anywhere. Nation joins (nationIds) belong to step 70.
 *
 * `buildGauges` takes the HTTP client as a parameter (the SnapshotHttp shape of scripts/lib/http.mjs) so it runs
 * against fixtures in tests; the command line entry loads the shared client from scripts/lib/http.mjs.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { STATE_REGIONS, normalizeNwpsGauge } from '../../site/static/js/hydro/nwps.js';
import { normalizeWscStations } from '../../site/static/js/hydro/wsc.js';
import { FOOTPRINT_TILES, nwpsBboxUrl, nwpsDetailUrl } from '../snapshot/tasks/gauges.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
/** Human-page and image patterns written into the reference (the registry holds the image template too). */
export const LINK_TEMPLATES = Object.freeze({
  hydrograph: 'https://water.noaa.gov/resources/hydrographs/{lid}_hg.png',
  nwps: 'https://water.noaa.gov/gauges/{lid}',
  usgs: 'https://waterdata.usgs.gov/monitoring-location/USGS-{usgsId}/',
});
export const WATEROFFICE_TEMPLATE = 'https://wateroffice.ec.gc.ca/report/real_time_e.html?stn={station}';
export const STATIONS_URL = 'https://api.weather.gc.ca/collections/hydrometric-stations/items?f=json&limit=1000&PROV_TERR_STATE_LOC=BC&STATUS_EN=Active&REAL_TIME=1';

/** Maximum share of gauge detail requests that may fail before the build refuses to write. */
export const MAX_DETAIL_FAILURE_RATE = 0.02;

/**
 * @typedef {import('../../site/static/js/types.js').Gauge} Gauge
 * @typedef {{ gaugeId: string, action: 'add' | 'remove' | 'replace', replaces?: string | null, nationIds?: string[], note: string, sourceUrl: string }} GaugeOverride
 * @typedef {{ getJson(sourceId: string, url: string, opts?: { timeoutMs?: number }): Promise<import('../../site/static/js/types.js').NetResult> }} Http
 */

/**
 * @param {number} ms
 * @returns {Promise<void>}
 */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Runs `worker` over `items` with a concurrency cap and a minimum gap between request starts.
 * @template T, R
 * @param {T[]} items
 * @param {number} concurrency
 * @param {number} spacingMs
 * @param {(item: T) => Promise<R>} worker
 * @returns {Promise<R[]>}
 */
async function pool(items, concurrency, spacingMs, worker) {
  /** @type {R[]} */
  const results = new Array(items.length);
  let next = 0;
  let nextStart = 0;
  const run = async () => {
    while (next < items.length) {
      const i = next;
      next += 1;
      const wait = nextStart - Date.now();
      nextStart = Math.max(nextStart, Date.now()) + spacingMs;
      if (wait > 0) await sleep(wait);
      results[i] = await worker(/** @type {T} */ (items[i]));
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, run));
  return results;
}

/**
 * @param {{ http: Http, now: Date, overrides: GaugeOverride[], spacingMs?: number, concurrency?: number,
 *   log?: (message: string) => void }} opts
 * @returns {Promise<{ gauges: { schema: string, generatedAt: string, sourceIds: string[], gauges: Gauge[] },
 *   wsc: { schema: string, generatedAt: string, sourceIds: string[], stations: ReturnType<typeof normalizeWscStations> },
 *   report: { listed: number, inFootprint: number, detailFailed: string[], dischargePseudoPoints: string[],
 *     curated: string[], noThresholds: number, wscStations: number } }>}
 */
export async function buildGauges(opts) {
  const log = opts.log ?? (() => {});
  const retrievedAt = opts.now.toISOString();

  // 1. Tiles: the union of the bbox lists, restricted to footprint states, deduplicated by lid.
  /** @type {Map<string, { lid: string, state: string }>} */
  const listed = new Map();
  for (const tile of FOOTPRINT_TILES) {
    const res = await opts.http.getJson('nwps-gauges', nwpsBboxUrl(tile), { timeoutMs: 60000 });
    if (!res.ok) throw new Error(`NWPS tile ${JSON.stringify(tile)} failed: ${res.error.kind} ${res.error.message}`);
    const list = /** @type {{ gauges?: { lid?: string, state?: { abbreviation?: string } }[] }} */ (res.data).gauges;
    if (!Array.isArray(list)) throw new Error('NWPS tile response has no gauges array');
    for (const g of list) {
      if (typeof g.lid === 'string' && typeof g.state?.abbreviation === 'string') {
        listed.set(g.lid.toUpperCase(), { lid: g.lid.toUpperCase(), state: g.state.abbreviation });
      }
    }
  }
  const inFootprint = [...listed.values()].filter((g) => Object.prototype.hasOwnProperty.call(STATE_REGIONS, g.state));
  log(`NWPS list: ${listed.size} gauges, ${inFootprint.length} in WA, OR, and ID`);

  // Reviewed additions that the tiles did not return are fetched too.
  const wantedLids = new Set(inFootprint.map((g) => g.lid));
  for (const o of opts.overrides) {
    if (o.action !== 'remove') wantedLids.add(o.gaugeId.slice(5));
  }

  // 2. Detail per gauge for the official thresholds.
  /** @type {string[]} */
  const detailFailed = [];
  const lids = [...wantedLids].sort();
  const details = await pool(lids, opts.concurrency ?? 4, opts.spacingMs ?? 250, async (lid) => {
    const res = await opts.http.getJson('nwps-gauges', nwpsDetailUrl(lid), { timeoutMs: 60000 });
    if (!res.ok) { detailFailed.push(`${lid} (${res.error.kind})`); return null; }
    try { return normalizeNwpsGauge(res.data, { retrievedAt, templates: LINK_TEMPLATES }); } catch (e) { detailFailed.push(`${lid} (${/** @type {Error} */ (e).message})`); return null; }
  });
  if (detailFailed.length / Math.max(1, lids.length) > MAX_DETAIL_FAILURE_RATE) {
    throw new Error(`${detailFailed.length} of ${lids.length} gauge detail requests failed; refusing to write a partial reference: ${detailFailed.slice(0, 5).join(', ')}`);
  }
  /** @type {Gauge[]} */
  let gauges = /** @type {Gauge[]} */ (details.filter((g) => g !== null));

  // 3. A discharge pseudo-point (name ends " - Discharge") that shares a USGS site with a stage gauge is dropped
  // (CRNZ1 against CRNW1); the stage gauge carries the thresholds.
  const stageUsgs = new Set(gauges.filter((g) => !/ - Discharge$/i.test(g.name) && g.usgsId).map((g) => g.usgsId));
  const dischargePseudoPoints = gauges.filter((g) => / - Discharge$/i.test(g.name) && g.usgsId && stageUsgs.has(g.usgsId)).map((g) => g.id);
  gauges = gauges.filter((g) => !dischargePseudoPoints.includes(g.id));

  // 4. Reviewed overrides: curated selection; remove drops; a missing target is an error.
  const byId = new Map(gauges.map((g) => [g.id, g]));
  /** @type {string[]} */
  const curated = [];
  for (const o of opts.overrides) {
    if (o.action === 'remove') { byId.delete(o.gaugeId); continue; }
    const g = byId.get(o.gaugeId);
    if (!g) throw new Error(`override ${o.gaugeId}: gauge not found in NWPS detail (${o.action})`);
    g.selection = 'curated';
    if (Array.isArray(o.nationIds) && o.nationIds.length > 0) g.nationIds = [...new Set([...g.nationIds, ...o.nationIds])].sort();
    curated.push(g.id);
  }
  gauges = [...byId.values()].sort((a, b) => (a.id < b.id ? -1 : 1));

  // 5. Water Survey of Canada stations.
  const st = await opts.http.getJson('eccc-hydrometric-stations', STATIONS_URL, { timeoutMs: 60000 });
  if (!st.ok) throw new Error(`ECCC stations failed: ${st.error.kind} ${st.error.message}`);
  const stations = normalizeWscStations(st.data, { wateroffice: WATEROFFICE_TEMPLATE });
  log(`ECCC stations: ${stations.length}`);

  return {
    gauges: { schema: 'cthd.gauges/1', generatedAt: retrievedAt, sourceIds: ['nwps-gauges'], gauges },
    wsc: { schema: 'cthd.wsc-stations/1', generatedAt: retrievedAt, sourceIds: ['eccc-hydrometric-stations'], stations },
    report: {
      listed: listed.size, inFootprint: inFootprint.length, detailFailed, dischargePseudoPoints, curated,
      noThresholds: gauges.filter((g) => g.stages && g.stages.action === null && g.stages.minor === null && g.stages.moderate === null && g.stages.major === null).length,
      wscStations: stations.length,
    },
  };
}

/**
 * One record per line, so a monthly reference pull request reads as a reviewable diff.
 * @param {Record<string, unknown>} doc
 * @param {string} listKey
 * @returns {string}
 */
export function serializeReference(doc, listKey) {
  const { [listKey]: list, ...head } = doc;
  const headJson = JSON.stringify(head).slice(0, -1);
  return `${headJson},${JSON.stringify(listKey)}:[\n${/** @type {unknown[]} */ (list).map((r) => JSON.stringify(r)).join(',\n')}\n]}\n`;
}

/** @param {string[]} argv */
async function main(argv) {
  const outIdx = argv.indexOf('--out');
  const outDir = path.resolve(ROOT, (outIdx >= 0 ? argv[outIdx + 1] : undefined) ?? 'site/data/ref');
  const { parseDataFile, loadAjv, SCHEMA_BASE } = await import('../check/lib/data-files.mjs');
  /** @type {{ createHttp?: () => Http }} */
  let httpModule;
  try { httpModule = await import(pathToFileURL(path.join(ROOT, 'scripts', 'lib', 'http.mjs')).href); } catch { httpModule = {}; }
  if (typeof httpModule.createHttp !== 'function') {
    throw new Error('scripts/lib/http.mjs (lane L9) does not export createHttp yet; the reference build needs the shared Node HTTP client.');
  }
  const overrides = /** @type {GaugeOverride[]} */ (await parseDataFile('data/registry/gauges-overrides.yaml'));
  const out = await buildGauges({ http: httpModule.createHttp(), now: new Date(), overrides, log: (m) => process.stdout.write(`${m}\n`) });
  const ajv = await loadAjv();
  for (const [file, doc] of [['gauges', out.gauges], ['wsc-stations', out.wsc]]) {
    const validate = ajv.getSchema(`${SCHEMA_BASE}${file}.schema.json`);
    if (!validate || !validate(doc)) throw new Error(`${file}.json fails its schema: ${JSON.stringify(validate?.errors?.slice(0, 3))}`);
  }
  await mkdir(outDir, { recursive: true });
  await writeFile(path.join(outDir, 'gauges.json'), serializeReference(out.gauges, 'gauges'));
  await writeFile(path.join(outDir, 'wsc-stations.json'), serializeReference(out.wsc, 'stations'));
  process.stdout.write(`${JSON.stringify(out.report)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((e) => { process.stderr.write(`${e.message}\n`); process.exitCode = 1; });
}
