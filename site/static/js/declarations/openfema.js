// @ts-check
/**
 * OpenFEMA DisasterDeclarationsSummaries grouped per disaster (blueprint 5.7). DOM-free; the same module
 * runs in the browser (direct fallback) and in the Node snapshot task (scripts/snapshot/tasks/declarations.mjs).
 *
 * OpenFEMA returns one row per designated area, so a Major Disaster Declaration that names thirty counties
 * arrives as thirty rows. Display groups them by `femaDeclarationString` into one record with every
 * designated area listed once. The module never infers that a declaration is "active": it states the
 * declaration date, the incident period, and whether FEMA has closed the disaster out, and nothing more.
 */

/** @typedef {import('../types.js').NationIndexEntry} NationIndexEntry */
/** @typedef {import('../types.js').FemaDeclaration} FemaDeclaration */
/** @typedef {import('../types.js').RegionCode} RegionCode */

/** The footprint states (blueprint 5.7); the four edge states are filtered to footprint counties and Nation lands. */
export const FEMA_STATES = Object.freeze(['WA', 'OR', 'ID', 'CA', 'NV', 'MT', 'AK']);
/** States whose declarations are kept whole (every county is inside the footprint). */
const WHOLE_STATES = new Set(['WA', 'OR', 'ID']);
export const FEMA_WINDOW_DAYS = 730;
/** OpenFEMA's page size (`$top`); paging continues with `$skip` until a page comes back short. */
export const FEMA_PAGE_SIZE = 1000;
/** Explicit `$select`: only the fields this module reads. */
export const FEMA_SELECT = Object.freeze([
  'femaDeclarationString', 'disasterNumber', 'state', 'declarationType', 'declarationDate', 'incidentType',
  'declarationTitle', 'ihProgramDeclared', 'iaProgramDeclared', 'paProgramDeclared', 'hmProgramDeclared',
  'incidentBeginDate', 'incidentEndDate', 'disasterCloseoutDate', 'tribalRequest', 'fipsStateCode',
  'fipsCountyCode', 'designatedArea', 'lastRefresh',
]);

/** @type {Readonly<Record<string, RegionCode>>} */
const STATE_REGION = Object.freeze({ WA: 'wa', OR: 'or', ID: 'id', CA: 'ca-n', NV: 'nv-n', MT: 'mt-w', AK: 'ak-se' });

/** Declaration types in words (blueprint 7.2). */
export const FEMA_TYPE_WORDS = Object.freeze(/** @type {Record<'DR' | 'EM' | 'FM', string>} */ ({
  DR: 'Major Disaster Declaration',
  EM: 'Emergency Declaration',
  FM: 'Fire Management Assistance Declaration',
}));

const DAY_MS = 86_400_000;

/**
 * `$filter` for the footprint states over 730 days, explicit `$select`, `$orderby`, `$skip` paging. The
 * date boundary is the start of the UTC day 730 days before `now`, so the request is stable within a day.
 * @param {Date} now
 * @param {number} skip
 * @returns {Record<string, string>}
 */
export function femaQueryParams(now, skip) {
  const dayStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const cutoff = new Date(dayStart - FEMA_WINDOW_DAYS * DAY_MS).toISOString();
  const states = FEMA_STATES.map((s) => `state eq '${s}'`).join(' or ');
  return {
    $filter: `(${states}) and declarationDate ge '${cutoff}'`,
    $select: FEMA_SELECT.join(','),
    $orderby: 'declarationDate desc,disasterNumber desc,designatedArea asc',
    $top: String(FEMA_PAGE_SIZE),
    $skip: String(Math.max(0, Math.trunc(skip))),
  };
}

/** @param {unknown} v @returns {v is Record<string, unknown>} */
function isRecord(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** @param {unknown} v @returns {string} */
function str(v) {
  return typeof v === 'string' ? v.trim() : '';
}

/**
 * ISO date or date-time to MM/DD/YYYY by reading the date digits as published (OpenFEMA dates are calendar
 * dates stored at midnight UTC, so no time zone shift is applied).
 * @param {string | null | undefined} iso
 * @returns {string} '' when the value is not a date
 */
export function usDate(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso ?? ''));
  return m ? `${m[2]}/${m[3]}/${m[1]}` : '';
}

/** Words that name the kind of land, not the Nation; removed to find the part that identifies it. */
const GENERIC = new Set(['indian', 'indians', 'reservation', 'reservations', 'community', 'tribe', 'tribes', 'tribal', 'band', 'bands', 'nation',
  'village', 'native', 'rancheria', 'colony', 'pueblo', 'reserve', 'of', 'the', 'and', 'anv', 'anvsa', 'trust', 'land', 'lands', 'off', 'confederated']);
const TRIBAL_MARKER = /reservation|indian|rancheria|pueblo|tribe|tribal|nation|native|anv|colony|community|band|village|reserve/i;

