// @ts-check
/**
 * NWS CAP normalizer and request plan (blueprint 3.7.3). Ports CAST ingest-nws, with the dashboard failure
 * policy (ADR 0007). DOM-free.
 *
 * Decoding follows CAST `packages/ingest-nws/src/index.ts` field for field (required fields, timestamp
 * checks, polygon-only geometry, UGC plus SAME geocodes, namespaced references, VTEC parameters). The
 * dashboard differs in three ways, each deliberate: a failed item never rejects the batch (every valid
 * alert is kept and the failure is counted); a truncated collection is reported as `truncated` instead of
 * rejected; and CAP statuses other than Actual (Test, Exercise, System, Draft) are all excluded and
 * counted, where CAST excludes Test and Exercise only.
 */
import { createAlertId, isMarineCode, typedZoneKey, UGC_CODE } from './model.js';
import { mapNwsDimensions, MAPPING_TABLES } from './mapping.js';
import { designationOf } from './designation.js';
import { categorize, withTextCategories } from './categories.js';
import { jurisdictionsOf } from './footprint.js';

/** @typedef {import('../types.js').DashboardAlert} DashboardAlert */
/** @typedef {import('../types.js').AlertDiagnostics} AlertDiagnostics */
/** @typedef {import('../types.js').AlertScope} AlertScope */
/** @typedef {import('../types.js').FeatureCollection} FeatureCollection */
/** @typedef {import('../types.js').ZoneKey} ZoneKey */
/** @typedef {import('../types.js').RegionCode} RegionCode */
/** @typedef {import('../types.js').HazardCategory} HazardCategory */
/** @typedef {import('../types.js').Geometry} Geometry */
/**
 * @typedef {{ fetchedAt: string, now: Date, sourceId?: string,
 *   tables?: { nws: Record<string, HazardCategory[]>, eccc: Record<string, HazardCategory[]> },
 *   marineToRegion?: Record<string, RegionCode> }} NwsContext
 */

export const NWS_SOURCE_ID = 'nws-alerts-active';
export const NWS_AUTHORITY = 'National Weather Service';
/** Codes per `zone=` request (blueprint 3.7.3). The live API accepted 500 codes on 10/05/2026. */
export const NWS_ZONE_CHUNK = 50;
/** The area list of browser top-up request 1 (footprint scope). */
export const NWS_TOPUP_AREAS = Object.freeze(['WA', 'OR', 'ID', 'PZ']);
/** The area list of the Node snapshot request. */
export const NWS_SNAPSHOT_AREAS = Object.freeze(['WA', 'OR', 'ID', 'CA', 'NV', 'MT', 'AK', 'PZ', 'PK']);
/** The pattern api.weather.gov enforces on `zone=` values; one malformed code fails the whole request (HTTP 400). */
export const NWS_ZONE_PARAM = /^(A[KLMNRSZ]|C[AOT]|D[CE]|F[LM]|G[AMU]|I[ADLN]|K[SY]|L[ACEHMOS]|M[ADEHINOPST]|N[CDEHJMVY]|O[HKR]|P[AHKMRSWZ]|S[CDL]|T[NX]|UT|V[AIT]|W[AIVY]|[HR]I)[CZ]\d{3}$/;

class NwsDecodeError extends Error {
  /** @param {string} code @param {string} message */
  constructor(code, message) {
    super(message);
    this.name = 'NwsDecodeError';
    this.code = code;
  }
}

