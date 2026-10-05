// @ts-check
/**
 * Assemble the GitHub Pages artifact (blueprint 2.1, 5.12, 8.4):
 *
 *   node scripts/assemble-site.mjs --out _site --sha <git sha> [--previous <live build-info.json URL>]
 *
 * 1. Copy the allowlist: site/** except static/ (data/curated and data/live included; classic/ included
 *    until its removal date).
 * 2. Copy site/static/ to _site/v/<sha12>/.
 * 3. Rewrite href and src attribute values that begin with `./static/` or `(../)*static/` in HTML files
 *    only, to the same prefix plus `v/<sha12>/`. JavaScript and CSS are never rewritten.
 * 4. Retain the previous generation: read the live build-info.json, and when its sha12 differs, restore
 *    _site/v/<prev>/ with `git archive <prev> site/static` (checkout uses fetch-depth 0).
 * 5. Write _site/build-info.json (schemas/build-info.schema.json) and the service worker precache list.
 *
 * SKELETON (lane L0). Owner: lane L9.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Top-level entries of site/ that are deployed (static/ is deployed as v/<sha12>/). */
export const ALLOWLIST = Object.freeze(['index.html', '404.html', 'offline.html', 'sw.js', 'embed.js', 'manifest.webmanifest',
  'robots.txt', '.nojekyll', 'alerts', 'forecasts', 'contacts', 'resources', 'safety', 'news', 'usage', 'archive', 'embed', 'classic', 'data']);

/**
 * Rewrite static asset references in one HTML document.
 * @param {string} html
 * @param {string} sha12
 * @returns {string}
 */
export function rewriteHtml(html, sha12) {
  throw new Error('not implemented (lane L9)');
}

/**
 * @param {{ out: string, sha: string, previous: string | null }} opts
 * @returns {Promise<{ sha12: string, files: number, retained: string | null }>}
 */
export async function assemble(opts) {
  throw new Error('not implemented (lane L9)');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await assemble({ out: '_site', sha: '', previous: null });
}
