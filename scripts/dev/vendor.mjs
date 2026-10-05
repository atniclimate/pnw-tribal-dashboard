// @ts-check
/**
 * Vendor the runtime dependencies into site/static/vendor/ (blueprint 2.3):
 *   maplibre-gl 6.12.0 from node_modules/maplibre-gl/dist/ (maplibre-gl.mjs, maplibre-gl-shared.mjs,
 *   maplibre-gl-worker.mjs, maplibre-gl.css, plus LICENSE.txt from the package) into
 *   vendor/maplibre-gl-6.12.0/, and topojson-client 3.1.0 into vendor/topojson-client-3.1.0/; then write
 *   vendor/manifest.json with each npm tarball URL, its `integrity` value from package-lock.json, and the
 *   SHA-256 of every vendored file. scripts/check/vendor-integrity.mjs recomputes all of it in CI.
 *
 * SKELETON (lane L0). Owner: lane L8. The exact versions are pinned in package.json; a version bump is one
 * reviewed change that re-runs this script.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const VENDOR_PLAN = Object.freeze({
  'maplibre-gl': Object.freeze({ version: '6.12.0', dir: 'maplibre-gl-6.12.0', files: ['dist/maplibre-gl.mjs', 'dist/maplibre-gl-shared.mjs', 'dist/maplibre-gl-worker.mjs', 'dist/maplibre-gl.css', 'LICENSE.txt'] }),
  'topojson-client': Object.freeze({ version: '3.1.0', dir: 'topojson-client-3.1.0', files: ['dist/topojson-client.min.js', 'LICENSE'] }),
});

/** @returns {Promise<void>} */
export async function vendor() {
  throw new Error('not implemented (lane L8)');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await vendor();
}
