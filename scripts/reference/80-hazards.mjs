// @ts-check
/**
 * Reference step 80 (blueprint 3.9, 6.2): site/data/ref/nws-event-categories.json,
 * site/data/ref/eccc-event-categories.json, and site/data/ref/hazards.json.
 *
 *   node scripts/reference/80-hazards.mjs [--types <alerts-types.json>] [--out site/data/ref]
 *
 * The NWS table holds every event in `https://api.weather.gov/alerts/types` (fetched through
 * scripts/lib/http.mjs, or read from a saved response with --types). The ECCC table holds ECCC alert names
 * in English and, where a dated capture showed the French name, French. Each name maps through the same
 * ordered rules the browser uses (`categorizeByRules`), then `HUMAN_OVERRIDES`; `reviewed` is true only
 * for a name a person has checked and entered in `HUMAN_OVERRIDES`. Output is sorted and stamped with
 * the input's own time, so a re-run on the same input is byte-identical.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { categorizeByRules } from '../../site/static/js/alerts/categories.js';
import { designationOf } from '../../site/static/js/alerts/designation.js';

/** @typedef {import('../../site/static/js/types.js').HazardCategory} HazardCategory */
/** @typedef {import('../../site/static/js/types.js').Designation} Designation */
/** @typedef {{ categories: HazardCategory[], designation: Designation, reviewed: boolean }} EventRow */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const NWS_TYPES_URL = 'https://api.weather.gov/alerts/types';

/**
 * Person-reviewed corrections, keyed by agency and exact name. Empty until a reviewer enters one; each
 * entry needs the reviewer's role, the date, and the reason in `note`.
 * @type {Readonly<{ nws: Record<string, { categories: HazardCategory[], note: string }>, eccc: Record<string, { categories: HazardCategory[], note: string }> }>}
 */
export const HUMAN_OVERRIDES = Object.freeze({ nws: {}, eccc: {} });

/**
 * ECCC public alert names. English names follow ECCC's public weather alert program; French names are
 * listed only where a dated capture (tests/fixtures/upstream/eccc-geomet-weather-alerts/ or the CAST
 * fixtures) showed them, so no French name here is a guess.
 * @type {readonly string[]}
 */
export const ECCC_NAMES = Object.freeze([
  // English.
  'air quality warning', 'arctic outflow warning', 'blizzard warning', 'blowing snow advisory', 'dust storm warning',
  'extreme cold warning', 'flash freeze warning', 'fog advisory', 'freezing drizzle advisory', 'freezing rain warning',
  'frost advisory', 'heat warning', 'hurricane warning', 'hurricane watch', 'Les Suêtes wind warning', 'rainfall warning',
  'severe thunderstorm warning', 'severe thunderstorm watch', 'snow squall warning', 'snowfall warning',
  'special air quality statement', 'special weather statement', 'storm surge warning', 'tornado warning', 'tornado watch',
  'tropical storm warning', 'tropical storm watch', 'weather warning', 'wind warning', 'winter storm warning',
  'Wreckhouse wind warning',
  // French, as captured.
  "avertissement de blizzard", "avertissement de chaleur", "avertissement de pluie", "avertissement de qualité de l'air",
  'avertissement de vent', 'avertissement de vent Les Suêtes', 'avertissement de vent Wreckhouse',
  'bulletin météorologique spécial', "veille d'orages violents",
]);

/** Labels and Safety page anchors for each category (the Safety page, lane L13, uses these anchor ids). @type {Readonly<Record<HazardCategory, { label: string, safetyAnchor: string | null }>>} */
export const HAZARDS = Object.freeze({
  flood: { label: 'Flooding', safetyAnchor: 'flood' },
  coastal: { label: 'Coastal Hazards', safetyAnchor: 'coastal' },
  'rain-landslide': { label: 'Heavy Rain and Landslides', safetyAnchor: 'rain-landslide' },
  wind: { label: 'Wind and Storms', safetyAnchor: 'wind' },
  winter: { label: 'Snow and Ice', safetyAnchor: 'winter' },
  cold: { label: 'Extreme Cold', safetyAnchor: 'cold' },
  heat: { label: 'Extreme Heat', safetyAnchor: 'heat' },
  fire: { label: 'Fire Weather', safetyAnchor: 'fire' },
  'smoke-air': { label: 'Smoke and Air Quality', safetyAnchor: 'smoke-air' },
  marine: { label: 'Marine Hazards', safetyAnchor: 'marine' },
  tsunami: { label: 'Tsunami', safetyAnchor: 'tsunami' },
  avalanche: { label: 'Avalanche', safetyAnchor: 'avalanche' },
  geologic: { label: 'Earthquakes and Volcanoes', safetyAnchor: 'geologic' },
  evacuation: { label: 'Evacuation', safetyAnchor: 'evacuation' },
  other: { label: 'Other Hazards', safetyAnchor: null },
});

