// @ts-check
/**
 * BC River Forecast Centre advisories (candidate source; blueprint 3.7.2). DOM-free.
 *
 * Reads the `BC_Flood_Advisory_and_Warning_Notifications_(Public_View)` layer as GeoJSON. The `Advisory`
 * field is coded (layer metadata captured 10/05/2026): 1 No Advisory, 2 High Streamflow Advisory,
 * 3 Flood Watch, 4 Flood Warning. Basins at No Advisory are counted, never listed. Band stays unstated
 * until the maintainer ratifies atni-cthd-bcrfc (Q8); posture follows the designation.
 */
import { mapBcRfc, MAPPING_TABLES } from '../alerts/mapping.js';

/** @typedef {import('../types.js').BcHazardItem} BcHazardItem */
/** @typedef {import('../types.js').Geometry} Geometry */

export const BC_RFC_SOURCE_ID = 'bc-rfc-flood-advisories';
export const BC_RFC_ISSUER = 'BC River Forecast Centre';
/** The layer's coded values for `Advisory`. @type {Readonly<Record<number, string>>} */
export const ADVISORY_CODES = Object.freeze({ 1: 'No Advisory', 2: 'High Streamflow Advisory', 3: 'Flood Watch', 4: 'Flood Warning' });

/** @param {unknown} v @returns {v is Record<string, unknown>} */
function isRecord(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** @param {unknown} v @returns {string | null} ArcGIS epoch milliseconds to ISO 8601 */
export function arcgisDate(v) {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** @param {unknown} v @returns {Geometry | null} */
export function polygonOrNull(v) {
  if (!isRecord(v)) return null;
  return v.type === 'Polygon' || v.type === 'MultiPolygon' ? /** @type {Geometry} */ (/** @type {unknown} */ (v)) : null;
}

/**
 * Advisory domain 1 No Advisory, 2 High Streamflow Advisory, 3 Flood Watch, 4 Flood Warning; exceededTransferLimit sets degraded.
 * @param {unknown} geojson
 * @param {{ fetchedAt: string, ratified: boolean }} ctx
 * @returns {{ items: BcHazardItem[], diagnostics: Record<string, number> }}
 */
export function normalizeRfcAdvisories(geojson, ctx) {
  /** @type {{ itemsFailed: number, noAdvisory: number, exceededTransferLimit: number, collectionRejected?: number }} */
  const diagnostics = { itemsFailed: 0, noAdvisory: 0, exceededTransferLimit: 0 };
  /** @type {BcHazardItem[]} */
  const items = [];
  if (!isRecord(geojson) || !Array.isArray(geojson.features)) {
    diagnostics.itemsFailed = 1;
    diagnostics.collectionRejected = 1;
    return { items, diagnostics };
  }
  if (geojson.exceededTransferLimit === true || (isRecord(geojson.properties) && geojson.properties.exceededTransferLimit === true)) {
    diagnostics.exceededTransferLimit = 1;
  }
  for (const f of geojson.features) {
    const p = isRecord(f) && isRecord(f.properties) ? f.properties : null;
    const code = p ? Number(p.Advisory) : Number.NaN;
    const name = ADVISORY_CODES[code];
    if (!p || !name) { diagnostics.itemsFailed += 1; continue; }
    if (code === 1) { diagnostics.noAdvisory += 1; continue; }
    const basin = typeof p.Major_Basin === 'string' ? p.Major_Basin.trim() : '';
    const sub = typeof p.Sub_Basin === 'string' && p.Sub_Basin.trim() !== '' ? p.Sub_Basin.trim() : null;
    const id = isRecord(f) && (typeof f.id === 'number' || typeof f.id === 'string') ? String(f.id) : String(p.OBJECTID ?? '');
    if (id === '' || basin === '') { diagnostics.itemsFailed += 1; continue; }
    const mapped = mapBcRfc(name, { ratified: ctx.ratified });
    items.push({
      id: `bc-rfc:${id}`,
      sourceId: BC_RFC_SOURCE_ID,
      kind: 'flood-advisory',
      title: sub ? `${name}: ${basin}, ${sub}` : `${name}: ${basin}`,
      status: name,
      issuedBy: BC_RFC_ISSUER,
      updatedAt: arcgisDate(p.Date_Modified),
      band: mapped.band,
      posture: mapped.posture,
      mappingApplied: { ...MAPPING_TABLES['bc-rfc'] },
      nationIds: [],
      geometry: isRecord(f) ? polygonOrNull(f.geometry) : null,
    });
  }
  return { items, diagnostics };
}