/** @param {unknown} v @returns {v is Record<string, unknown>} */
function isRecord(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
/** @param {unknown} v @param {string} label @returns {Record<string, unknown>} */
function requireRecord(v, label) {
  if (!isRecord(v)) throw new NwsDecodeError('malformed-nws-feature', `${label} must be an object`);
  return v;
}
/** @param {unknown} v @param {string} label @returns {string} */
function requireText(v, label) {
  if (typeof v !== 'string' || v.trim() === '') throw new NwsDecodeError('missing-nws-field', `${label} must be a non-empty string`);
  return v;
}
/** @param {unknown} v @param {string} label @returns {string | undefined} */
function optionalText(v, label) {
  if (v === undefined || v === null || v === '') return undefined;
  if (typeof v !== 'string') throw new NwsDecodeError('invalid-nws-field', `${label} must be a string when present`);
  return v.trim() === '' ? undefined : v;
}
/** @param {unknown} v @param {string} label @returns {string} */
function requireTimestamp(v, label) {
  const t = requireText(v, label);
  if (Number.isNaN(Date.parse(t))) throw new NwsDecodeError('invalid-nws-timestamp', `${label} is not parseable: "${t}"`);
  return t;
}
/** @param {unknown} v @param {string} label @returns {string | undefined} */
function optionalTimestamp(v, label) {
  if (v === undefined || v === null) return undefined;
  return requireTimestamp(v, label);
}
/** @param {unknown} v @param {string} label @returns {string | null} */
function nullableTimestamp(v, label) {
  if (v === null) return null;
  if (v === undefined) throw new NwsDecodeError('missing-nws-field', `${label} must be present`);
  return requireTimestamp(v, label);
}
/** @param {unknown} v @param {string} label @returns {string | null | undefined} */
function optionalMappingValue(v, label) {
  if (v === undefined || v === null) return /** @type {null | undefined} */ (v);
  if (typeof v !== 'string') throw new NwsDecodeError('invalid-nws-field', `${label} must be a string when present`);
  return v;
}
/** @param {unknown} v @returns {'alert' | 'update' | 'cancel'} */
function decodeMessageType(v) {
  const s = requireText(v, 'properties.messageType').toLowerCase();
  if (s === 'alert' || s === 'update' || s === 'cancel') return s;
  throw new NwsDecodeError('unsupported-nws-message-type', `properties.messageType is not Alert, Update, or Cancel: "${String(v)}"`);
}
/** @param {unknown} v @param {string} label @returns {string[]} */
function decodeStringArray(v, label) {
  if (!Array.isArray(v)) throw new NwsDecodeError('invalid-nws-field', `${label} must be an array`);
  return v.map((item, i) => requireText(item, `${label}[${i}]`));
}
/** @param {unknown} v @returns {{ ugc: string[], geocodes: string[] }} */
function decodeGeocodes(v) {
  if (v === undefined || v === null) return { ugc: [], geocodes: [] };
  const g = requireRecord(v, 'properties.geocode');
  const ugc = g.UGC === undefined ? [] : decodeStringArray(g.UGC, 'geocode.UGC');
  const same = g.SAME === undefined ? [] : decodeStringArray(g.SAME, 'geocode.SAME');
  return { ugc, geocodes: [...new Set([...ugc, ...same])] };
}
/** @param {unknown} v @returns {string[]} */
function decodeReferences(v) {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) throw new NwsDecodeError('invalid-nws-references', 'properties.references must be an array');
  return v.map((ref, i) => {
    if (typeof ref === 'string') return requireText(ref, `properties.references[${i}]`);
    const r = requireRecord(ref, `properties.references[${i}]`);
    return requireText(r.identifier, `properties.references[${i}].identifier`);
  });
}
/** @param {unknown} v @returns {Record<string, string[]> | undefined} */
function decodeParameters(v) {
  if (v === undefined || v === null) return undefined;
  const src = requireRecord(v, 'properties.parameters');
  /** @type {Record<string, string[]>} */
  const out = {};
  for (const [name, items] of Object.entries(src)) out[name] = decodeStringArray(items, `properties.parameters.${name}`);
  return out;
}
/** @param {unknown} v @param {string} label @returns {number[]} */
function clonePosition(v, label) {
  if (!Array.isArray(v) || v.length < 2 || v.some((c) => typeof c !== 'number' || !Number.isFinite(c))) {
    throw new NwsDecodeError('invalid-nws-geometry', `${label} must be a finite GeoJSON position`);
  }
  return /** @type {number[]} */ ([...v]);
}
/** @param {unknown} v @param {string} label @returns {number[][]} */
function cloneRing(v, label) {
  if (!Array.isArray(v) || v.length < 4) throw new NwsDecodeError('invalid-nws-geometry', `${label} must contain at least four positions`);
  return v.map((p, i) => clonePosition(p, `${label}[${i}]`));
}
/** @param {unknown} v @param {string} label @returns {number[][][]} */
function clonePolygon(v, label) {
  if (!Array.isArray(v) || v.length === 0) throw new NwsDecodeError('invalid-nws-geometry', `${label} must contain a linear ring`);
  return v.map((ring, i) => cloneRing(ring, `${label}[${i}]`));
}
/** @param {unknown} v @returns {Geometry | null} */
function decodePolygonGeometry(v) {
  if (v === undefined || v === null) return null;
  const g = requireRecord(v, 'feature.geometry');
  if (g.type === 'Polygon') return { type: 'Polygon', coordinates: clonePolygon(g.coordinates, 'geometry.coordinates') };
  if (g.type === 'MultiPolygon') {
    if (!Array.isArray(g.coordinates) || g.coordinates.length === 0) throw new NwsDecodeError('invalid-nws-geometry', 'geometry.coordinates must contain a polygon');
    return { type: 'MultiPolygon', coordinates: g.coordinates.map((p, i) => clonePolygon(p, `geometry.coordinates[${i}]`)) };
  }
  throw new NwsDecodeError('unsupported-nws-geometry', `NWS alert geometry must be Polygon or MultiPolygon, received "${String(g.type)}"`);
}