/**
 * @param {readonly string[]} names
 * @param {'nws' | 'eccc'} agency
 * @returns {Record<string, EventRow>}
 */
export function buildRows(names, agency) {
  /** @type {Record<string, EventRow>} */
  const events = {};
  const overrides = HUMAN_OVERRIDES[agency];
  for (const name of [...new Set(names)].sort((a, b) => a.localeCompare(b, 'en'))) {
    const o = Object.prototype.hasOwnProperty.call(overrides, name) ? overrides[name] : undefined;
    events[name] = {
      categories: o ? [...o.categories] : categorizeByRules(name),
      designation: designationOf(name, agency),
      reviewed: Boolean(o),
    };
  }
  return events;
}

/**
 * @param {unknown} typesDoc the /alerts/types response
 * @returns {string[]}
 */
export function eventTypesOf(typesDoc) {
  const list = typesDoc && typeof typesDoc === 'object' ? /** @type {{ eventTypes?: unknown }} */ (typesDoc).eventTypes : null;
  if (!Array.isArray(list) || list.length === 0) throw new Error('alerts/types response has no eventTypes');
  return list.filter((x) => typeof x === 'string' && x.trim() !== '').map((x) => x.trim());
}

/**
 * @param {{ typesDoc: unknown, typesAt: string }} input
 * @returns {Record<string, unknown>} file name to document
 */
export function buildHazardReference(input) {
  return {
    'nws-event-categories.json': {
      schema: 'cthd.event-categories/1',
      agency: 'nws',
      generatedAt: input.typesAt,
      sourceIds: ['nws-alert-types'],
      events: buildRows(eventTypesOf(input.typesDoc), 'nws'),
    },
    'eccc-event-categories.json': {
      schema: 'cthd.event-categories/1',
      agency: 'eccc',
      generatedAt: input.typesAt,
      sourceIds: ['eccc-geomet-weather-alerts'],
      events: buildRows(ECCC_NAMES, 'eccc'),
    },
    'hazards.json': { schema: 'cthd.hazards/1', categories: HAZARDS },
  };
}

async function main() {
  const { values } = parseArgs({ options: { types: { type: 'string' }, out: { type: 'string' } } });
  const out = path.resolve(ROOT, values.out ?? path.join('site', 'data', 'ref'));
  /** @type {unknown} */
  let typesDoc;
  /** @type {string} */
  let typesAt;
  if (values.types) {
    const file = path.resolve(values.types);
    typesDoc = JSON.parse(await readFile(file, 'utf8'));
    // A capture's sidecar records when it was taken; that time stamps the output.
    try {
      const meta = JSON.parse(await readFile(file.replace(/\.json$/, '.meta.json'), 'utf8'));
      typesAt = String(meta.capturedAt);
    } catch {
      throw new Error('--types needs its .meta.json sidecar (capturedAt) so the output is stamped with the input time');
    }
  } else {
    const { createHttp, loadSourceRegistry } = await import('../lib/http.mjs');
    const http = createHttp({ registry: await loadSourceRegistry(ROOT) });
    const res = await http.getJson('nws-alert-types', NWS_TYPES_URL);
    if (!res.ok) throw new Error(`alerts/types: ${res.error.kind} ${res.error.message}`);
    typesDoc = res.data;
    typesAt = res.fetchedAt;
  }
  const docs = buildHazardReference({ typesDoc, typesAt });
  await mkdir(out, { recursive: true });
  for (const [name, doc] of Object.entries(docs)) {
    await writeFile(path.join(out, name), `${JSON.stringify(doc, null, 2)}\n`, 'utf8');
    console.log(`wrote ${path.relative(ROOT, path.join(out, name))}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
