// @ts-check
/**
 * Compiled resources (blueprint 5.6, 7.5). DOM-free. Evergreen links first; seasonal items only in season.
 * Event-specific items never appear here (they live in the Event Archive).
 */
import { fetchLocal } from '../core/net.js';
import { SITE_BASE_PATH } from '../config/pages.js';

/** @typedef {import('../types.js').Resource} Resource */
/** @typedef {import('../types.js').FetchOptions} FetchOptions */
/** @typedef {import('../types.js').NetResult} NetResult */
/** @typedef {{ schema: string, generatedAt: string, items: Resource[] }} ResourcesDoc */
/**
 * @typedef {{ ok: true, doc: ResourcesDoc, origin: 'network' | 'cache', dropped: number }
 *   | { ok: false, error: import('../types.js').NetError }} ResourcesLoad
 */

export const RESOURCES_PATH = 'data/curated/resources.json';
export const RESOURCES_SCHEMA = 'cthd.curated.resources/1';

/** Category order and labels (blueprint 5.6). */
export const CATEGORY_LABELS = Object.freeze(/** @type {Record<string, string>} */ ({
  'alerts-signup': 'Alert Sign-Ups',
  shelter: 'Shelter and Emergency Help',
  evacuation: 'Evacuation Information',
  roads: 'Roads and Travel',
  rivers: 'Rivers and Flood Information',
  'tribal-government': 'Tribal Government',
  recovery: 'Recovery',
  'financial-assistance': 'Financial Assistance',
  health: 'Health',
  volunteer: 'Volunteer',
  preparedness: 'Preparedness',
  'forecast-office': 'Forecast Offices',
}));

/** Hazard labels; tests/unit/data/resources.test.mjs keeps these equal to data/ref/hazards.json. */
export const HAZARD_LABELS = Object.freeze(/** @type {Record<string, string>} */ ({
  flood: 'Flooding',
  coastal: 'Coastal Hazards',
  'rain-landslide': 'Heavy Rain and Landslides',
  wind: 'Wind and Storms',
  winter: 'Snow and Ice',
  cold: 'Extreme Cold',
  heat: 'Extreme Heat',
  fire: 'Fire Weather',
  'smoke-air': 'Smoke and Air Quality',
  marine: 'Marine Hazards',
  tsunami: 'Tsunami',
  avalanche: 'Avalanche',
  geologic: 'Earthquakes and Volcanoes',
  evacuation: 'Evacuation',
  other: 'Other Hazards',
}));

/** Jurisdiction chips of the hub: states, then British Columbia (blueprint 7.5). */
export const RESOURCE_REGIONS = Object.freeze([
  { value: 'WA', label: 'Washington' },
  { value: 'OR', label: 'Oregon' },
  { value: 'ID', label: 'Idaho' },
  { value: 'CA', label: 'Northern California' },
  { value: 'MT', label: 'Western Montana' },
  { value: 'NV', label: 'Northern Nevada' },
  { value: 'AK', label: 'Southeast Alaska' },
  { value: 'BC', label: 'British Columbia' },
]);

const MS_DAY = 86_400_000;

/**
 * @param {string} day
 * @returns {number}
 */
function dayMs(day) {
  return /^\d{4}-\d{2}-\d{2}/.test(day) ? Date.parse(`${day.slice(0, 10)}T00:00:00Z`) : NaN;
}

/**
 * @param {unknown} v
 * @returns {v is Resource}
 */
function isResource(v) {
  if (typeof v !== 'object' || v === null) return false;
  const r = /** @type {Record<string, any>} */ (v);
  return typeof r.id === 'string' && typeof r.title === 'string' && typeof r.url === 'string' && typeof r.publisher === 'string'
    && typeof r.category === 'string' && Array.isArray(r.hazards) && typeof r.scope === 'object' && r.scope !== null
    && (r.status === 'evergreen' || r.status === 'seasonal') && typeof r.verifiedAt === 'string' && typeof r.sourceUrl === 'string';
}

/**
 * @param {unknown} data
 * @returns {{ doc: ResourcesDoc, dropped: number } | null}
 */
export function readResourcesDoc(data) {
  if (typeof data !== 'object' || data === null) return null;
  const d = /** @type {Record<string, unknown>} */ (data);
  if (d.schema !== RESOURCES_SCHEMA || !Array.isArray(d.items) || typeof d.generatedAt !== 'string') return null;
  const items = d.items.filter(isResource);
  return { doc: { schema: d.schema, generatedAt: d.generatedAt, items }, dropped: d.items.length - items.length };
}

/**
 * @param {string} path
 * @returns {Promise<unknown | null>}
 */
async function savedCopy(path) {
  try {
    const store = globalThis.caches;
    if (!store || !globalThis.location) return null;
    const hit = await store.match(new URL(`${SITE_BASE_PATH}${path}`, globalThis.location.href).href);
    return hit ? await hit.json() : null;
  } catch {
    return null;
  }
}

/**
 * The compiled resources with their compile stamp; a failed network read falls back to the saved copy.
 * @param {{ signal?: AbortSignal, deps?: { fetchLocal?: (path: string, opts?: FetchOptions) => Promise<NetResult>, savedCopy?: (path: string) => Promise<unknown | null> } }} [opts]
 * @returns {Promise<ResourcesLoad>}
 */
