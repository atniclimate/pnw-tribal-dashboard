// @ts-check
/**
 * Shared inputs for the map tests (lane L8): real DashboardAlert objects built from the dated NWS captures
 * of 10/05/2026 by lane L3's normalizer, never invented. A polygon alert is a normalized alert joined with
 * the geometry its own capture carries, which is what alerts/model.js joinAlert does at runtime.
 */
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { normalizeNwsCollection } from '../../../site/static/js/alerts/nws.js';
import { ctxOf, fixture } from '../alerts/helpers.mjs';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const require = createRequire(import.meta.url);

/** The real topojson-client, the same version that is vendored. @type {typeof import('topojson-client')} */
export const topojson = require('topojson-client');

/**
 * @returns {{ zoneAlerts: any[], polygonAlert: any }} alerts normalized from real captures
 */
export function realAlerts() {
  const active = fixture('nws-alerts-active', 'footprint-active.json');
  const zoneAlerts = normalizeNwsCollection(active.body, ctxOf(active.meta)).alerts.filter((/** @type {any} */ a) => (a.zones ?? []).length > 0);
  const page = fixture('nws-alerts-active', 'cancel-collection-page-1.json');
  const normalized = normalizeNwsCollection(page.body, ctxOf(page.meta)).alerts;
  const feature = page.body.features.find((/** @type {any} */ f) => f.geometry);
  const own = normalized.find((/** @type {any} */ a) => a.provenance.originalId === feature.id || a.provenance.originalId === feature.properties?.id);
  if (!own) throw new Error('The polygon capture has no normalized alert');
  const polygonAlert = {
    ...own,
    geometry: feature.geometry,
    provenance: { ...own.provenance, coverage: { ...own.provenance.coverage, geometryBasis: 'polygon' } },
  };
  return { zoneAlerts, polygonAlert };
}

/** @param {string} rel path under the repository root @returns {string} file URL */
export const fileUrl = (rel) => pathToFileURL(path.join(ROOT, rel)).href;
