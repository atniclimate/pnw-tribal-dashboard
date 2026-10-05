// @ts-check
/**
 * Hazard categories from exact-name tables, then ordered fallback rules (blueprint 3.9). DOM-free.
 *
 * The exact-name tables are `site/data/ref/nws-event-categories.json` (every event in the NWS
 * `/alerts/types` list) and `eccc-event-categories.json` (ECCC alert names in English and French), built
 * by `scripts/reference/80-hazards.mjs` from these same rules plus human-reviewed overrides. Unknown names
 * fall through to `FALLBACK_RULES`, which run specific before general: wind chill and extreme cold before
 * wind; winter storm and ice storm before storm; coastal flood before flood.
 */

/** @typedef {import('../types.js').Agency} Agency */
/** @typedef {import('../types.js').HazardCategory} HazardCategory */
/** @typedef {{ nws: Record<string, HazardCategory[]>, eccc: Record<string, HazardCategory[]> }} CategoryTables */

/**
 * Ordered rules: the first matching rule decides the categories (first entry primary). English and the
 * French ECCC vocabulary observed in captures.
 * @type {ReadonlyArray<readonly [RegExp, readonly HazardCategory[]]>}
 */
export const FALLBACK_RULES = Object.freeze([
  [/tsunami/, ['tsunami']],
  [/avalanche/, ['avalanche']],
  [/volcan|ashfall|earthquake|séisme|tremblement de terre/, ['geologic']],
  [/debris flow|landslide|mudslide|glissement de terrain|coulée de débris/, ['rain-landslide']],
  [/evacuation|évacuation|shelter in place/, ['evacuation']],
  [/freezing spray|embruns verglaçants/, ['marine', 'cold']],
  [/hurricane force wind/, ['marine', 'wind']],
  [/wind chill|extreme cold|cold weather|arctic outflow|refroidissement éolien|froid extrême|froid|poussée d'air arctique/, ['cold']],
  [/winter storm|ice storm|blizzard|winter weather|snow squall|lake effect snow|snowfall|heavy snow|blowing snow|freezing rain|freezing drizzle|freezing fog|flash freeze|tempête hivernale|neige|pluie verglaçante|bruine verglaçante|poudrerie|gel éclair|brouillard verglaçant|\bsnow\b/, ['winter']],
  [/\bfreeze\b|\bfrost\b|\bgel\b/, ['cold']],
  [/coastal flood|lakeshore flood|storm surge|onde de tempête|inondation côtière|ondes de tempête/, ['coastal', 'flood']],
  [/high surf|beach hazard|rip current|sneaker wave|courants d'arrachement|vagues/, ['coastal']],
  [/flash flood|\bflood|hydrologic|inondation|crue/, ['flood']],
  [/rainfall|heavy rain|atmospheric river|\bpluie\b|\brain\b/, ['rain-landslide']],
  [/red flag|fire weather|fire danger|fire warning|risque d'incendie|feux de forêt/, ['fire']],
  [/dust storm|tempête de poussière/, ['smoke-air', 'wind']],
  [/smoke|air quality|air stagnation|blowing dust|\bdust\b|smog|qualité de l'air|fumée/, ['smoke-air']],
  [/heat|chaleur|humidex/, ['heat']],
  [/hurricane|typhoon|tropical storm|tropical cyclone|ouragan|tempête tropicale|cyclone tropical/, ['wind', 'coastal']],
  [/gale|small craft|special marine|\bstorm (warning|watch)$|coup de vent|petites embarcations/, ['marine', 'wind']],
  [/hazardous seas|marine weather|marine|maritime/, ['marine']],
  [/tornado|thunderstorm|severe weather statement|tornade|orage/, ['wind']],
  [/wind|\bvent\b|wreckhouse|suêtes|squall/, ['wind']],
]);

/**
 * Events that legitimately map to `other`: administrative, civil, and informational products with no
 * hazard category of their own. The coverage test fails on any captured event outside `other` that is
 * not listed here.
 * @type {ReadonlySet<string>}
 */
export const ALLOWED_OTHER = new Set([
  '911 telephone outage', 'administrative message', 'blue alert', 'child abduction emergency', 'civil danger warning',
  'civil emergency message', 'hazardous materials warning', 'hazardous weather outlook', 'law enforcement warning',
  'local area emergency', 'low water advisory', 'nuclear power plant warning', 'radiological hazard warning',
  'short term forecast', 'special weather statement', 'test', 'dense fog advisory', 'fog advisory',
  'bulletin météorologique spécial', 'avertissement de brouillard', 'fog warning', 'weather warning',
]);

/** @type {WeakMap<Record<string, HazardCategory[]>, Map<string, HazardCategory[]>>} */
const lowered = new WeakMap();

/**
 * Case-insensitive exact lookup in one agency table.
 * @param {Record<string, HazardCategory[]> | undefined} table
 * @param {string} name
 * @returns {HazardCategory[] | null}
 */
function exact(table, name) {
  if (!table) return null;
  let m = lowered.get(table);
  if (!m) {
    m = new Map();
    for (const [k, v] of Object.entries(table)) if (Array.isArray(v) && v.length > 0) m.set(normalizeName(k), v);
    lowered.set(table, m);
  }
  const hit = m.get(normalizeName(name));
  return hit ? [...hit] : null;
}

/**
 * Lowercase, trimmed, single-spaced, typographic apostrophes folded.
 * @param {string} name
 * @returns {string}
 */
export function normalizeName(name) {
  return String(name ?? '').toLowerCase().replace(/[‘’]/g, "'").replace(/\s+/g, ' ').trim();
}

/**
 * The fallback rules alone (no exact table). Exported for the reference builder.
 * @param {string} event
 * @returns {HazardCategory[]}
 */
export function categorizeByRules(event) {
  const e = normalizeName(event);
  for (const [re, cats] of FALLBACK_RULES) if (re.test(e)) return [...cats];
  return ['other'];
}

/**
 * First entry is primary; unknown names use fallback rules specific before general.
 * @param {string} event
 * @param {Agency} agency
 * @param {{ nws: Record<string, HazardCategory[]>, eccc: Record<string, HazardCategory[]> }} tables
 * @returns {HazardCategory[]}
 */
export function categorize(event, agency, tables) {
  const table = agency === 'nws' ? tables?.nws : agency === 'eccc' ? tables?.eccc : undefined;
  return exact(table, event) ?? categorizeByRules(event);
}

/**
 * Converts a `cthd.event-categories/1` reference file into the lookup table `categorize` takes.
 * @param {unknown} doc parsed nws-event-categories.json or eccc-event-categories.json
 * @returns {Record<string, HazardCategory[]>}
 */
export function tableFromReference(doc) {
  /** @type {Record<string, HazardCategory[]>} */
  const out = {};
  const events = doc && typeof doc === 'object' ? /** @type {{ events?: unknown }} */ (doc).events : null;
  if (!events || typeof events !== 'object') return out;
  for (const [name, row] of Object.entries(events)) {
    const cats = row && typeof row === 'object' ? /** @type {{ categories?: unknown }} */ (row).categories : null;
    if (Array.isArray(cats) && cats.length > 0) out[name] = /** @type {HazardCategory[]} */ (cats.filter((c) => typeof c === 'string'));
  }
  return out;
}

/**
 * Adds rain-landslide when an alert's own text names debris flows or landslides (blueprint 3.9), without
 * changing the primary category.
 * @param {HazardCategory[]} categories
 * @param {string} text headline, description, and NWSheadline joined
 * @returns {HazardCategory[]}
 */
export function withTextCategories(categories, text) {
  if (!/debris flow|landslide|mudslide|glissement de terrain|coulée de débris/i.test(text)) return categories;
  if (categories.includes('rain-landslide')) return categories;
  const base = categories.filter((c) => c !== 'other');
  return base.length === 0 ? ['rain-landslide'] : [...base, 'rain-landslide'];
}
