// @ts-check
/**
 * Reference builder 70: project the draft registry into site/data (blueprint 6.2 and 12.3, lane L5).
 *
 *   node scripts/reference/70-joins.mjs
 *
 * Wave 1 (this file today): per Nation `samples` (the headquarters point), `bbox` (headquarters plus 10 km),
 * the per-Nation files `site/data/registry/nations/<id>.json`, `nations-index.json`, `id-redirects.json`, and
 * `site/data/geo/hq-points.json`. Every record stays `review.status: draft`.
 *
 * Wave 2 joins that need L4 outputs are NOT done here and the fields stay null or empty, never invented:
 *   - `nws` (typed forecast, county, fire, and marine zone keys and the WFO) from `geo/footprint-ugc.json`;
 *   - `eccc` (nearest city page, distance, forecast zones) from the ECCC city page list and `eccc-regions`;
 *   - `radar` (haversine over `ref/radar-sites.json`);
 *   - `gauges` (nearby gauges from L7);
 *   - `boundary` (LAR, Census, and NRCan polygons from `40-boundaries.mjs`) and the interior `samples`.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT } from '../check/lib/pages.mjs';
import { REGISTRY_DIR, r5, stable } from './50-registry.mjs';

/** @param {number} x */
export const r4 = (x) => Math.round(x * 1e4) / 1e4;

/** Compact JSON for the headquarters layer (no indentation; trailing newline). @param {unknown} v */
export const compact = (v) => `${JSON.stringify(v)}\n`;

export const SITE_REGISTRY = path.join(ROOT, 'site', 'data', 'registry');
export const SITE_GEO = path.join(ROOT, 'site', 'data', 'geo');

/** Wave 2 joins still pending, listed so the lane report and the validator can say so honestly. */
export const PENDING_JOINS = Object.freeze(['nws zone keys', 'eccc city page', 'radar', 'gauges', 'boundary polygons', 'interior samples']);

/**
 * Headquarters plus 10 km on every side.
 * @param {number} lat @param {number} lon
 * @returns {[number, number, number, number]}
 */
export function hqBbox(lat, lon) {
  const dLat = 10 / 111.32;
  const dLon = 10 / (111.32 * Math.cos((lat * Math.PI) / 180));
  return [r5(lon - dLon), r5(lat - dLat), r5(lon + dLon), r5(lat + dLat)];
}

/**
 * Pure projection of the draft registry (testable; no file access).
 * @param {{ generatedAt: string, records: Record<string, any>[] }} draft
 * @param {{ redirects: Record<string, unknown> }} redirects
 */
export function project(draft, redirects) {
  /** @type {Record<string, any>[]} */
  const records = draft.records.map((r) => ({
    ...r,
    samples: [[r.hq.lat, r.hq.lon]],
    bbox: hqBbox(r.hq.lat, r.hq.lon),
  }));
  const index = {
    schema: 'cthd.nations-index/1',
    generatedAt: draft.generatedAt,
    nations: records.map((r) => ({
      id: r.id, name: r.name, preferredName: r.preferredName, aliases: r.aliases, jurisdictions: r.jurisdictions,
      region: r.region, kind: r.kind, hq: [r.hq.lat, r.hq.lon], tz: r.timeZone, hasBoundary: r.boundary.status === 'polygon',
    })),
  };
  // The layer is limited to 40 KB raw (budgets.json geometry.hqPoints.rawMax), so each feature carries only what the
  // circle layer needs: the promoted id `nationId` and, once a polygon exists, `hasBoundary: true` (absent means false).
  // Display names come from nations-index.json by the same id; coordinates are rounded to four decimals (about 11 m).
  const hqPoints = {
    type: 'FeatureCollection',
    features: records.map((r) => ({
      type: 'Feature',
      properties: { nationId: r.id, ...(r.boundary.status === 'polygon' ? { hasBoundary: true } : {}) },
      geometry: { type: 'Point', coordinates: [r4(r.hq.lon), r4(r.hq.lat)] },
    })),
  };
  return { records, index, hqPoints, redirects };
}

/** @param {string} rel */
const readJson = (rel) => JSON.parse(readFileSync(path.join(ROOT, rel), 'utf8'));

export function main() {
  const draft = readJson('data/registry/draft-registry.json');
  const redirectsFile = path.join(REGISTRY_DIR, 'id-redirects.json');
  if (!existsSync(redirectsFile)) writeFileSync(redirectsFile, stable({ schema: 'cthd.id-redirects/1', redirects: {} }));
  const out = project(draft, JSON.parse(readFileSync(redirectsFile, 'utf8')));
  const dir = path.join(SITE_REGISTRY, 'nations');
  mkdirSync(dir, { recursive: true });
  mkdirSync(SITE_GEO, { recursive: true });
  const keep = new Set(out.records.map((r) => `${r.id}.json`));
  // Files for ids that are no longer in the draft are removed; the id-stability gate (90-validate) reports an
  // id that vanished without a redirect, so this never hides a disappearance.
  for (const f of readdirSync(dir)) if (f.endsWith('.json') && !keep.has(f)) rmSync(path.join(dir, f));
  for (const r of out.records) writeFileSync(path.join(dir, `${r.id}.json`), stable(r));
  writeFileSync(path.join(SITE_REGISTRY, 'nations-index.json'), stable(out.index));
  writeFileSync(path.join(SITE_REGISTRY, 'id-redirects.json'), stable(out.redirects));
  writeFileSync(path.join(SITE_GEO, 'hq-points.json'), compact(out.hqPoints));
  console.log(`70-joins: ${out.records.length} Nation files, index, ${out.hqPoints.features.length} headquarters points; pending wave 2 joins: ${PENDING_JOINS.join(', ')}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
