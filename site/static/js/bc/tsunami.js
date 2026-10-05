// @ts-check
/**
 * EMBC tsunami notifications, attributes only (candidate). DOM-free.
 *
 * Reads the `EMBC_Tsunami_Notifications_VIEW` layer (Tsunami_Notification_Zones) as ArcGIS JSON with
 * `returnGeometry=false` (an unfiltered query with geometry returned 9.8 MB in the link audit). Layer
 * metadata captured 10/05/2026: `STATUS` is coded 1 Tsunami Warning, 2 Tsunami Advisory, 3 Tsunami Watch,
 * 4 Cancellation, 5 No Notification; `TSUNAMI_ZONE_CLASSIFICATION` is zone A to E. Zones at No
 * Notification or Cancellation are counted, never listed. Band and posture follow atni-cthd-ntwc, the
 * same product types the National Tsunami Warning Center issues.
 */
import { mapNtwc, MAPPING_TABLES } from '../alerts/mapping.js';

/** @typedef {import('../types.js').BcHazardItem} BcHazardItem */

export const EMBC_TSUNAMI_SOURCE_ID = 'bc-embc-tsunami';
export const EMBC_ISSUER = 'Emergency Management and Climate Readiness';
/** @type {Readonly<Record<string, string>>} */
export const STATUS_CODES = Object.freeze({ 1: 'Tsunami Warning', 2: 'Tsunami Advisory', 3: 'Tsunami Watch', 4: 'Cancellation', 5: 'No Notification' });

/** @param {unknown} v @returns {v is Record<string, unknown>} */
function isRecord(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * @param {unknown} json
 * @param {{ fetchedAt: string }} ctx
 * @returns {{ items: BcHazardItem[], diagnostics: Record<string, number> }}
 */
export function normalizeTsunamiNotifications(json, ctx) {
  /** @type {{ itemsFailed: number, noNotification: number, exceededTransferLimit: number, collectionRejected?: number }} */
  const diagnostics = { itemsFailed: 0, noNotification: 0, exceededTransferLimit: 0 };
  /** @type {BcHazardItem[]} */
  const items = [];
  if (!isRecord(json) || !Array.isArray(json.features)) {
    diagnostics.itemsFailed = 1;
    diagnostics.collectionRejected = 1;
    return { items, diagnostics };
  }
  if (json.exceededTransferLimit === true) diagnostics.exceededTransferLimit = 1;
  for (const f of json.features) {
    const a = isRecord(f) && isRecord(f.attributes) ? f.attributes : isRecord(f) && isRecord(f.properties) ? f.properties : null;
    const code = a ? String(a.STATUS ?? '').trim() : '';
    const name = STATUS_CODES[code];
    if (!a || !name) { diagnostics.itemsFailed += 1; continue; }
    if (code === '4' || code === '5') { diagnostics.noNotification += 1; continue; }
    const zone = typeof a.TSUNAMI_ZONE_CLASSIFICATION === 'string' ? a.TSUNAMI_ZONE_CLASSIFICATION.trim() : '';
    const id = a.OBJECTID_1 ?? a.OBJECTID;
    if ((typeof id !== 'number' && typeof id !== 'string') || zone === '') { diagnostics.itemsFailed += 1; continue; }
    const row = mapNtwc(name.replace(/^Tsunami /, ''));
    items.push({
      id: `bc-embc-tsunami:${String(id)}`,
      sourceId: EMBC_TSUNAMI_SOURCE_ID,
      kind: 'tsunami-notification',
      title: `${name}: Tsunami Zone ${zone}`,
      status: name,
      issuedBy: EMBC_ISSUER,
      updatedAt: null,
      band: row?.band ?? 'unstated',
      posture: row?.posture ?? 'monitor',
      mappingApplied: { ...MAPPING_TABLES.ntwc },
      nationIds: [],
      geometry: null,
    });
  }
  return { items, diagnostics };
}
