// @ts-check
/**
 * Curated compile (blueprint 2.1, 6.3): turns data/**\/*.yaml and data/contacts/*.csv into
 * site/data/curated/*.json. Runs at `npm run dev`, in CI, and in deploy.yml.
 *
 *   node scripts/compile/all.mjs [--fallback <production curated URL>]
 *
 * L0 skeleton: runs each compiler and stops on the first failure. `--fallback` (download the last good
 * compiled files from production and record the failure in health.json) is implemented by lane L9.
 * Owner after Wave 0: L0 (this runner), L6 (contacts.mjs, curated.mjs), sources.mjs (L0 minimal; L15
 * adds DATA.md generation).
 */
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compileSources } from './sources.mjs';
import { compileContacts } from './contacts.mjs';
import { compileCurated } from './curated.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const CURATED_DIR = path.join(ROOT, 'site', 'data', 'curated');

/**
 * @typedef {{ root: string, outDir: string, generatedAt: string }} CompileContext
 * @typedef {{ outputs: string[], skipped: string | null }} CompileResult
 */

/** @returns {CompileContext} */
export function compileContext() {
  return { root: ROOT, outDir: CURATED_DIR, generatedAt: process.env.CTHD_BUILD_TIME ?? new Date().toISOString() };
}

async function main() {
  const ctx = compileContext();
  await mkdir(ctx.outDir, { recursive: true });
  const fallback = process.argv.includes('--fallback');
  const steps = /** @type {const} */ ([['sources', compileSources], ['contacts', compileContacts], ['curated', compileCurated]]);
  for (const [name, fn] of steps) {
    try {
      const r = await fn(ctx);
      console.log(`compile:${name} ${r.skipped ? `skipped (${r.skipped})` : `wrote ${r.outputs.map((o) => path.relative(ROOT, o).split(path.sep).join('/')).join(', ') || 'nothing'}`}`);
    } catch (e) {
      console.error(`compile:${name} failed: ${/** @type {Error} */ (e).message}`);
      if (fallback) console.error('compile: --fallback is not implemented yet (lane L9)');
      process.exit(1);
    }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
