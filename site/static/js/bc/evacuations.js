// @ts-check
/**
 * EMCR evacuation orders and alerts (candidate; never merged into alert counts). DOM-free.
 *
 * Reads the `Evacuation_Orders_and_Alerts` layer as GeoJSON. `ORDER_ALERT_STATUS` "Order" is an
 * evacuation order (act-now) and "Alert" an evacuation alert (prepare) under atni-cthd-emcr 0.1.0
 * (provisional, Q8); any other status (rescinded, all clear) is counted and not listed. Names and the
 * issuing agency are kept exactly as the province publishes them.
 */
import { mapEmcr, MAPPING_TABLES } from '../alerts/mapping.js';
import { arcgisDate, polygonOrNull } from './rfc-advisories.js';

/** @typedef {import('../types.js').BcHazardItem} BcHazardItem */

export const EMCR_SOURCE_ID = 'bc-emcr-evacuations';

/** @param {unknown} v @returns {v is Record<string, unknown>} */
function isRecord(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** @param {unknown} v @returns {string} */
function str(v) {
  return typeof v === 'string' ? v.trim() : '';
}

/**
 * @param {unknown} geojson
 * @param {{ fetchedAt: string, now: Date }} ctx
 * @returns {{ items: BcHazardItem[], diagnostics: Record<string, number> }}
 */
export function normalizeEvacuations(geojson, ctx) {
  /** @type {{ itemsFailed: number, notActive: number, exceededTransferLimit: number, collectionRejected?: number }} */
  const diagnostics = { itemsFailed: 0, notActive: 0, exceededTransferLimit: 0 };
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
    if (!p) { diagnostics.itemsFailed += 1; continue; }
    const status = str(p.ORDER_ALERT_STATUS);
    const mapped = mapEmcr(status);
    if (mapped.posture === 'ended' || (mapped.posture !== 'act-now' && mapped.posture !== 'prepare')) { diagnostics.notActive += 1; continue; }
    const rawId = p.EMRG_OAA_SYSID ?? p.OBJECTID ?? (isRecord(f) ? f.id : undefined);
    const id = typeof rawId === 'number' || typeof rawId === 'string' ? String(rawId) : '';
    const title = str(p.ORDER_ALERT_NAME) || str(p.EVENT_NAME);
    if (id === '' || title === '') { diagnostics.itemsFailed += 1; continue; }
    items.push({
      id: `bc-emcr:${id}`,
      sourceId: EMCR_SOURCE_ID,
      kind: mapped.posture === 'act-now' ? 'evacuation-order' : 'evacuation-alert',
      title,
      status,
      issuedBy: str(p.ISSUING_AGENCY) || null,
      updatedAt: arcgisDate(p.DATE_MODIFIED),
      band: mapped.band,
      posture: mapped.posture,
      mappingApplied: { ...MAPPING_TABLES.emcr },
      nationIds: [],
      geometry: isRecord(f) ? polygonOrNull(f.geometry) : null,
    });
  }
  return { items, diagnostics };
}