/**
 * Typed zone keys from affectedZones (authoritative). When an item carries no affectedZones, keys come
 * from the UGC codes: county codes are county:, PZZ and PKZ codes are marine:, and zone codes are fire:
 * for fire-weather products (Red Flag Warning, Fire Weather Watch) and forecast: otherwise.
 * @param {unknown} affectedZones
 * @param {string[]} ugc
 * @param {string} event
 * @returns {ZoneKey[]}
 */
function zoneKeysOf(affectedZones, ugc, event) {
  /** @type {ZoneKey[]} */
  const keys = [];
  if (Array.isArray(affectedZones)) {
    for (const z of affectedZones) {
      const k = typeof z === 'string' ? typedZoneKey(z) : null;
      if (k && !keys.includes(k)) keys.push(k);
    }
  }
  if (keys.length > 0) return keys;
  const fireProduct = /^(red flag warning|fire weather watch)$/i.test(event.trim());
  for (const code of ugc) {
    if (!UGC_CODE.test(code)) continue;
    /** @type {ZoneKey} */
    const k = isMarineCode(code) ? `marine:${code}` : code[2] === 'C' ? `county:${code}` : fireProduct ? `fire:${code}` : `forecast:${code}`;
    if (!keys.includes(k)) keys.push(k);
  }
  return keys;
}

/**
 * The CAP status of a raw item when it is not Actual (Test, Exercise, System, Draft), else undefined.
 * A missing status is treated as Actual, as CAST does.
 * @param {unknown} v
 * @returns {string | undefined}
 */
function nonActualStatus(v) {
  if (!isRecord(v) || !isRecord(v.properties)) return undefined;
  const s = v.properties.status;
  if (typeof s !== 'string') return undefined;
  return s.trim().toLowerCase() === 'actual' ? undefined : s;
}

/** @param {unknown} v @returns {string | null} */
function originalIdOf(v) {
  if (!isRecord(v)) return null;
  if (isRecord(v.properties) && typeof v.properties.id === 'string') return v.properties.id;
  return typeof v.id === 'string' ? v.id : null;
}

/**
 * Throws on a malformed item (the collection normalizer catches it).
 * @param {unknown} feature
 * @param {{ fetchedAt: string, now: Date }} ctx
 * @returns {DashboardAlert}
 */
