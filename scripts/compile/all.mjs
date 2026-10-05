// @ts-check
/**
 * Curated compile (blueprint 2.1, 6.3): turns data/**\/*.yaml and data/contacts/*.csv into
 * site/data/curated/*.json. Runs at `npm run dev`, in CI, and in deploy.yml.
 *
 *   node scripts/compile/all.mjs [--fallback <production curated URL>]
 *
 * Without `--fallback` the first failing compiler stops the run (exit 1), so CI blocks a bad curated edit.
 * With `--fallback` (deploy.yml only), a failure downloads the last good compiled files from production
 * (`restoreCurated`), records the failure for the snapshot runner's health.json (`recordCompileFailure`),
 * and exits 0 so live snapshots keep deploying. If any compiled file cannot be restored, the run exits 1
 * instead: the deploy stops and the last good deployment keeps serving, rather than publishing pages
 * without their curated data. A clean compile clears any earlier failure record.
 * Owner after Wave 0: L0 (this runner), L6 (contacts.mjs, curated.mjs), sources.mjs (L0 minimal; L15
 * adds DATA.md generation), L9 (scripts/lib/compile-fallback.mjs).
 */
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compileSources } from './sources.mjs';
import { compileContacts } from './contacts.mjs';
import { compileCurated } from './curated.mjs';
import { clearCompileFailure, recordCompileFailure, restoreCurated } from '../lib/compile-fallback.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const CURATED_DIR = path.join(ROOT, 'site', 'data', 'curated');

/**
 * @typedef {{ root: string, outDir: string, generatedAt: string }} CompileContext
 * @typedef {{ outputs: string[], skipped: string | null }} CompileResult
 * @typedef {(ctx: CompileContext) => Promise<CompileResult>} Compiler
 */

/** @type {ReadonlyArray<readonly [string, Compiler]>} */
export const STEPS = Object.freeze([['sources', compileSources], ['contacts', compileContacts], ['curated', compileCurated]]);

/** @returns {CompileContext} */
export function compileContext() {
  return { root: ROOT, outDir: CURATED_DIR, generatedAt: process.env.CTHD_BUILD_TIME ?? new Date().toISOString() };
}

/**
 * The `--fallback` base URL from argv: undefined when the flag is absent, null when it has no URL.
 * @param {string[]} argv
 * @returns {string | null | undefined}
 */
export function fallbackBase(argv) {
  const i = argv.indexOf('--fallback');
  if (i < 0) return undefined;
  const v = argv[i + 1];
  return v && !v.startsWith('--') ? v : null;
}

/**
 * Run every compiler in order. Returns the process exit code.
 * @param {CompileContext} ctx
 * @param {{ fallback?: string, steps?: ReadonlyArray<readonly [string, Compiler]>,
 *   restore?: typeof restoreCurated, record?: typeof recordCompileFailure, clear?: typeof clearCompileFailure,
 *   log?: (line: string) => void, error?: (line: string) => void }} [opts]
 * @returns {Promise<number>}
 */
export async function compileAll(ctx, opts = {}) {
  const log = opts.log ?? ((l) => console.log(l));
  const error = opts.error ?? ((l) => console.error(l));
  await mkdir(ctx.outDir, { recursive: true });
  for (const [name, fn] of opts.steps ?? STEPS) {
    try {
      const r = await fn(ctx);
      log(`compile:${name} ${r.skipped ? `skipped (${r.skipped})` : `wrote ${r.outputs.map((o) => path.relative(ctx.root, o).split(path.sep).join('/')).join(', ') || 'nothing'}`}`);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      error(`compile:${name} failed: ${message}`);
      if (opts.fallback === undefined) return 1;
      const { restored, missing } = await (opts.restore ?? restoreCurated)({ base: opts.fallback, outDir: ctx.outDir });
      await (opts.record ?? recordCompileFailure)(ctx.root, { step: name, message, at: new Date().toISOString() });
      log(`compile: --fallback restored ${restored.length} file(s) from ${opts.fallback}${restored.length ? `: ${restored.join(', ')}` : ''}`);
      if (missing.length) {
        error(`compile: --fallback could not restore ${missing.join(', ')}; stopping so the last good deployment keeps serving`);
        return 1;
      }
      return 0;
    }
  }
  await (opts.clear ?? clearCompileFailure)(ctx.root);
  return 0;
}

async function main() {
  const base = fallbackBase(process.argv.slice(2));
  if (base === null) {
    console.error('compile: --fallback needs the production curated URL (for example https://<host>/<path>/data/curated/)');
    process.exit(1);
  }
  process.exitCode = await compileAll(compileContext(), base === undefined ? {} : { fallback: base });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
