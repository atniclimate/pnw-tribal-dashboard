// @ts-check
/**
 * Compiled contacts: loading, ordering, filtering, and Nation scoping (blueprint 5.3, 7.4). DOM-free.
 *
 * Contacts are role-based lines compiled from data/contacts/*.csv into data/curated/contacts.json. Every
 * line carries its source and verification date; this module never invents, guesses, or rewrites a number.
 * A Nation with no line on file gets the honest notice (NO_VERIFIED_NOTICE), never filler.
 */
import { fetchLocal } from '../core/net.js';
import { SITE_BASE_PATH } from '../config/pages.js';
import { haversineKm, pointInGeometry } from '../core/geo.js';

/** @typedef {import('../types.js').NationRecord} NationRecord */
/** @typedef {import('../types.js').NationIndexEntry} NationIndexEntry */
/** @typedef {import('../types.js').Contact} Contact */
/** @typedef {import('../types.js').FetchOptions} FetchOptions */
/** @typedef {import('../types.js').NetResult} NetResult */
/** @typedef {Pick<NationRecord, 'id' | 'jurisdictions'> & { nws?: { countyZones: string[] } | null }} NationLike */
/**
 * @typedef {{
 *   schema: string, generatedAt: string, items: Contact[],
 * }} ContactsDoc
 */
/**
 * @typedef {{
 *   ok: true, doc: ContactsDoc, origin: 'network' | 'cache', dropped: number,
 * } | { ok: false, error: import('../types.js').NetError }} ContactsLoad
 */

export const CONTACTS_PATH = 'data/curated/contacts.json';
export const NATION_INDEX_PATH = 'data/registry/nations-index.json';
export const CONTACTS_SCHEMA = 'cthd.curated.contacts/1';

/** Shown for a Nation that has no contact row (blueprint 5.3). */
export const NO_VERIFIED_NOTICE = 'No verified emergency contact is on file for this Nation yet.';
/** Shown beside lines served from the offline copy (blueprint 7.4). */
export const OFFLINE_NOTICE = 'Saved for offline use; contacts verified as listed.';

/** Jurisdiction chips of the directory, in display order. */
export const JURISDICTIONS = Object.freeze([
  { value: 'WA', label: 'Washington' },
  { value: 'OR', label: 'Oregon' },
  { value: 'ID', label: 'Idaho' },
  { value: 'CA', label: 'Northern California' },
  { value: 'MT', label: 'Western Montana' },
  { value: 'NV', label: 'Northern Nevada' },
  { value: 'AK', label: 'Southeast Alaska' },
  { value: 'BC', label: 'British Columbia' },
]);

/** Type chips of the directory (blueprint 7.4). */
export const CONTACT_TYPES = Object.freeze([
  { value: 'nation', label: 'Tribal and First Nations' },
  { value: 'state', label: 'State and Provincial' },
  { value: 'federal', label: 'Federal' },
  { value: 'county', label: 'County and Regional' },
  { value: 'flood', label: 'Flood and Waterway' },
]);

/** State FIPS codes for the county zone join (NWS county zone ids are state letters, C, and the county FIPS). */
export const STATE_FIPS = Object.freeze({ WA: '53', OR: '41', ID: '16', CA: '06', MT: '30', NV: '32', AK: '02' });

/** @type {Readonly<Record<string, string>>} */
const REGION_NAMES = Object.freeze({
  washington: 'WA', oregon: 'OR', idaho: 'ID', california: 'CA', 'northern california': 'CA', montana: 'MT',
  'western montana': 'MT', nevada: 'NV', 'northern nevada': 'NV', alaska: 'AK', 'southeast alaska': 'AK',
  'british columbia': 'BC',
});

/** Registry jurisdiction codes to the directory's codes. */
const JURISDICTION_TO_CODE = Object.freeze(/** @type {Record<string, string>} */ ({
  WA: 'WA', OR: 'OR', ID: 'ID', BC: 'BC', 'CA-N': 'CA', 'MT-W': 'MT', 'NV-N': 'NV', 'AK-SE': 'AK',
}));

const CODES = Object.freeze(['WA', 'OR', 'ID', 'CA', 'MT', 'NV', 'AK', 'BC']);
const US_CODES = Object.freeze(['WA', 'OR', 'ID', 'CA', 'MT', 'NV', 'AK']);
const FEMA_REGION = Object.freeze(/** @type {Record<string, readonly string[]>} */ ({
  'US-R10': ['WA', 'OR', 'ID', 'AK'], 'US-R9': ['CA', 'NV'],
}));