export function normalizeNwsFeature(feature, ctx) {
  const c = /** @type {NwsContext} */ (ctx);
  const f = requireRecord(feature, 'feature');
  if (f.type !== 'Feature') throw new NwsDecodeError('malformed-nws-feature', 'NWS alert item must have type "Feature"');
  const p = requireRecord(f.properties, 'feature.properties');
  const originalId = requireText(p.id, 'properties.id');
  const sent = requireTimestamp(p.sent, 'properties.sent');
  const effective = requireTimestamp(p.effective, 'properties.effective');
  const onset = optionalTimestamp(p.onset, 'properties.onset');
  const expires = nullableTimestamp(p.expires, 'properties.expires');
  const ends = p.ends === undefined ? undefined : p.ends === null ? null : requireTimestamp(p.ends, 'properties.ends');
  const event = requireText(p.event, 'properties.event');
  const messageType = decodeMessageType(p.messageType);
  const headline = requireText(p.headline, 'properties.headline');
  const description = requireText(p.description, 'properties.description');
  const instruction = optionalText(p.instruction, 'properties.instruction');
  const areaDesc = optionalText(p.areaDesc, 'properties.areaDesc');
  const geometry = decodePolygonGeometry(f.geometry);
  const { ugc, geocodes } = decodeGeocodes(p.geocode);
  if (geometry === null && geocodes.length === 0) {
    throw new NwsDecodeError('missing-nws-coverage', 'NWS alert has neither polygon geometry nor UGC/SAME geocodes');
  }
  const references = decodeReferences(p.references).map((r) => (r.startsWith('nws:') ? r : createAlertId('nws', r)));
  const parameters = decodeParameters(p.parameters);
  const severity = optionalMappingValue(p.severity, 'properties.severity');
  const urgency = optionalMappingValue(p.urgency, 'properties.urgency');
  const certainty = optionalMappingValue(p.certainty, 'properties.certainty');
  const mapped = mapNwsDimensions({
    ...(severity === undefined ? {} : { severity }),
    ...(urgency === undefined ? {} : { urgency }),
    ...(certainty === undefined ? {} : { certainty }),
    event,
    ended: messageType === 'cancel',
  });
  const zones = zoneKeysOf(p.affectedZones, ugc, event);
  const jurisdictions = jurisdictionsOf(zones, c.marineToRegion ?? {});
  const tables = c.tables ?? { nws: {}, eccc: {} };
  const categories = withTextCategories(categorize(event, 'nws', tables),
    [headline, description, ...(parameters?.NWSheadline ?? [])].join('\n'));
  const senderName = optionalText(p.senderName, 'properties.senderName') ?? NWS_AUTHORITY;
  const alertId = createAlertId('nws', originalId);

  /** @type {DashboardAlert} */
  const alert = {
    alertId,
    eventId: alertId,
    sourceId: c.sourceId ?? NWS_SOURCE_ID,
    sent,
    messageType,
    references,
    lifecycleState: 'active',
    event,
    originalDesignation: event,
    band: mapped.band,
    posture: mapped.posture,
    confidence: mapped.confidence,
    effective,
    expires,
    geometry,
    sourceLanguage: { 'en-US': { headline, description, ...(instruction === undefined ? {} : { instruction }) } },
    translationAuthority: NWS_AUTHORITY,
    provenance: {
      agency: 'nws',
      originalId,
      fetchedAt: ctx.fetchedAt,
      mappingApplied: { ...MAPPING_TABLES.nws },
      coverage: { geometryBasis: geometry === null ? 'zone' : 'polygon', geocodes },
    },
    agency: 'nws',
    designation: designationOf(event, 'nws'),
    categories,
    zones,
    jurisdictions,
    marine: zones.some((z) => z.startsWith('marine:')) || categories.includes('marine'),
    nationIds: [],
    senderName,
    webUrl: nwsWebUrl(p),
  };
  if (onset !== undefined) Object.assign(alert, { onset });
  if (areaDesc !== undefined) alert.areaDesc = areaDesc;
  if (ends !== undefined) alert.ends = ends;
  if (typeof urgency === 'string') alert.urgency = urgency;
  if (typeof certainty === 'string') alert.certainty = certainty;
  if (typeof severity === 'string') alert.severity = severity;
  if (parameters !== undefined) alert.parameters = parameters;
  return alert;
}

/** @returns {AlertDiagnostics} */
export function emptyDiagnostics() {
  return { testOrExerciseExcluded: 0, itemsFailed: 0, unknownZoneKeys: 0, truncated: false };
}

/**
 * Every valid item is kept; failures are counted, never fatal. Test and Exercise messages are excluded and
 * counted. A collection-level defect (not a FeatureCollection) is one failure with id null and no alerts.
 * @param {unknown} collection a GeoJSON FeatureCollection from /alerts/active
 * @param {{ fetchedAt: string, now: Date }} ctx
 * @returns {{ alerts: DashboardAlert[], diagnostics: AlertDiagnostics, failures: { id: string | null, reason: string }[] }}
 */
export function normalizeNwsCollection(collection, ctx) {
  const diagnostics = emptyDiagnostics();
  /** @type {DashboardAlert[]} */
  const alerts = [];
  /** @type {{ id: string | null, reason: string }[]} */
  const failures = [];
  if (!isRecord(collection) || collection.type !== 'FeatureCollection' || !Array.isArray(collection.features)) {
    failures.push({ id: null, reason: 'invalid-nws-collection: NWS alerts/active payload must be a FeatureCollection with a features array' });
    diagnostics.itemsFailed = 1;
    diagnostics.collectionRejected = 1;
    return { alerts, diagnostics, failures };
  }
  let otherStatus = 0;
  collection.features.forEach((feature) => {
    const status = nonActualStatus(feature);
    if (status !== undefined) {
      const s = status.trim().toLowerCase();
      if (s === 'test' || s === 'exercise') diagnostics.testOrExerciseExcluded += 1;
      else otherStatus += 1;
      return;
    }
    try {
      alerts.push(normalizeNwsFeature(feature, ctx));
    } catch (e) {
      const code = e instanceof NwsDecodeError ? e.code : 'invalid-nws-feature';
      failures.push({ id: originalIdOf(feature), reason: `${code}: ${e instanceof Error ? e.message : String(e)}` });
    }
  });
  diagnostics.itemsFailed = failures.length;
  if (otherStatus > 0) diagnostics.otherStatusExcluded = otherStatus;
  const pagination = collection.pagination;
  diagnostics.truncated = isRecord(pagination) && typeof pagination.next === 'string' && pagination.next.trim() !== '';
  return { alerts, diagnostics, failures };
}

