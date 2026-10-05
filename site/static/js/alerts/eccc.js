// @ts-check
/**
 * ECCC GeoMet weather-alerts normalizer (port of CAST parseEcccGeoMet; blueprint 3.7.4). English and
 * French kept verbatim. DOM-free.
 *
 * Field mapping follows CAST `packages/ingest-eccc/src/geomet.ts` and `normalizer.ts`: `alert_name_*` and
 * `alert_text_*` become the `en-CA` and `fr-CA` blocks (a missing language is never synthesized),
 * `publication_datetime` is `sent`, `validity_datetime` is `effective` and `onset`,
 * `expiration_datetime` is `expires`, `alert_type` drives the posture suffix rule and the designation,
 * `impact_*`, `risk_colour_*`, and CAP `severity` set the band in that order, `confidence_*` is the
 * certainty, and status "ended" maps to posture ended (which leaves the active list). The dashboard keeps
 * every valid feature when another fails, accepts `geometry: null` from `skipGeometry=true` requests
 * (polygons then come from alerts-geometry.json), and records `event_end_datetime` as `ends`.
 */
import { createAlertId } from './model.js';
import { mapEcccDimensions, MAPPING_TABLES } from './mapping.js';
import { designationOf } from './designation.js';
import { categorize } from './categories.js';
import { emptyDiagnostics } from './nws.js';

/** @typedef {import('../types.js').PageId} PageId */
/** @typedef {import('../types.js').DashboardAlert} DashboardAlert */
/** @typedef {import('../types.js').AlertDiagnostics} AlertDiagnostics */
/** @typedef {import('../types.js').AlertScope} AlertScope */
/** @typedef {import('../types.js').AlertLanguageBlock} AlertLanguageBlock */
/** @typedef {import('../types.js').HazardCategory} HazardCategory */
/** @typedef {import('../types.js').Geometry} Geometry */
/**
 * @typedef {{ fetchedAt: string, now: Date, sourceId?: string,
 *   tables?: { nws: Record<string, HazardCategory[]>, eccc: Record<string, HazardCategory[]> } }} EcccContext
 */

export const ECCC_SOURCE_ID = 'eccc-geomet-weather-alerts';
/** CAST ECCC_TRANSLATION_AUTHORITY. */
export const ECCC_AUTHORITY = 'ECCC';
export const ECCC_SENDER = 'Environment and Climate Change Canada';
/** The British Columbia footprint box for browser top-ups without a selected Nation. */
export const BC_BBOX = Object.freeze(/** @type {[number, number, number, number]} */ ([-139.1, 48.2, -114.0, 60.0]));
/**
 * Measured 10/05/2026: 4.1 KB per feature with geometry across the 24 alerts then in effect in Canada
 * (98,528 bytes), and 7.7 KB per feature in CAST's 07/17/2026 capture. Browser top-ups skip geometry when
 * the expected response (features times the larger figure) would exceed 300 KB.
 */
export const ECCC_BYTES_PER_FEATURE = 7_700;
export const ECCC_TOPUP_MAX_BYTES = 300_000;

