// @ts-check
/**
 * DashboardAlert helpers mirroring @ewm/alerts-schema model.ts (blueprint 3.7.1). DOM-free.
 *
 * `createAlertId`, `compareSeverityBands`, and `highestSeverityBand` are line-for-line ports of CAST
 * `model.ts` (tests/cast/alerts-model.test.mjs runs them against the CAST TypeScript itself). The rest are
 * dashboard helpers: typed zone keys (3.7.5), the display sort (3.8), and the snapshot split (5.10).
 */

/** @typedef {import('../types.js').ZoneKey} ZoneKey */
/** @typedef {import('../types.js').ZoneType} ZoneType */
/** @typedef {import('../types.js').SeverityBand} SeverityBand */
/** @typedef {import('../types.js').ActionPosture} ActionPosture */
/** @typedef {import('../types.js').AlertLanguageBlock} AlertLanguageBlock */
/** @typedef {import('../types.js').DashboardAlert} DashboardAlert */
/** @typedef {import('../types.js').DashboardAlertIndexEntry} DashboardAlertIndexEntry */
/** @typedef {import('../types.js').Geometry} Geometry */
/** @typedef {import('../types.js').NationRecord} NationRecord */

/** CAST BAND_RANK. @type {Readonly<Record<Exclude<SeverityBand, 'unstated'>, number>>} */
const BAND_RANK = Object.freeze({ minor: 0, moderate: 1, severe: 2, extreme: 3 });

/**
 * `${agency}:${originalId}`; throws on empty parts (CAST createAlertId).
 * @param {string} agency
 * @param {string} originalId
 * @returns {string}
 */
export function createAlertId(agency, originalId) {
  if (agency.trim() === '') throw new Error('Alert agency must not be empty');
  if (originalId.trim() === '') throw new Error('Alert originalId must not be empty');
  return `${agency}:${originalId}`;
}

/**
 * Null whenever either band is unstated (CAST).
 * @param {SeverityBand} left
 * @param {SeverityBand} right
 * @returns {number | null}
 */
export function compareSeverityBands(left, right) {
  if (left === 'unstated' || right === 'unstated') return null;
  return BAND_RANK[left] - BAND_RANK[right];
}

/**
 * CAST highestSeverityBand: unstated is ignored while ranking and returned only when every member is unstated.
 * @param {SeverityBand[]} bands
 * @returns {SeverityBand}
 */
export function highestSeverityBand(bands) {
  /** @type {Exclude<SeverityBand, 'unstated'> | undefined} */
  let highest;
  for (const band of bands) {
    if (band === 'unstated') continue;
    if (highest === undefined || BAND_RANK[band] > BAND_RANK[highest]) highest = band;
  }
  return highest ?? 'unstated';
}

/** NWS UGC code shape (two-letter area, C or Z, three digits). */
export const UGC_CODE = /^[A-Z]{2}[CZ]\d{3}$/;
const ZONE_PATH = /\/zones\/(forecast|county|fire|public|coastal|offshore|marine)\/([A-Z]{2}[CZ]\d{3})\/?$/;

/**
 * True for marine zone codes (any id starting PZZ or PKZ, the Pacific and Alaska coastal waters in scope).
 * @param {string} code bare UGC code
 * @returns {boolean}
 */
export function isMarineCode(code) {
  return /^P[ZK]Z\d{3}$/.test(code);
}

/**
 * forecast:, county:, fire:, or marine: (any PZZ or PKZ id). The zone type comes from the affectedZones
 * URL path, never from the bare code, because fire-weather and public zone codes can coincide.
 * @param {string} affectedZoneUrl for example https://api.weather.gov/zones/fire/WAZ653
 * @returns {ZoneKey | null}
 */
export function typedZoneKey(affectedZoneUrl) {
  if (typeof affectedZoneUrl !== 'string') return null;
  const m = ZONE_PATH.exec(affectedZoneUrl.trim());
  if (!m) return null;
  const [, rawType, code] = /** @type {[string, string, string]} */ (/** @type {unknown} */ (m));
  if (isMarineCode(code)) return /** @type {ZoneKey} */ (`marine:${code}`);
  /** @type {ZoneType | null} */
  let type = null;
  if (rawType === 'county') type = 'county';
  else if (rawType === 'fire') type = 'fire';
  else if (rawType === 'forecast' || rawType === 'public') type = 'forecast';
  if (type === null) return null;
  if (type === 'county' ? code[2] !== 'C' : code[2] !== 'Z') return null;
  return /** @type {ZoneKey} */ (`${type}:${code}`);
}

/**
 * Splits a typed key into its type and bare code.
 * @param {ZoneKey} key
 * @returns {{ type: ZoneType, code: string }}
 */
export function splitZoneKey(key) {
  const i = key.indexOf(':');
  return { type: /** @type {ZoneType} */ (key.slice(0, i)), code: key.slice(i + 1) };
}