/**
 * Lowercase ASCII words: diacritics folded, punctuation and parentheticals removed.
 * @param {string} text
 * @returns {string}
 */
export function normalizeAreaText(text) {
  return String(text)
    .normalize('NFD').replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/\([^)]*\)/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * The words of a designated area that identify the Nation, or '' when the area is a county or names none.
 * @param {string} area
 * @returns {string}
 */
function identifyingCore(area) {
  if (/\(county\)|\(borough\)|\(parish\)|\(city\)/i.test(area)) return '';
  const first = area.split(',')[0] ?? area;
  const words = normalizeAreaText(first).split(' ').filter((w) => w && !GENERIC.has(w));
  return words.join(' ');
}

/**
 * @param {NationIndexEntry[]} nations
 * @returns {{ id: string, norm: string }[]}
 */
function candidatesOf(nations) {
  /** @type {{ id: string, norm: string }[]} */
  const out = [];
  for (const n of nations) {
    for (const name of [n.name, n.preferredName, ...n.aliases]) {
      const norm = normalizeAreaText(name ?? '');
      if (norm) out.push({ id: n.id, norm: ` ${norm} ` });
    }
  }
  return out;
}

/**
 * Registry Nations a designated area names. A match needs the area's identifying words as a whole-word run
 * inside exactly one Nation's name or aliases; two Nations or none is "unmatched" and goes to the review
 * queue, because guessing would attach a declaration to the wrong Nation.
 * @param {string} area
 * @param {{ id: string, norm: string }[]} candidates from candidatesOf
 * @returns {string | null} the Nation id, or null
 */
export function matchNationForArea(area, candidates) {
  const core = identifyingCore(area);
  if (core.length < 3) return null;
  const needle = ` ${core} `;
  const ids = new Set(candidates.filter((c) => c.norm.includes(needle)).map((c) => c.id));
  return ids.size === 1 ? /** @type {string} */ ([...ids][0]) : null;
}

/** @param {unknown} v @returns {boolean} */
const flag = (v) => v === true || v === 'true' || v === 1;

/**
 * @typedef {{ nations: NationIndexEntry[], footprintCountyCodes?: ReadonlySet<string> | null }} GroupContext
 *   `footprintCountyCodes` holds NWS county codes ("MTC053") for the footprint counties of the four edge states.
 */

/**
 * One record per femaDeclarationString; never infers "active".
 * Edge-state (CA, NV, MT, AK) rows are kept only for footprint counties or Nation lands.
 * @param {unknown[]} rows
 * @param {GroupContext} ctx
 * @returns {{ items: FemaDeclaration[], skipped: number, latestRefresh: string | null }}
 */