/** Human labels for the line type, shown on cards. */
export const LINE_TYPE_LABELS = Object.freeze(/** @type {Record<string, string>} */ ({
  '24-7': '24/7 Line',
  'emergency-management': 'Emergency Management',
  'government-main': 'Government Main Line',
  'band-office': 'Band Office',
  'duty-officer': 'Duty Officer',
  'non-emergency': 'Non-Emergency',
  'public-information': 'Public Information',
  tty: 'TTY',
  'tribal-liaison': 'Tribal Liaison',
  'flood-hotline': 'Flood Information Line',
  email: 'Email',
  web: 'Website',
}));

const MS_DAY = 86_400_000;

/**
 * Midnight UTC of an ISO date (YYYY-MM-DD), or NaN.
 * @param {string} day
 * @returns {number}
 */
function dayMs(day) {
  return /^\d{4}-\d{2}-\d{2}/.test(day) ? Date.parse(`${day.slice(0, 10)}T00:00:00Z`) : NaN;
}

/**
 * MM/DD/YYYY from an ISO date or timestamp, by string handling so no time zone can move the day.
 * @param {string} iso
 * @returns {string}
 */
export function formatDay(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  return m ? `${m[2]}/${m[3]}/${m[1]}` : 'date unknown';
}

/**
 * @param {unknown} v
 * @returns {v is Contact}
 */
function isContact(v) {
  if (typeof v !== 'object' || v === null) return false;
  const c = /** @type {Record<string, any>} */ (v);
  return typeof c.id === 'string' && typeof c.org === 'string' && typeof c.sortWeight === 'number'
    && typeof c.scope === 'object' && c.scope !== null && typeof c.scope.level === 'string'
    && typeof c.source === 'object' && c.source !== null && typeof c.source.url === 'string'
    && typeof c.verification === 'object' && c.verification !== null
    && typeof c.verification.verifiedAt === 'string' && typeof c.verification.reviewDue === 'string'
    && (c.phone === null || (typeof c.phone === 'object' && typeof c.phone.e164 === 'string' && typeof c.phone.display === 'string'));
}

/**
 * @param {unknown} data
 * @returns {{ doc: ContactsDoc, dropped: number } | null}
 */
export function readContactsDoc(data) {
  if (typeof data !== 'object' || data === null) return null;
  const d = /** @type {Record<string, unknown>} */ (data);
  if (d.schema !== CONTACTS_SCHEMA || !Array.isArray(d.items) || typeof d.generatedAt !== 'string') return null;
  const items = d.items.filter(isContact).filter((c) => c.status !== 'conflict' && c.status !== 'retired');
  return { doc: { schema: d.schema, generatedAt: d.generatedAt, items }, dropped: d.items.length - items.length };
}

/**
 * Cache Storage copy of a same-origin data file. The service worker precaches the contacts file, and
 * core/net.js reports offline without trying, so a device that is offline reads the saved copy here.
 * Cache reads are not network requests.
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
 * The compiled contacts with their compile stamp. A failed network read falls back to the saved copy
 * (origin 'cache'); when neither exists the result says why.
 * @param {{ signal?: AbortSignal, deps?: { fetchLocal?: (path: string, opts?: FetchOptions) => Promise<NetResult>, savedCopy?: (path: string) => Promise<unknown | null> } }} [opts]
 * @returns {Promise<ContactsLoad>}
 */
export async function loadContactsDoc(opts) {
  const get = opts?.deps?.fetchLocal ?? fetchLocal;
  const saved = opts?.deps?.savedCopy ?? savedCopy;
  const res = await get(CONTACTS_PATH, opts?.signal ? { signal: opts.signal } : {});
  if (res.ok) {
    const read = readContactsDoc(res.data);
    if (!read) return { ok: false, error: { kind: 'parse', message: 'The contacts file has an unexpected format' } };
    return { ok: true, doc: read.doc, origin: 'network', dropped: read.dropped };
  }
  if (res.error.kind === 'aborted') return { ok: false, error: res.error };
  const copy = readContactsDoc(await saved(CONTACTS_PATH));
  if (copy) return { ok: true, doc: copy.doc, origin: 'cache', dropped: copy.dropped };
  return { ok: false, error: res.error };
}

/**
 * data/curated/contacts.json.
 * @param {{ signal?: AbortSignal }} [opts]
 * @returns {Promise<import('../types.js').NetResult<Contact[]>>}
 */
export async function loadContacts(opts) {
  const res = await loadContactsDoc(opts);
  const fetchedAt = new Date().toISOString();
  if (!res.ok) return { ok: false, error: res.error, fetchedAt, sourceId: 'cthd-contacts' };
  return { ok: true, data: res.doc.items, status: 200, fetchedAt, lastModified: res.doc.generatedAt, sourceId: 'cthd-contacts' };
}