/**
 * The `pagination.next` URL of an NWS collection page, or null.
 * @param {unknown} data
 * @returns {string | null}
 */
export function nwsNextPage(data) {
  if (!isRecord(data) || !isRecord(data.pagination)) return null;
  const next = data.pagination.next;
  return typeof next === 'string' && next.trim() !== '' ? next : null;
}

/** @param {string[]} codes @param {number} size @returns {string[][]} */
function chunk(codes, size) {
  /** @type {string[][]} */
  const out = [];
  for (let i = 0; i < codes.length; i += size) out.push(codes.slice(i, i + size));
  return out;
}

/**
 * Footprint: area=WA,OR,ID,PZ plus zone= chunks of 50 edge codes. Nation: one zone= request. Codes the API
 * would reject (malformed) are dropped, because one bad code fails the whole request with HTTP 400.
 * `message_type` is never sent, so Update messages arrive; `status=actual` excludes Test and Exercise.
 * @param {AlertScope} scope
 * @param {{ edgeCodes: string[] }} footprintUgc
 * @returns {Array<{ sourceId: string, params: Record<string, string> }>}
 */
export function nwsRequestPlan(scope, footprintUgc) {
  if (scope.kind === 'nation') {
    const nws = scope.nation.nws;
    if (!nws) return [];
    /** @type {string[]} */
    const codes = [];
    for (const key of [...nws.forecastZones, ...nws.countyZones, ...nws.fireZones, ...nws.marineZones]) {
      const code = String(key).slice(String(key).indexOf(':') + 1);
      if (NWS_ZONE_PARAM.test(code) && !codes.includes(code)) codes.push(code);
    }
    return chunk(codes, NWS_ZONE_CHUNK).map((c) => ({ sourceId: NWS_SOURCE_ID, params: { zone: c.join(','), status: 'actual' } }));
  }
  /** @type {Array<{ sourceId: string, params: Record<string, string> }>} */
  const plan = [{ sourceId: NWS_SOURCE_ID, params: { area: NWS_TOPUP_AREAS.join(','), status: 'actual' } }];
  const edge = [...new Set((footprintUgc?.edgeCodes ?? []).filter((c) => typeof c === 'string' && NWS_ZONE_PARAM.test(c)))].sort();
  for (const c of chunk(edge, NWS_ZONE_CHUNK)) plan.push({ sourceId: NWS_SOURCE_ID, params: { zone: c.join(','), status: 'actual' } });
  return plan;
}

/**
 * forecast.weather.gov product page from parameters.AWIPSidentifier, else https://www.weather.gov/<office>/.
 * The issuing office comes from the VTEC string (for example KSEW gives SEW); without VTEC the product
 * page uses the national site code. Verified against the 10/05/2026 fixtures (every form returned the
 * product text). `alerts.weather.gov` no longer resolves and is never used.
 * @param {Record<string, unknown>} properties
 * @returns {string | null}
 */
export function nwsWebUrl(properties) {
  const params = isRecord(properties?.parameters) ? properties.parameters : {};
  const first = (/** @type {unknown} */ v) => (Array.isArray(v) && typeof v[0] === 'string' ? v[0] : null);
  const awips = first(params.AWIPSidentifier);
  const vtec = first(params.VTEC);
  const office = vtec ? /\/[A-Z]\.[A-Z]{3}\.([A-Z]{4})\./.exec(vtec)?.[1]?.slice(1) ?? null : null;
  if (awips && /^[A-Z0-9]{4,6}$/.test(awips)) {
    const product = awips.slice(0, 3);
    const issuedBy = awips.slice(3);
    const site = office ?? 'NWS';
    return `https://forecast.weather.gov/product.php?site=${site}&issuedby=${issuedBy}&product=${product}`;
  }
  if (office && /^[A-Z]{3}$/.test(office)) return `https://www.weather.gov/${office.toLowerCase()}/`;
  return null;
}