/** @type {Readonly<Record<ActionPosture, number>>} */
const POSTURE_ORDER = Object.freeze({ 'act-now': 0, prepare: 1, monitor: 2, ended: 3 });
/** @type {Readonly<Record<SeverityBand, number>>} */
const BAND_ORDER = Object.freeze({ extreme: 0, severe: 1, moderate: 2, minor: 3, unstated: 4 });

/** @param {string | null | undefined} iso @returns {number} */
function timeOrInfinity(iso) {
  if (typeof iso !== 'string') return Number.POSITIVE_INFINITY;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? Number.POSITIVE_INFINITY : t;
}

/**
 * Posture (act-now, prepare, monitor), then band (unstated last), then onset or effective ascending, then
 * expiry (blueprint 3.8). NTWC tsunami products are pinned first (3.7.2). Ties keep a stable order by id.
 * Returns a new array.
 * @template {DashboardAlertIndexEntry} T
 * @param {T[]} alerts
 * @returns {T[]}
 */
export function sortAlerts(alerts) {
  return [...alerts].sort((a, b) => {
    const pin = Number(b.agency === 'ntwc') - Number(a.agency === 'ntwc');
    if (pin !== 0) return pin;
    const p = POSTURE_ORDER[a.posture] - POSTURE_ORDER[b.posture];
    if (p !== 0) return p;
    const band = BAND_ORDER[a.band] - BAND_ORDER[b.band];
    if (band !== 0) return band;
    const start = timeOrInfinity(a.onset ?? a.effective) - timeOrInfinity(b.onset ?? b.effective);
    if (start !== 0 && !Number.isNaN(start)) return start;
    const end = timeOrInfinity(a.ends ?? a.expires) - timeOrInfinity(b.ends ?? b.expires);
    if (end !== 0 && !Number.isNaN(end)) return end;
    return a.alertId < b.alertId ? -1 : a.alertId > b.alertId ? 1 : 0;
  });
}

/**
 * Drops sourceLanguage and geometry for alerts.json.
 * @param {DashboardAlert} alert
 * @returns {DashboardAlertIndexEntry}
 */
export function toIndexEntry(alert) {
  /** @type {Partial<DashboardAlert>} */
  const entry = { ...alert };
  delete entry.sourceLanguage;
  delete entry.geometry;
  return /** @type {DashboardAlertIndexEntry} */ (entry);
}

/**
 * The source-authored text block for a display language (`lang=fr` selects the agency's own French
 * block). A missing language is never synthesized: when the requested language is absent, the English
 * block comes back with `requestedAvailable: false` so the card can say the agency published no French
 * text. Returns null only when the alert carries no text at all.
 * @param {Record<string, AlertLanguageBlock>} sourceLanguage
 * @param {'en' | 'fr'} lang
 * @returns {{ tag: string, block: AlertLanguageBlock, requestedAvailable: boolean } | null}
 */
export function languageBlockFor(sourceLanguage, lang) {
  const tags = Object.keys(sourceLanguage ?? {});
  const match = (/** @type {string} */ prefix) => tags.find((t) => t.toLowerCase().startsWith(`${prefix}-`) || t.toLowerCase() === prefix);
  const wanted = match(lang);
  if (wanted) return { tag: wanted, block: /** @type {AlertLanguageBlock} */ (sourceLanguage[wanted]), requestedAvailable: true };
  const fallback = match('en') ?? tags[0];
  if (fallback === undefined) return null;
  return { tag: fallback, block: /** @type {AlertLanguageBlock} */ (sourceLanguage[fallback]), requestedAvailable: false };
}

/**
 * Rebuilds a full alert from the split snapshot files. Missing text stays missing (an empty record is
 * never filled with invented words); missing geometry is null.
 * @param {DashboardAlertIndexEntry} entry
 * @param {Record<string, AlertLanguageBlock> | null} text
 * @param {Geometry | null} geometry
 * @returns {DashboardAlert}
 */
export function joinAlert(entry, text, geometry) {
  return { ...entry, sourceLanguage: text ?? {}, geometry: geometry ?? null };
}

/**
 * Alerts page grouping: alerts whose `nationIds` include the Nation; alerts elsewhere in a jurisdiction
 * the Nation belongs to (or a marine alert for a coastal Nation's waters) as nearby; the rest elsewhere.
 * @template {DashboardAlert | DashboardAlertIndexEntry} T
 * @param {T[]} alerts
 * @param {NationRecord} nation
 * @returns {{ forNation: T[], nearby: T[], elsewhere: T[] }}
 */
export function groupForNation(alerts, nation) {
  /** @type {T[]} */
  const forNation = [];
  /** @type {T[]} */
  const nearby = [];
  /** @type {T[]} */
  const elsewhere = [];
  const js = new Set(nation.jurisdictions);
  const marine = new Set(nation.nws?.marineZones ?? []);
  for (const a of alerts) {
    if (a.nationIds.includes(nation.id)) forNation.push(a);
    else if (a.jurisdictions.some((j) => j !== 'MARINE' && js.has(j)) || a.zones.some((z) => marine.has(z))) nearby.push(a);
    else elsewhere.push(a);
  }
  return { forNation, nearby, elsewhere };
}