/** @param {unknown} v @returns {v is Record<string, unknown>} */
function isRecord(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
/** @param {unknown} v @returns {string | undefined} */
function optionalString(v) {
  return typeof v === 'string' && v.trim() !== '' ? v : undefined;
}
/** @param {unknown} v @param {string} label @returns {string} */
function requireString(v, label) {
  if (typeof v !== 'string' || v.trim() === '') throw new Error(`${label} must be a non-empty string`);
  return v;
}
/** @param {unknown} v @param {string} label @returns {string} */
function requireTimestamp(v, label) {
  const t = requireString(v, label);
  if (Number.isNaN(Date.parse(t))) throw new Error(`${label} must be a timestamp`);
  return t;
}
/** @param {unknown} v @returns {boolean} */
function validPosition(v) {
  return Array.isArray(v) && v.length >= 2 && v.every((c) => typeof c === 'number' && Number.isFinite(c));
}
/** @param {unknown} v @returns {boolean} */
function validRing(v) {
  return Array.isArray(v) && v.length >= 4 && v.every(validPosition);
}
/** @param {unknown} v @returns {boolean} */
function validPolygon(v) {
  return Array.isArray(v) && v.length > 0 && v.every(validRing);
}
/**
 * CAST requirePolygonGeometry, except that null (a skipGeometry response) is allowed.
 * @param {unknown} v @param {string} label @returns {Geometry | null}
 */
function polygonOrNull(v, label) {
  if (v === null || v === undefined) return null;
  if (!isRecord(v)) throw new Error(`${label} must be an object`);
  if (v.type === 'Polygon' && validPolygon(v.coordinates)) return /** @type {Geometry} */ (/** @type {unknown} */ (v));
  if (v.type === 'MultiPolygon' && Array.isArray(v.coordinates) && v.coordinates.length > 0 && v.coordinates.every(validPolygon)) {
    return /** @type {Geometry} */ (/** @type {unknown} */ (v));
  }
  throw new Error(`${label} must be a valid Polygon or MultiPolygon`);
}

/**
 * CAST `language`: both name and text, or neither; a lone half is a malformed item.
 * @param {Record<string, unknown>} p @param {'en' | 'fr'} suffix @param {string} tag
 * @returns {AlertLanguageBlock | undefined}
 */
function language(p, suffix, tag) {
  const headline = optionalString(p[`alert_name_${suffix}`]);
  const description = optionalString(p[`alert_text_${suffix}`]);
  if (headline === undefined && description === undefined) return undefined;
  if (headline === undefined || description === undefined) throw new Error(`${tag} requires both alert_name_${suffix} and alert_text_${suffix}`);
  return { headline: headline.trim(), description: description.trim() };
}

/**
 * @param {unknown} feature
 * @param {number} itemIndex
 * @param {EcccContext} ctx
 * @returns {DashboardAlert}
 */
function normalizeEcccFeature(feature, itemIndex, ctx) {
  if (!isRecord(feature)) throw new Error(`feature ${itemIndex} must be an object`);
  if (feature.type !== 'Feature') throw new Error(`feature ${itemIndex}.type must be "Feature"`);
  if (!isRecord(feature.properties)) throw new Error(`feature ${itemIndex}.properties must be an object`);
  const p = feature.properties;
  const originalId = requireString(optionalString(p.id) ?? feature.id, `feature ${itemIndex}.id`).trim();
  const sent = requireTimestamp(p.publication_datetime, `feature ${itemIndex}.properties.publication_datetime`);
  const effective = optionalString(p.validity_datetime) ?? optionalString(p.publication_datetime) ?? sent;
  requireTimestamp(effective, `feature ${itemIndex}.properties.validity_datetime`);
  const expiresValue = optionalString(p.expiration_datetime);
  if (expiresValue !== undefined) requireTimestamp(expiresValue, `feature ${itemIndex}.properties.expiration_datetime`);
  const endsValue = optionalString(p.event_end_datetime);
  const ends = endsValue !== undefined && !Number.isNaN(Date.parse(endsValue)) ? endsValue : undefined;

  const en = language(p, 'en', 'en-CA');
  const fr = language(p, 'fr', 'fr-CA');
  if (!en && !fr) throw new Error(`feature ${itemIndex} has no source language block`);
  /** @type {Record<string, AlertLanguageBlock>} */
  const sourceLanguage = {};
  if (en) sourceLanguage['en-CA'] = en;
  if (fr) sourceLanguage['fr-CA'] = fr;

  const alertType = requireString(p.alert_type, `feature ${itemIndex}.properties.alert_type`);
  const event = (optionalString(p.alert_short_name_en) ?? optionalString(p.alert_name_en) ?? optionalString(p.alert_short_name_fr)
    ?? requireString(p.alert_name_fr, `feature ${itemIndex}.properties.alert_name_fr`)).trim();
  const designationName = (optionalString(p.alert_name_en) ?? requireString(p.alert_name_fr, `feature ${itemIndex}.properties.alert_name_fr`)).trim();
  const province = requireString(p.province, `feature ${itemIndex}.properties.province`);
  const status = optionalString(p.status_en)?.toLowerCase() ?? optionalString(p.status_fr)?.toLowerCase() ?? '';
  const ended = status === 'ended' || status === 'terminée' || status === 'terminé';
  const onset = optionalString(p.validity_datetime);
  const areaDesc = optionalString(p.feature_name_en) ?? optionalString(p.feature_name_fr);
  const severity = optionalString(p.severity);
  const urgency = optionalString(p.urgency);
  const impact = optionalString(p.impact_en) ?? optionalString(p.impact_fr);
  const colour = optionalString(p.risk_colour_en) ?? optionalString(p.risk_colour_fr);
  const confidence = optionalString(p.confidence_en) ?? optionalString(p.confidence_fr);
  const geometry = polygonOrNull(feature.geometry, `feature ${itemIndex}.geometry`);

  const mapped = mapEcccDimensions({
    mscImpact: impact ?? null,
    colour: colour ?? null,
    severity: severity ?? null,
    urgency: urgency ?? null,
    certainty: confidence ?? null,
    event: alertType,
    ended,
  });
  const tables = ctx.tables ?? { nws: {}, eccc: {} };
  let categories = categorize(designationName, 'eccc', tables);
  const frName = optionalString(p.alert_name_fr);
  if (categories[0] === 'other' && frName) categories = categorize(frName, 'eccc', tables);
  const alertId = createAlertId('eccc', originalId);
  const featureId = optionalString(p.feature_id);

  /** @type {DashboardAlert} */
  const alert = {
    alertId,
    eventId: alertId,
    sourceId: ctx.sourceId ?? ECCC_SOURCE_ID,
    sent,
    messageType: alertType.trim().toLowerCase() === 'cancel' ? 'cancel' : 'alert',
    references: [],
    lifecycleState: 'active',
    event,
    originalDesignation: designationName,
    band: mapped.band,
    posture: mapped.posture,
    confidence: mapped.confidence,
    effective,
    expires: expiresValue ?? null,
    geometry,
    sourceLanguage,
    translationAuthority: ECCC_AUTHORITY,
    provenance: {
      agency: 'eccc',
      originalId,
      fetchedAt: ctx.fetchedAt,
      mappingApplied: { ...MAPPING_TABLES.eccc },
      coverage: {
        geometryBasis: geometry === null ? 'none' : 'polygon',
        geocodes: [`province:${province}`],
      },
    },
    agency: 'eccc',
    designation: designationOf(alertType, 'eccc') === 'other' ? designationOf(designationName, 'eccc') : designationOf(alertType, 'eccc'),
    categories,
    zones: [],
    jurisdictions: province.trim().toUpperCase() === 'BC' ? ['BC'] : [],
    marine: categories.includes('marine'),
    nationIds: [],
    senderName: ECCC_SENDER,
    webUrl: ecccWebUrl(province),
  };
  if (onset !== undefined) Object.assign(alert, { onset });
  if (areaDesc !== undefined) alert.areaDesc = areaDesc.trim();
  if (ends !== undefined) alert.ends = ends;
  if (urgency !== undefined) alert.urgency = urgency;
  if (confidence !== undefined) alert.certainty = confidence;
  if (severity !== undefined) alert.severity = severity;
  // Source identifiers kept verbatim: the forecast region (matched against a Nation's eccc.forecastZones)
  // and ECCC's alert code.
  /** @type {Record<string, string[]>} */
  const parameters = {};
  if (featureId) parameters.feature_id = [featureId];
  const alertCode = optionalString(p.alert_code);
  if (alertCode) parameters.alert_code = [alertCode];
  if (Object.keys(parameters).length > 0) alert.parameters = parameters;
  return alert;
}

/**
 * The ECCC public alert table filtered to a province (human-readable, never the API). Verified
 * 10/05/2026: weather.gc.ca links its province tables this way; the older /warnings/index_e.html page
 * returns HTTP 404.
 * @param {string} province two-letter code
 * @returns {string}
 */
export function ecccWebUrl(province) {
  const p = String(province ?? '').trim().toUpperCase();
  return /^[A-Z]{2}$/.test(p) ? `https://weather.gc.ca/index_e.html?alertTableFilterProv=${p}#alerttable` : 'https://weather.gc.ca/index_e.html#alerttable';
}

/**
 * numberMatched above the features returned sets diagnostics.truncated.
 * @param {unknown} collection
 * @param {{ fetchedAt: string, now: Date }} ctx
 * @returns {{ alerts: DashboardAlert[], diagnostics: AlertDiagnostics, failures: { id: string | null, reason: string }[] }}
 */
export function normalizeEcccCollection(collection, ctx) {
  const diagnostics = emptyDiagnostics();
  /** @type {DashboardAlert[]} */
  const alerts = [];
  /** @type {{ id: string | null, reason: string }[]} */
  const failures = [];
  if (!isRecord(collection) || collection.type !== 'FeatureCollection' || !Array.isArray(collection.features)) {
    failures.push({ id: null, reason: 'eccc-geomet-invalid-collection: GeoMet payload must be a FeatureCollection with a features array' });
    diagnostics.itemsFailed = 1;
    diagnostics.collectionRejected = 1;
    return { alerts, diagnostics, failures };
  }
  collection.features.forEach((feature, i) => {
    try {
      alerts.push(normalizeEcccFeature(feature, i, /** @type {EcccContext} */ (ctx)));
    } catch (e) {
      const id = isRecord(feature) && isRecord(feature.properties)
        ? optionalString(feature.properties.id) ?? optionalString(feature.id) ?? null
        : null;
      failures.push({ id, reason: `eccc-geomet-invalid-feature: ${e instanceof Error ? e.message : String(e)}` });
    }
  });
  diagnostics.itemsFailed = failures.length;
  const matched = collection.numberMatched;
  diagnostics.truncated = typeof matched === 'number' && Number.isFinite(matched) && matched > collection.features.length;
  if (typeof matched === 'number') diagnostics.numberMatched = matched;
  return { alerts, diagnostics, failures };
}

/**
 * The OGC `next` link of a GeoMet page, or null.
 * @param {unknown} data
 * @returns {string | null}
 */
export function ecccNextPage(data) {
  if (!isRecord(data) || !Array.isArray(data.links)) return null;
  for (const l of data.links) {
    if (isRecord(l) && l.rel === 'next' && typeof l.href === 'string' && /^https:\/\//.test(l.href)) return l.href;
  }
  return null;
}

/**
 * The newest `timeStamp` or `publication_datetime` of a GeoMet response (the upstream data time).
 * @param {unknown} data
 * @param {DashboardAlert[]} alerts
 * @returns {string | null}
 */
export function ecccAsOf(data, alerts) {
  const times = alerts.map((a) => a.sent).filter((t) => !Number.isNaN(Date.parse(t)));
  if (isRecord(data) && typeof data.timeStamp === 'string' && !Number.isNaN(Date.parse(data.timeStamp))) times.push(data.timeStamp);
  if (times.length === 0) return null;
  return times.reduce((a, b) => (Date.parse(a) >= Date.parse(b) ? a : b));
}

/**
 * filter=properties.province=BC&limit=500 plus bbox in browser top-ups.
 * @param {AlertScope} scope
 * @param {{ bbox?: [number, number, number, number], skipGeometry?: boolean }} [opts]
 * @returns {Record<string, string>}
 */
export function ecccRequestParams(scope, opts) {
  /** @type {Record<string, string>} */
  const params = { filter: 'properties.province=BC', limit: '500' };
  /** @type {[number, number, number, number] | undefined} */
  let bbox = opts?.bbox;
  if (bbox === undefined && scope.kind === 'nation' && scope.nation.country === 'CA') bbox = scope.nation.bbox;
  if (bbox !== undefined) params.bbox = bbox.map((n) => String(n)).join(',');
  if (opts?.skipGeometry) params.skipGeometry = 'true';
  return params;
}

/**
 * Whether a browser top-up should skip geometry, from the count of British Columbia features in the
 * current snapshot (blueprint 3.7.4: skip when a storm-day response would exceed 300 KB).
 * @param {number} expectedFeatures
 * @returns {boolean}
 */
export function ecccSkipGeometry(expectedFeatures) {
  return expectedFeatures * ECCC_BYTES_PER_FEATURE > ECCC_TOPUP_MAX_BYTES;
}

/**
 * Direct ECCC top-up runs only when British Columbia is in scope: a British Columbia Nation, a
 * jurisdiction filter that includes BC, or the Alerts page (blueprint 3.7.4).
 * @param {AlertScope} scope
 * @param {PageId} page
 * @returns {boolean}
 */
export function ecccInScope(scope, page) {
  if (page === 'alerts') return true;
  if (scope.kind === 'nation') return scope.nation.country === 'CA' || scope.nation.jurisdictions.includes('BC');
  return Array.isArray(scope.jurisdictions) && scope.jurisdictions.includes('BC');
}