export function groupFema(rows, ctx) {
  const candidates = candidatesOf(ctx.nations ?? []);
  const counties = ctx.footprintCountyCodes ?? null;
  /** @type {Map<string, Record<string, unknown>[]>} */
  const groups = new Map();
  let skipped = 0;
  /** @type {string | null} */
  let latestRefresh = null;
  for (const raw of rows) {
    if (!isRecord(raw)) { skipped += 1; continue; }
    const key = str(raw.femaDeclarationString);
    const type = str(raw.declarationType);
    if (!/^(DR|EM|FM)-\d+-[A-Z]{2}$/.test(key) || !['DR', 'EM', 'FM'].includes(type)) { skipped += 1; continue; }
    const list = groups.get(key) ?? [];
    list.push(raw);
    groups.set(key, list);
    const refreshed = str(raw.lastRefresh);
    if (refreshed && !Number.isNaN(Date.parse(refreshed)) && (latestRefresh === null || Date.parse(refreshed) > Date.parse(latestRefresh))) latestRefresh = refreshed;
  }

  /** @type {Map<string, string | null>} */
  const matchCache = new Map();
  /** @param {string} area */
  const nationOf = (area) => {
    if (!matchCache.has(area)) matchCache.set(area, matchNationForArea(area, candidates));
    return matchCache.get(area) ?? null;
  };

  /** @type {FemaDeclaration[]} */
  const items = [];
  for (const [key, list] of groups) {
    const first = list[0] ?? {};
    const state = str(first.state);
    const type = /** @type {'DR' | 'EM' | 'FM'} */ (str(first.declarationType));
    const disasterNumber = Number(first.disasterNumber);
    if (!Number.isInteger(disasterNumber) || disasterNumber < 1 || !/^[A-Z]{2}$/.test(state)) { skipped += 1; continue; }

    /** @type {string[]} */
    const areas = [];
    const nationIds = new Set();
    /** @type {string | null} */
    let unmatched = null;
    let anyInFootprintRow = WHOLE_STATES.has(state);
    for (const row of list) {
      const area = str(row.designatedArea);
      const countyDigits = str(row.fipsCountyCode);
      const countyCode = /^\d{3}$/.test(countyDigits) && countyDigits !== '000' ? `${state}C${countyDigits}` : null;
      const nationId = area ? nationOf(area) : null;
      const inCounty = countyCode !== null && counties !== null && counties.has(countyCode);
      const keep = WHOLE_STATES.has(state) || inCounty || nationId !== null;
      if (!keep) continue;
      anyInFootprintRow = true;
      if (area && !areas.includes(area)) areas.push(area);
      if (nationId) nationIds.add(nationId);
      else if (area && unmatched === null && TRIBAL_MARKER.test(area) && !/\((county|borough|parish|city)\)/i.test(area)) unmatched = area;
    }
    if (!anyInFootprintRow) continue;

    const begins = list.map((r) => str(r.incidentBeginDate)).filter((d) => d !== '' && !Number.isNaN(Date.parse(d))).sort();
    const ends = list.map((r) => str(r.incidentEndDate)).filter((d) => d !== '' && !Number.isNaN(Date.parse(d))).sort();
    const closes = list.map((r) => str(r.disasterCloseoutDate));
    const declared = list.map((r) => str(r.declarationDate)).filter((d) => d !== '' && !Number.isNaN(Date.parse(d))).sort();
    if (declared.length === 0) { skipped += 1; continue; }
    // Closed out only when every row says so; a mixed set stays "not closed out".
    const closedOn = closes.every((c) => c !== '' && !Number.isNaN(Date.parse(c))) ? (closes.slice().sort().pop() ?? null) : null;

    items.push({
      id: `fema:${key}`,
      disasterNumber,
      type,
      state,
      region: STATE_REGION[state] ?? null,
      tribalRequest: list.some((r) => flag(r.tribalRequest)),
      title: str(first.declarationTitle) || key,
      incidentType: str(first.incidentType),
      declaredOn: /** @type {string} */ (declared[0]),
      incidentBegin: begins[0] ?? null,
      incidentEnd: ends.length > 0 && list.every((r) => str(r.incidentEndDate) !== '') ? (ends[ends.length - 1] ?? null) : null,
      closedOn,
      designatedAreas: areas.sort((a, b) => a.localeCompare(b, 'en')),
      programs: {
        ih: list.some((r) => flag(r.ihProgramDeclared)),
        ia: list.some((r) => flag(r.iaProgramDeclared)),
        pa: list.some((r) => flag(r.paProgramDeclared)),
        hm: list.some((r) => flag(r.hmProgramDeclared)),
      },
      nationIds: [...nationIds].sort(),
      unmatchedTribalArea: unmatched,
      inFootprint: true,
      // eslint-disable-next-line no-restricted-syntax -- a human page for the reader, not an API endpoint; www.fema.gov is not on the human-link allowlist
      sourceUrl: `https://www.fema.gov/disaster/${disasterNumber}`,
    });
  }
  items.sort((a, b) => Date.parse(b.declaredOn) - Date.parse(a.declaredOn) || b.disasterNumber - a.disasterNumber);
  return { items, skipped, latestRefresh };
}

/**
 * One record per femaDeclarationString; never infers "active".
 * @param {unknown[]} rows
 * @param {{ nations: NationIndexEntry[], footprintCountyCodes?: ReadonlySet<string> | null }} ctx
 * @returns {FemaDeclaration[]}
 */
export function groupFemaRows(rows, ctx) {
  return groupFema(rows, ctx).items;
}

/**
 * The status sentence. It never says "active": "Declared 12/12/2025; incident period 12/08/2025 to
 * 12/20/2025; not closed out."
 * @param {Pick<FemaDeclaration, 'declaredOn' | 'incidentBegin' | 'incidentEnd' | 'closedOn'>} d
 * @returns {string}
 */
export function femaStatusText(d) {
  const declared = `Declared ${usDate(d.declaredOn)}`;
  const begin = usDate(d.incidentBegin);
  const end = usDate(d.incidentEnd);
  let period;
  if (begin && end) period = `incident period ${begin} to ${end}`;
  else if (begin) period = `incident period began ${begin} and FEMA publishes no end date`;
  else period = 'FEMA publishes no incident period';
  const closed = d.closedOn ? `closed out by FEMA on ${usDate(d.closedOn)}` : 'not closed out';
  return `${declared}; ${period}; ${closed}.`;
}

/**
 * @param {FemaDeclaration} d
 * @returns {string} the type in words
 */
export function femaTypeWord(d) {
  return FEMA_TYPE_WORDS[d.type] ?? d.type;
}

/**
 * Program words for the programs FEMA declared, in a fixed order.
 * @param {FemaDeclaration['programs']} p
 * @returns {string[]}
 */
export function femaProgramWords(p) {
  /** @type {string[]} */
  const out = [];
  if (p.ih) out.push('Individuals and Households Program');
  if (p.ia) out.push('Individual Assistance');
  if (p.pa) out.push('Public Assistance');
  if (p.hm) out.push('Hazard Mitigation');
  return out;
}