/**
 * The Nation index (names and headquarters points) for the Nation filter and Near Me.
 * @param {{ signal?: AbortSignal }} [opts]
 * @returns {Promise<import('../types.js').NetResult<import('../types.js').NationsIndex>>}
 */
export async function loadNationIndex(opts) {
  const res = await fetchLocal(NATION_INDEX_PATH, opts?.signal ? { signal: opts.signal } : {});
  if (!res.ok) return res;
  const d = /** @type {any} */ (res.data);
  if (!d || d.schema !== 'cthd.nations-index/1' || !Array.isArray(d.nations)) {
    return { ok: false, error: { kind: 'parse', message: 'The Nation index has an unexpected format' }, fetchedAt: res.fetchedAt, sourceId: res.sourceId };
  }
  return /** @type {import('../types.js').NetResult<import('../types.js').NationsIndex>} */ (res);
}

/**
 * The directory's jurisdiction codes a line applies to. A national federal line applies to every United
 * States jurisdiction (or to British Columbia for Canadian federal lines); a FEMA region line applies to
 * the states of that region.
 * @param {Contact} c
 * @returns {string[]}
 */
export function jurisdictionsOf(c) {
  const region = c.scope.region ?? '';
  const named = REGION_NAMES[region.toLowerCase()];
  const code = named ?? (CODES.includes(region) ? region : null);
  if (c.scope.level === 'federal') {
    const canadian = c.id.startsWith('ct-ca-') || c.id.startsWith('ct-bc-');
    if (canadian) return ['BC'];
    if (region === 'US') return [...US_CODES];
    const fema = FEMA_REGION[region];
    if (fema) return [...fema];
    return code ? [code] : [...US_CODES];
  }
  return code ? [code] : [];
}

/**
 * The directory's codes for a Nation's registry jurisdictions.
 * @param {NationLike} nation
 * @returns {string[]}
 */
export function nationJurisdictionCodes(nation) {
  return [...new Set(nation.jurisdictions.map((j) => JURISDICTION_TO_CODE[j]).filter((c) => typeof c === 'string'))];
}

/**
 * County FIPS codes from NWS county zone keys such as "WAC073" or ".../zones/county/WAC073".
 * @param {string} zone
 * @returns {string | null} five digits, or null
 */
export function countyFipsFromZone(zone) {
  const last = String(zone).split('/').pop() ?? '';
  const m = /^([A-Z]{2})C(\d{3})$/.exec(last);
  if (!m) return null;
  const fips = /** @type {Record<string, string>} */ (STATE_FIPS)[m[1] ?? ''];
  return fips ? `${fips}${m[2]}` : null;
}

/**
 * Past reviewDue, or flagged "needs-reverification" by the compile, renders the "Verification Due" tag.
 * The date compares by day, so a line is still current through its review date.
 * @param {Contact} contact
 * @param {Date} now
 * @returns {boolean}
 */
export function isVerificationDue(contact, now) {
  if (contact.status === 'needs-reverification') return true;
  const due = dayMs(contact.verification.reviewDue);
  if (Number.isNaN(due)) return true; // an unreadable review date is not evidence of a current line
  return now.getTime() >= due + MS_DAY;
}

/**
 * Display rank of the weights compile assigns: nation 24/7 and emergency lines, nation main line, county,
 * state or provincial 24/7, other state lines, federal 24/7, other federal.
 * @param {Contact} a
 * @param {Contact} b
 * @param {Date} now
 * @returns {number}
 */
function compareDisplay(a, b, now) {
  const w = a.sortWeight - b.sortWeight;
  if (w !== 0) return w;
  const due = Number(isVerificationDue(a, now)) - Number(isVerificationDue(b, now));
  if (due !== 0) return due;
  return a.org.localeCompare(b.org, 'en') || (a.office ?? '').localeCompare(b.office ?? '', 'en') || a.id.localeCompare(b.id, 'en');
}

/** @param {Contact} c @returns {boolean} */
function isUrgent(c) {
  return c.lineType === '24-7' || c.lineType === 'duty-officer' || c.lineType === 'emergency-management' || c.lineType === 'flood-hotline';
}

/**
 * Contacts in display order for the directory when no Nation is chosen: state, provincial, and regional
 * 24 hour lines first, then federal 24 hour lines, then everything else by compile weight.
 * @param {Contact[]} contacts
 * @param {Date} now
 * @returns {Contact[]}
 */
export function directoryOrder(contacts, now) {
  /** @param {Contact} c */
  const rank = (c) => {
    const lvl = c.scope.level;
    if ((lvl === 'state' || lvl === 'province' || lvl === 'regional') && c.lineType === '24-7') return 0;
    if (lvl === 'federal' && c.lineType === '24-7') return 1;
    return 2;
  };
  return [...contacts].sort((a, b) => rank(a) - rank(b) || compareDisplay(a, b, now));
}

