// @ts-check
/**
 * Curated compile fallback for deploys (blueprint 6.3). When a bad curated edit still reaches `main`,
 * `node scripts/compile/all.mjs --fallback <production curated URL>` restores the last good compiled files
 * from production (each validated against its schema), keeps the deploy going, and records the failure so
 * the snapshot runner reports it in health.json. Owner: lane L9; scripts/compile/all.mjs (lane L0) calls it.
 */
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { SCHEMA_BASE, loadAjv, loadCatalog } from '../check/lib/data-files.mjs';
import { getOwn, joinLocation } from './http.mjs';

/** Where the failure record lives between the compile step and the snapshot step of one deploy. */
export const COMPILE_FAILURE_FILE = path.join('.cache', 'compile-failure.json');
/** A record older than this is from an earlier run and is ignored. */
export const COMPILE_FAILURE_MAX_AGE_MS = 60 * 60_000;

/**
 * The compiled curated files and their schemas, from schemas/catalog.json.
 * @returns {Promise<{ file: string, schema: string }[]>}
 */
export async function curatedOutputs() {
  return (await loadCatalog()).flatMap((e) => e.files
    .filter((f) => /^site\/data\/curated\/[a-z0-9-]+\.json$/.test(f))
    .map((f) => ({ file: path.posix.basename(f), schema: e.schema })));
}

/**
 * Download the last good compiled files from production into `outDir`.
 * @param {{ base: string, outDir: string, fetchImpl?: (input: string, init?: RequestInit) => Promise<Response> }} opts
 * @returns {Promise<{ restored: string[], missing: string[] }>}
 */
export async function restoreCurated(opts) {
  const ajv = await loadAjv();
  /** @type {string[]} */
  const restored = [];
  /** @type {string[]} */
  const missing = [];
  await mkdir(opts.outDir, { recursive: true });
  for (const { file, schema } of await curatedOutputs()) {
    const text = await getOwn(joinLocation(opts.base, file), opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {});
    const validate = ajv.getSchema(`${SCHEMA_BASE}${schema}`);
    /** @type {unknown} */
    let value = null;
    try { value = text === null ? null : JSON.parse(text); } catch { value = null; }
    if (value === null || !validate || !validate(value)) { missing.push(file); continue; }
    await writeFile(path.join(opts.outDir, file), /** @type {string} */ (text));
    restored.push(file);
  }
  return { restored, missing };
}

/**
 * @param {string} root repository root
 * @param {{ step: string, message: string, at: string }} record
 */
export async function recordCompileFailure(root, record) {
  const file = path.join(root, COMPILE_FAILURE_FILE);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(record)}\n`);
}

/** @param {string} root */
export async function clearCompileFailure(root) {
  await rm(path.join(root, COMPILE_FAILURE_FILE), { force: true });
}

/**
 * The compile failure recorded by this deploy's compile step, or null.
 * @param {string} root
 * @param {Date} now
 * @returns {Promise<{ step: string, message: string, at: string } | null>}
 */
export async function readCompileFailure(root, now) {
  try {
    const rec = JSON.parse(await readFile(path.join(root, COMPILE_FAILURE_FILE), 'utf8'));
    const at = Date.parse(rec.at);
    if (typeof rec.step !== 'string' || typeof rec.message !== 'string' || Number.isNaN(at)) return null;
    if (now.getTime() - at > COMPILE_FAILURE_MAX_AGE_MS) return null;
    return { step: rec.step, message: rec.message, at: new Date(at).toISOString() };
  } catch {
    return null;
  }
}