export async function loadResourcesDoc(opts) {
  const get = opts?.deps?.fetchLocal ?? fetchLocal;
  const saved = opts?.deps?.savedCopy ?? savedCopy;
  const res = await get(RESOURCES_PATH, opts?.signal ? { signal: opts.signal } : {});
  if (res.ok) {
    const read = readResourcesDoc(res.data);
    if (!read) return { ok: false, error: { kind: 'parse', message: 'The resources file has an unexpected format' } };
    return { ok: true, doc: read.doc, origin: 'network', dropped: read.dropped };
  }
  if (res.error.kind === 'aborted') return { ok: false, error: res.error };
  const copy = readResourcesDoc(await saved(RESOURCES_PATH));
  if (copy) return { ok: true, doc: copy.doc, origin: 'cache', dropped: copy.dropped };
  return { ok: false, error: res.error };
}

/**
 * data/curated/resources.json.
 * @param {{ signal?: AbortSignal }} [opts]
 * @returns {Promise<import('../types.js').NetResult<Resource[]>>}
 */
export async function loadResources(opts) {
  const res = await loadResourcesDoc(opts);
  const fetchedAt = new Date().toISOString();
  if (!res.ok) return { ok: false, error: res.error, fetchedAt, sourceId: 'cthd-resources' };
  return { ok: true, data: res.doc.items, status: 200, fetchedAt, lastModified: res.doc.generatedAt, sourceId: 'cthd-resources' };
}

/**
 * A seasonal item shows only between validFrom and validUntil (inclusive, by day); an evergreen item always
 * shows. A seasonal item with no readable window never shows.
 * @param {Resource} item
 * @param {Date} now
 * @returns {boolean}
 */
export function inSeason(item, now) {
  if (item.status === 'evergreen') return true;
  const from = dayMs(item.validFrom ?? '');
  const until = dayMs(item.validUntil ?? '');
  if (Number.isNaN(from) || Number.isNaN(until)) return false;
  return now.getTime() >= from && now.getTime() < until + MS_DAY;
}

/**
 * @param {string} text
 * @returns {string}
 */
function fold(text) {
  return String(text).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[‘’ʼ'`]/g, '').replace(/\s+/g, ' ').trim();
}

const CATEGORY_ORDER = Object.keys(CATEGORY_LABELS);

/**
 * @typedef {{ region?: string[], category?: string[], hazard?: string[], nationId?: string | null, q?: string, nationRegions?: string[] }} ResourceFilters
 *   `nationRegions` (directory codes of the chosen Nation's jurisdictions) lets a Nation selection include the
 *   state and provincial items for its own jurisdictions as well as items tagged to the Nation.
 */

/**
 * Evergreen first; seasonal items only in season. A federal item matches every jurisdiction. With a Nation
 * selected, the Nation's own items, federal items, and items for the Nation's jurisdictions match.
 * @param {Resource[]} items
 * @param {ResourceFilters} filters
 * @param {Date} now
 * @returns {Resource[]}
 */
export function filterResources(items, filters, now) {
  const q = fold(filters.q ?? '');
  const region = filters.region ?? [];
  const category = filters.category ?? [];
  const hazard = filters.hazard ?? [];
  const out = items.filter((r) => {
    if (!inSeason(r, now)) return false;
    if (region.length && r.scope.level !== 'federal' && !(r.scope.region !== null && region.includes(r.scope.region))) return false;
    if (category.length && !category.includes(r.category)) return false;
    if (hazard.length && !r.hazards.some((h) => hazard.includes(h))) return false;
    if (filters.nationId) {
      const own = r.nationId === filters.nationId;
      const shared = r.nationId === null && (r.scope.level === 'federal' || (r.scope.region !== null && (filters.nationRegions ?? []).includes(r.scope.region)));
      if (!own && !shared) return false;
    }
    if (q) {
      const hay = fold(`${r.title} ${r.publisher} ${r.description} ${CATEGORY_LABELS[r.category] ?? r.category} ${r.scope.region ?? ''} ${r.hazards.map((h) => HAZARD_LABELS[h] ?? h).join(' ')}`);
      if (!q.split(' ').every((w) => hay.includes(w))) return false;
    }
    return true;
  });
  return out.sort((a, b) => Number(a.status === 'seasonal') - Number(b.status === 'seasonal')
    || CATEGORY_ORDER.indexOf(a.category) - CATEGORY_ORDER.indexOf(b.category)
    || a.title.localeCompare(b.title, 'en'));
}

/**
 * The sentence that names the active filter, printed and copied with every list.
 * @param {{ q?: string, region?: string[], category?: string[], hazard?: string[], nationName?: string | null, shown: number, total: number }} f
 * @returns {string}
 */
export function resourceFilterNote(f) {
  const parts = [];
  if (f.nationName) parts.push(`Nation: ${f.nationName}`);
  if (f.region?.length) parts.push(`Jurisdiction: ${f.region.map((v) => RESOURCE_REGIONS.find((x) => x.value === v)?.label ?? v).join(', ')}`);
  if (f.category?.length) parts.push(`Category: ${f.category.map((v) => CATEGORY_LABELS[v] ?? v).join(', ')}`);
  if (f.hazard?.length) parts.push(`Hazard: ${f.hazard.map((v) => HAZARD_LABELS[v] ?? v).join(', ')}`);
  if (f.q && f.q.trim()) parts.push(`Search: "${f.q.trim()}"`);
  const scope = parts.length ? `Filter: ${parts.join('; ')}.` : 'Filter: none (all resources).';
  return `${scope} ${f.shown} of ${f.total} resources.`;
}

/**
 * One plain-text line per resource, for Copy List.
 * @param {Resource} r
 * @returns {string}
 */
export function resourceLine(r) {
  const verified = /^(\d{4})-(\d{2})-(\d{2})/.exec(r.verifiedAt);
  const bits = [r.title, r.publisher];
  if (r.phone) bits.push(r.phone);
  bits.push(r.url);
  bits.push(`Verified ${verified ? `${verified[2]}/${verified[3]}/${verified[1]}` : 'date unknown'}`);
  return bits.join(' | ');
}
