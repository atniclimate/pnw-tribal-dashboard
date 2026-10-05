// @ts-check
/**
 * DashboardAlert helpers mirroring @ewm/alerts-schema model.ts (blueprint 3.7.1). DOM-free.
 *
 * STUB (lane L0). Owner: lane L3. Signatures are the contract; bodies throw until the owner implements them.
 */

/** @typedef {import('../types.js').ZoneKey} ZoneKey */
/** @typedef {import('../types.js').SeverityBand} SeverityBand */
/** @typedef {import('../types.js').AlertLanguageBlock} AlertLanguageBlock */
/** @typedef {import('../types.js').DashboardAlert} DashboardAlert */
/** @typedef {import('../types.js').DashboardAlertIndexEntry} DashboardAlertIndexEntry */
/** @typedef {import('../types.js').Geometry} Geometry */

const NOT_IMPLEMENTED = 'not implemented';

/**
 * `${agency}:${originalId}`; throws on empty parts (CAST createAlertId).
 * @param {string} agency
 * @param {string} originalId
 * @returns {string}
 */
export function createAlertId(agency, originalId) {
  throw new Error(NOT_IMPLEMENTED);
}

/**
 * Null whenever either band is unstated (CAST).
 * @param {SeverityBand} left
 * @param {SeverityBand} right
 * @returns {number | null}
 */
export function compareSeverityBands(left, right) {
  throw new Error(NOT_IMPLEMENTED);
}

/**
 * CAST highestSeverityBand.
 * @param {SeverityBand[]} bands
 * @returns {SeverityBand}
 */
export function highestSeverityBand(bands) {
  throw new Error(NOT_IMPLEMENTED);
}

/**
 * forecast:, county:, fire:, or marine: (any PZZ or PKZ id).
 * @param {string} affectedZoneUrl for example https://api.weather.gov/zones/fire/WAZ653
 * @returns {ZoneKey | null}
 */
export function typedZoneKey(affectedZoneUrl) {
  throw new Error(NOT_IMPLEMENTED);
}

/**
 * Posture, then band (unstated last), then onset or effective, then expiry (blueprint 3.8).
 * @param {DashboardAlert[]} alerts
 * @returns {DashboardAlert[]}
 */
export function sortAlerts(alerts) {
  throw new Error(NOT_IMPLEMENTED);
}

/**
 * Drops sourceLanguage and geometry for alerts.json.
 * @param {DashboardAlert} alert
 * @returns {DashboardAlertIndexEntry}
 */
export function toIndexEntry(alert) {
  throw new Error(NOT_IMPLEMENTED);
}

/**
 * Rebuilds a full alert from the split snapshot files.
 * @param {DashboardAlertIndexEntry} entry
 * @param {Record<string, AlertLanguageBlock> | null} text
 * @param {Geometry | null} geometry
 * @returns {DashboardAlert}
 */
export function joinAlert(entry, text, geometry) {
  throw new Error(NOT_IMPLEMENTED);
}