/**
 * Lines for one Nation, in the order of blueprint 5.3 (911 is static and always rendered first by the page):
 * the Nation's own lines, county lines for the Nation's counties, state or provincial 24 hour and emergency
 * lines, then federal lines that apply. Without a Nation: state, provincial, and regional 24 hour lines
 * and federal 24 hour lines. Past-due lines sort after current ones of the same weight and still render.
 * @param {NationLike | null} nation
 * @param {Contact[]} contacts
 * @param {Date} now
 * @returns {Contact[]}
 */
export function contactsFor(nation, contacts, now) {
  const live = contacts.filter((c) => c.status !== 'conflict' && c.status !== 'retired');
  if (!nation) {
    return live.filter((c) => c.lineType === '24-7' && ['state', 'province', 'regional', 'federal'].includes(c.scope.level)).sort((a, b) => compareDisplay(a, b, now));
  }
  const codes = nationJurisdictionCodes(nation);
  const counties = new Set((nation.nws?.countyZones ?? []).map(countyFipsFromZone).filter((f) => f !== null));
  const canadian = codes.includes('BC');
  const picked = live.filter((c) => {
    const lvl = c.scope.level;
    if (lvl === 'nation') return c.scope.nationId === nation.id;
    if (lvl === 'county' || lvl === 'regional-district') return c.scope.countyFips !== null && counties.has(c.scope.countyFips);
    if (lvl === 'state' || lvl === 'province') return isUrgent(c) && jurisdictionsOf(c).some((j) => codes.includes(j));
    if (lvl === 'regional') return isUrgent(c) && canadian;
    if (lvl === 'federal') return jurisdictionsOf(c).some((j) => codes.includes(j));
    return false;
  });
  return picked.sort((a, b) => compareDisplay(a, b, now));
}

/**
 * Lines that belong to the Nation itself, with no regional lines mixed in.
 * @param {string} nationId
 * @param {Contact[]} contacts
 * @param {Date} now
 * @returns {Contact[]}
 */
export function nationLines(nationId, contacts, now) {
  return contacts.filter((c) => c.scope.level === 'nation' && c.scope.nationId === nationId && c.status !== 'conflict' && c.status !== 'retired')
    .sort((a, b) => compareDisplay(a, b, now));
}

/** @param {Contact} c @returns {string} */
export function contactKind(c) {
  const lvl = c.scope.level;
  if (lvl === 'nation') return 'nation';
  if (lvl === 'state' || lvl === 'province') return 'state';
  if (lvl === 'federal') return 'federal';
  if (lvl === 'county' || lvl === 'regional-district') return 'county';
  return 'state'; // regional (for example the First Nations' Emergency Services Society) sits with provincial lines
}

/** @param {Contact} c @returns {boolean} */
export function isFloodLine(c) {
  return c.lineType === 'flood-hotline' || /\b(?:river forecast|flood|waterway|hydrolog)/i.test(c.office ?? '');
}

/**
 * Lower case, marks stripped, so "Sx̧wó" style names still match plain typing. Matching only, never display.
 * @param {string} text
 * @returns {string}
 */
export function fold(text) {
  return String(text).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[‘’ʼ'`]/g, '').replace(/\s+/g, ' ').trim();
}

/**
 * @typedef {{ q?: string, jur?: string[], type?: string[], nationId?: string | null }} ContactFilters
 */

/**
 * Applies the directory filters. A Nation selection narrows to contactsFor; the other filters then apply
 * to those lines. Search matches organization, office, line type, phone digits, and the Nation's name.
 * @param {Contact[]} contacts
 * @param {ContactFilters} filters
 * @param {{ nations: Map<string, NationIndexEntry>, nation?: NationLike | null, now: Date }} ctx
 * @returns {Contact[]} in display order
 */
export function filterContacts(contacts, filters, ctx) {
  const base = filters.nationId ? contactsFor(ctx.nation ?? null, contacts, ctx.now) : directoryOrder(contacts, ctx.now);
  const q = fold(filters.q ?? '');
  const qDigits = q.replace(/\D/g, '');
  const jur = filters.jur ?? [];
  const type = filters.type ?? [];
  return base.filter((c) => {
    if (jur.length && !jurisdictionsOf(c).some((j) => jur.includes(j))) return false;
    if (type.length && !type.some((t) => (t === 'flood' ? isFloodLine(c) : contactKind(c) === t))) return false;
    if (q) {
      const nationName = c.scope.nationId ? ctx.nations.get(c.scope.nationId)?.name ?? '' : '';
      const hay = fold(`${c.org} ${c.office ?? ''} ${LINE_TYPE_LABELS[c.lineType] ?? c.lineType} ${c.scope.region ?? ''} ${nationName} ${c.hours ?? ''}`);
      const phone = c.phone ? c.phone.e164.replace(/\D/g, '') : '';
      const hit = q.split(' ').every((w) => hay.includes(w)) || (qDigits.length >= 3 && phone.includes(qDigits));
      if (!hit) return false;
    }
    return true;
  });
}

/**
 * The sentence that names the active filter, printed and copied with every list (blueprint 7.4).
 * @param {{ q?: string, jur?: string[], type?: string[], nationName?: string | null, shown: number, total: number }} f
 * @returns {string}
 */
export function filterNote(f) {
  const parts = [];
  if (f.nationName) parts.push(`Nation: ${f.nationName}`);
  if (f.jur?.length) parts.push(`Jurisdiction: ${f.jur.map((j) => JURISDICTIONS.find((x) => x.value === j)?.label ?? j).join(', ')}`);
  if (f.type?.length) parts.push(`Type: ${f.type.map((t) => CONTACT_TYPES.find((x) => x.value === t)?.label ?? t).join(', ')}`);
  if (f.q && f.q.trim()) parts.push(`Search: "${f.q.trim()}"`);
  const scope = parts.length ? `Filter: ${parts.join('; ')}.` : 'Filter: none (all lines).';
  return `${scope} ${f.shown} of ${f.total} lines.`;
}

/**
 * One plain-text line per contact, for Copy List.
 * @param {Contact} c
 * @returns {string}
 */
export function contactLine(c) {
  const bits = [c.org];
  if (c.office) bits.push(c.office);
  bits.push(LINE_TYPE_LABELS[c.lineType] ?? c.lineType);
  if (c.phone) bits.push(c.phone.ext ? `${c.phone.display} ext. ${c.phone.ext}` : c.phone.display);
  if (c.email) bits.push(c.email);
  if (c.hours) bits.push(c.hours);
  bits.push(`Verified ${formatDay(c.verification.verifiedAt)}`);
  bits.push(`Source: ${c.source.publisher} ${c.source.url}`);
  return bits.join(' | ');
}

/**
 * The n nearest Nations to a point by great-circle distance (haversine); ties keep index order.
 * @param {import('../types.js').NationIndexEntry[]} nations
 * @param {number} lat
 * @param {number} lon
 * @param {number} [n] default 5
 * @returns {Array<{ nation: import('../types.js').NationIndexEntry, distanceKm: number }>}
 */
export function nearestNations(nations, lat, lon, n = 5) {
  return nations
    .map((nation, index) => ({ nation, index, distanceKm: haversineKm([lat, lon], nation.hq) }))
    .sort((x, y) => x.distanceKm - y.distanceKm || x.index - y.index)
    .slice(0, Math.max(0, n))
    .map(({ nation, distanceKm }) => ({ nation, distanceKm }));
}

/**
 * Coordinates rounded to three decimals (about 110 metres) before any request; never stored.
 * @param {number} value
 * @returns {number}
 */
export function roundCoord(value) {
  return Math.round(value * 1000) / 1000;
}

/**
 * The footprint region a point falls in (lowercase code such as "wa" or "bc"), or null outside the footprint.
 * @param {{ features: { properties: { region: string }, geometry: import('../types.js').Geometry }[] }} footprint
 * @param {number} lat
 * @param {number} lon
 * @returns {string | null}
 */
export function footprintRegionAt(footprint, lat, lon) {
  for (const f of footprint.features) if (pointInGeometry([lon, lat], f.geometry)) return f.properties.region;
  return null;
}

/**
 * The EMCR region polygon holding a point, with no network request (blueprint 7.4).
 * @param {{ features: { properties: { regionNumber: number, name: string }, geometry: import('../types.js').Geometry }[] }} regions
 * @param {number} lat
 * @param {number} lon
 * @returns {{ regionNumber: number, name: string } | null}
 */
export function emcrRegionAt(regions, lat, lon) {
  for (const f of regions.features) if (pointInGeometry([lon, lat], f.geometry)) return { regionNumber: f.properties.regionNumber, name: f.properties.name };
  return null;
}

/**
 * County emergency management lines for a county FIPS code.
 * @param {string} fips
 * @param {Contact[]} contacts
 * @param {Date} now
 * @returns {Contact[]}
 */
export function countyLines(fips, contacts, now) {
  return contacts.filter((c) => (c.scope.level === 'county' || c.scope.level === 'regional-district') && c.scope.countyFips === fips)
    .sort((a, b) => compareDisplay(a, b, now));
}

/**
 * State or provincial lines for a directory jurisdiction code ("WA", "BC"), 24 hour lines first.
 * @param {string} code
 * @param {Contact[]} contacts
 * @param {Date} now
 * @returns {Contact[]}
 */
export function stateLines(code, contacts, now) {
  return contacts.filter((c) => (c.scope.level === 'state' || c.scope.level === 'province') && jurisdictionsOf(c).includes(code) && isUrgent(c))
    .sort((a, b) => compareDisplay(a, b, now));
}

/** The compiled file is fresh for thirty days and usable for the contact review period (180 days). */
const FRESH_MS = 30 * MS_DAY;
const USABLE_MS = 180 * MS_DAY;

/**
 * The honest status of a compiled reference file for a panel footer. `asOf` is when the compile issued
 * the file; every card carries its own verified date. A saved copy is "cached"; a file past 180 days is
 * "degraded"; lines that failed validation make it "degraded" with the count.
 * @param {{ doc: { generatedAt: string }, origin: 'network' | 'cache', dropped: number }} load a loaded contacts or resources file
 * @param {Date} now
 * @param {string[]} sourceIds
 * @param {string} [noun] what the file lists, for the offline notice; default "contacts"
 * @returns {import('../types.js').StatusSnapshot}
 */
export function curatedStatus(load, now, sourceIds, noun = 'contacts') {
  const age = now.getTime() - Date.parse(load.doc.generatedAt);
  const cached = load.origin === 'cache';
  /** @type {import('../types.js').StatusState} */
  let state = cached ? 'cached' : age <= FRESH_MS ? 'live' : age <= USABLE_MS ? 'stale' : 'degraded';
  let detail = cached ? `Saved for offline use; ${noun} verified as listed.` :'Compiled reference list. Every entry shows the date it was verified and its source.';
  if (load.dropped > 0) {
    state = 'degraded';
    detail = `${load.dropped} ${load.dropped === 1 ? 'entry' : 'entries'} could not be displayed. ${detail}`;
  }
  return {
    state, asOf: load.doc.generatedAt, asOfBasis: 'issued', detail, sourceIds: [...sourceIds],
    origin: cached ? 'device' : 'snapshot', completeness: load.dropped > 0 ? 'partial' : 'complete', checkedAt: now.toISOString(),
  };
}

/**
 * @param {string[]} sourceIds
 * @param {string} detail
 * @param {Date} now
 * @returns {import('../types.js').StatusSnapshot}
 */
export function unavailableStatus(sourceIds, detail, now) {
  return { state: 'unavailable', asOf: null, asOfBasis: null, detail, sourceIds: [...sourceIds], origin: 'direct', completeness: 'partial', checkedAt: now.toISOString() };
}

/**
 * The short list a Safety "Call" line shows, built only from compiled data (never hard-coded): the state or
 * provincial 24/7 lines for the given jurisdictions, the FEMA helpline for the United States, the Public
 * Safety Canada operations centre for British Columbia, and any Red Cross or 988 line found in the compiled
 * resources. 911 is static and added by the page.
 * @param {{ contacts: Contact[], resources: import('../types.js').Resource[], codes: string[], now: Date }} o
 *   `codes`: directory codes (for example "WA"); empty means no Nation is selected, so no state line is listed.
 * @returns {Array<{ label: string, display: string, e164: string, id: string }>}
 */
export function callEntries(o) {
  /** @type {Array<{ label: string, display: string, e164: string, id: string }>} */
  const out = [];
  /** @param {Contact} c */
  const push = (c) => { if (c.phone && !out.some((x) => x.id === c.id)) out.push({ id: c.id, label: c.office ? `${c.org}, ${c.office}` : c.org, display: c.phone.display, e164: c.phone.e164 }); };
  for (const code of o.codes) {
    const first = stateLines(code, o.contacts, o.now).filter((c) => c.lineType === '24-7')[0];
    if (first) push(first);
  }
  const us = o.codes.length === 0 || o.codes.some((c) => c !== 'BC');
  const ca = o.codes.includes('BC');
  const byId = (/** @type {string} */ id) => o.contacts.find((c) => c.id === id);
  const fema = us ? byId('ct-us-fema-disaster-assistance-government-main') : undefined;
  if (fema) push(fema);
  const goc = ca ? byId('ct-ca-psc-goc-24-7') : undefined;
  if (goc) push(goc);
  for (const r of o.resources) {
    if (r.phone && (/red cross/i.test(r.publisher) || r.phone === '988') && !out.some((x) => x.id === r.id)) {
      const digits = r.phone.replace(/\D/g, '');
      out.push({ id: r.id, label: r.phone === '988' ? r.title : r.publisher, display: r.phone === '988' ? '988' : digits.length === 11 ? `${digits.slice(1, 4)}-${digits.slice(4, 7)}-${digits.slice(7)}` : r.phone, e164: r.phone });
    }
  }
  return out.filter((x, i) => out.findIndex((y) => y.e164 === x.e164) === i);
}

// ---------------------------------------------------------------------------------------------
// Near Me (blueprint 7.4): a point to Nations, county or EMCR region, alerts, and a forecast link
// ---------------------------------------------------------------------------------------------

/** @typedef {import('../types.js').DashboardAlert} DashboardAlert */
/**
 * @typedef {{
 *   ok: boolean, items: DashboardAlert[], asOf: string | null, partial: boolean,
 *   note: string | null, source: 'nws' | 'snapshot',
 * }} PointAlerts
 */
/**
 * @typedef {{
 *   place: { lat: number, lon: number },
 *   outside: boolean,
 *   region: string | null,
 *   nearest: Array<{ nation: import('../types.js').NationIndexEntry, distanceKm: number, lines: Contact[] }>,
 *   town: string | null,
 *   county: { fips: string, lines: Contact[] } | null,
 *   countyNote: string | null,
 *   emcr: { regionNumber: number, name: string } | null,
 *   stateLines: Contact[],
 *   alerts: PointAlerts | null,
 *   forecastUrl: string | null,
 *   problems: string[],
 *   checkedAt: string,
 * }} NearMe
 */

/** Official links shown when the point is outside the covered area. */
export const NATIONAL_LINKS = Object.freeze([
  { label: 'National Weather Service (United States)', url: 'https://www.weather.gov/' },
  { label: 'Environment and Climate Change Canada Weather', url: 'https://weather.gc.ca/' },
]);

/** The readable forecast pages (blueprint 7.4); never a raw API address. */
export const FORECAST_LINKS = Object.freeze({
  /** @param {number} lat @param {number} lon */
  us: (lat, lon) => `https://forecast.weather.gov/MapClick.php?lat=${lat}&lon=${lon}`,
  /** @param {number} lat @param {number} lon */
  bc: (lat, lon) => `https://weather.gc.ca/en/location/index.html?coords=${lat},${lon}`,
});

/**
 * U.S. alerts at a point from api.weather.gov, normalized and lifecycle-resolved by the alert engine
 * (Test and Exercise messages are excluded there).
 * @param {number} lat
 * @param {number} lon
 * @param {{ fetchJson: (id: string, opts?: FetchOptions) => Promise<NetResult>, now: Date, signal?: AbortSignal }} o
 * @returns {Promise<PointAlerts>}
 */
export async function alertsAtPointUs(lat, lon, o) {
  const res = await o.fetchJson('nws-alerts-active', { params: { point: `${lat},${lon}`, status: 'actual' }, priority: 0, ...(o.signal ? { signal: o.signal } : {}) });
  if (!res.ok) return { ok: false, items: [], asOf: null, partial: true, note: 'Alerts for this location could not be checked here.', source: 'nws' };
  const [nws, life, model] = await Promise.all([import('../alerts/nws.js'), import('../alerts/lifecycle.js'), import('../alerts/model.js')]);
  const normalized = nws.normalizeNwsCollection(res.data, { fetchedAt: res.fetchedAt, now: o.now });
  const items = model.sortAlerts(life.resolveLifecycle(normalized.alerts, o.now).current);
  const updated = /** @type {{ updated?: unknown }} */ (res.data)?.updated;
  const asOf = typeof updated === 'string' && !Number.isNaN(Date.parse(updated)) ? updated : null;
  const partial = Number(normalized.diagnostics.itemsFailed) > 0 || normalized.diagnostics.truncated === true;
  return { ok: true, items, asOf, partial, note: partial ? 'Some alerts for this location could not be displayed here.' : null, source: 'nws' };
}

/**
 * British Columbia alerts at a point: the scheduled copy of the alert index, kept where its outline
 * contains the point. Alerts with no outline cannot be placed and are counted, never dropped silently.
 * @param {number} lat
 * @param {number} lon
 * @param {{ loadSnapshot: () => Promise<{ alerts: DashboardAlert[], geometry: Map<string, import('../types.js').Geometry> | null, asOf: string | null } | null>, now: Date }} o
 * @returns {Promise<PointAlerts>}
 */
export async function alertsAtPointBc(lat, lon, o) {
  const snap = await o.loadSnapshot();
  if (!snap || snap.asOf === null) return { ok: false, items: [], asOf: null, partial: true, note: 'The scheduled copy of British Columbia alerts is not available.', source: 'snapshot' };
  const bc = snap.alerts.filter((a) => a.jurisdictions.includes('BC'));
  if (bc.length === 0) return { ok: true, items: [], asOf: snap.asOf, partial: false, note: null, source: 'snapshot' };
  if (!snap.geometry) return { ok: false, items: [], asOf: snap.asOf, partial: true, note: 'British Columbia alert outlines are not available, so alerts cannot be matched to this location.', source: 'snapshot' };
  const geometry = snap.geometry;
  const here = bc.filter((a) => { const g = geometry.get(a.alertId); return g ? pointInGeometry([lon, lat], g) : false; });
  const unplaced = bc.filter((a) => !geometry.has(a.alertId)).length;
  const note = unplaced > 0 ? `${unplaced} British Columbia alert${unplaced === 1 ? '' : 's'} could not be matched to this location. Check weather.gc.ca.` : null;
  return { ok: true, items: here, asOf: snap.asOf, partial: unplaced > 0, note, source: 'snapshot' };
}

/**
 * Resolves a point to everything Near Me shows. Every network and data read is injected, so a test supplies
 * dated captures. The point is already rounded by the caller; nothing here stores it.
 * @param {{
 *   lat: number, lon: number, now: Date, contacts: Contact[],
 *   nations: import('../types.js').NationIndexEntry[],
 *   footprint: Parameters<typeof footprintRegionAt>[0] | null,
 *   bcRegions: Parameters<typeof emcrRegionAt>[0] | null,
 *   fetchJson: (id: string, opts?: FetchOptions) => Promise<NetResult>,
 *   loadBcSnapshot: () => Promise<{ alerts: DashboardAlert[], geometry: Map<string, import('../types.js').Geometry> | null, asOf: string | null } | null>,
 *   signal?: AbortSignal,
 * }} o
 * @returns {Promise<NearMe>}
 */
export async function resolveNearMe(o) {
  const { lat, lon, now } = o;
  /** @type {string[]} */
  const problems = [];
  const region = o.footprint ? footprintRegionAt(o.footprint, lat, lon) : null;
  /** @type {NearMe} */
  const out = {
    place: { lat, lon }, outside: false, region, nearest: [], town: null, county: null, countyNote: null, emcr: null,
    stateLines: [], alerts: null, forecastUrl: null, problems, checkedAt: now.toISOString(),
  };
  if (!o.footprint) problems.push('The coverage area could not be loaded, so this location could not be checked against it.');
  if (o.footprint && region === null) { out.outside = true; return out; }

  out.nearest = nearestNations(o.nations, lat, lon, 5).map((n) => ({ ...n, lines: nationLines(n.nation.id, o.contacts, now) }));
  if (o.nations.length === 0) problems.push('The Nation list could not be loaded.');

  const bc = region === 'bc';
  if (bc) {
    out.emcr = o.bcRegions ? emcrRegionAt(o.bcRegions, lat, lon) : null;
    if (!o.bcRegions) problems.push('The provincial emergency region outlines could not be loaded.');
    out.stateLines = stateLines('BC', o.contacts, now);
    out.forecastUrl = FORECAST_LINKS.bc(lat, lon);
    out.alerts = await alertsAtPointBc(lat, lon, { loadSnapshot: o.loadBcSnapshot, now }).catch(() => ({ ok: false, items: [], asOf: null, partial: true, note: 'British Columbia alerts could not be checked here.', source: /** @type {'snapshot'} */ ('snapshot') }));
    return out;
  }

  out.forecastUrl = FORECAST_LINKS.us(lat, lon);
  const code = region === null ? null : (JURISDICTION_TO_CODE[region.toUpperCase()] ?? null);
  const signal = o.signal ? { signal: o.signal } : {};
  const [points, alerts] = await Promise.all([
    o.fetchJson('nws-points', { params: { lat, lon }, priority: 0, ...signal }).catch(() => null),
    alertsAtPointUs(lat, lon, { fetchJson: o.fetchJson, now, ...signal }).catch(() => /** @type {PointAlerts} */ ({ ok: false, items: [], asOf: null, partial: true, note: 'Alerts for this location could not be checked here.', source: 'nws' })),
  ]);
  out.alerts = alerts;
  const props = points && points.ok ? /** @type {any} */ (points.data)?.properties : null;
  if (props) {
    const fips = typeof props.county === 'string' ? countyFipsFromZone(props.county) : null;
    const rel = props.relativeLocation?.properties;
    if (rel && typeof rel.city === 'string' && typeof rel.state === 'string') out.town = `${rel.city}, ${rel.state}`;
    if (fips) {
      const lines = countyLines(fips, o.contacts, now);
      out.county = { fips, lines };
      if (lines.length === 0) out.countyNote = 'No verified county emergency management line is on file for this county yet.';
    } else out.countyNote = 'The county for this location could not be determined.';
  } else {
    problems.push('The county for this location could not be determined.');
    out.countyNote = 'The county for this location could not be determined.';
  }
  out.stateLines = code ? stateLines(code, o.contacts, now) : [];
  return out;
}
