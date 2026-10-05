// @ts-check
/**
 * Validate a live snapshot directory before it is assembled and deployed (blueprint 5.10, 6.6).
 * Owner: lane L9.
 *
 *   node scripts/check/validate-live.mjs site/data/live
 *
 * Fails when the manifest is missing or invalid, when a file and the manifest disagree (presence, SHA-256,
 * bytes, observedAt, carriedForward), or when any envelope fails its schema or the live sanity bounds.
 * The runner already carries forward any envelope that fails, so a failure here means a runner bug, and
 * the deploy stops with the last good deployment still serving.
 */
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { SCHEMA_BASE, loadAjv } from './lib/data-files.mjs';
import { isMain } from './lib/pages.mjs';
import { HEALTH_FILE, MANIFEST_FILE, envelopeErrors, sha256 } from '../lib/live.mjs';

/** @type {ReturnType<typeof loadAjv> | undefined} */
let ajvOnce;

/**
 * @param {string} dir
 * @returns {Promise<string[]>} problems; empty when the directory is deployable
 */
export async function validateLive(dir) {
  ajvOnce ??= loadAjv();
  const ajv = await ajvOnce;
  /** @type {string[]} */
  const errors = [];
  /** @type {string[]} */
  let names;
  try { names = (await readdir(dir)).filter((n) => n.endsWith('.json')).sort(); } catch { return [`${dir} does not exist`]; }
  if (!names.includes(MANIFEST_FILE)) return [`${MANIFEST_FILE} is missing`];
  /** @type {import('../../site/static/js/types.js').LiveManifest} */
  let manifest;
  try { manifest = JSON.parse(await readFile(path.join(dir, MANIFEST_FILE), 'utf8')); } catch (e) { return [`${MANIFEST_FILE}: ${/** @type {Error} */ (e).message}`]; }
  const mValidate = ajv.getSchema(`${SCHEMA_BASE}live-manifest.schema.json`);
  if (!mValidate || !mValidate(manifest)) {
    return (mValidate?.errors ?? [{ instancePath: '', message: 'no manifest schema' }]).map((e) => `${MANIFEST_FILE}${e.instancePath} ${e.message}`);
  }
  if (!names.includes(HEALTH_FILE)) errors.push(`${HEALTH_FILE} is missing`);
  const listed = new Map(manifest.files.map((f) => [f.path.replace(/^data\/live\//, ''), f]));
  if (listed.size !== manifest.files.length) errors.push(`${MANIFEST_FILE} lists a file twice`);
  for (const n of names.filter((x) => x !== MANIFEST_FILE)) {
    if (!listed.has(n)) errors.push(`${n} is not listed in ${MANIFEST_FILE}`);
  }
  for (const [file, entry] of listed) {
    /** @type {Buffer} */
    let bytes;
    try { bytes = await readFile(path.join(dir, file)); } catch { errors.push(`${file} is listed in ${MANIFEST_FILE} but missing`); continue; }
    if (sha256(bytes) !== entry.sha256) errors.push(`${file}: SHA-256 differs from ${MANIFEST_FILE}`);
    if (bytes.length !== entry.bytes) errors.push(`${file}: ${bytes.length} bytes, ${MANIFEST_FILE} says ${entry.bytes}`);
    /** @type {unknown} */
    let env;
    try { env = JSON.parse(bytes.toString('utf8')); } catch (e) { errors.push(`${file}: ${/** @type {Error} */ (e).message}`); continue; }
    for (const err of envelopeErrors(ajv, file, env)) errors.push(`${file}: ${err}`);
    const e = /** @type {{ observedAt?: unknown, carriedForward?: unknown }} */ (env);
    if (e.observedAt !== entry.observedAt) errors.push(`${file}: observedAt differs from ${MANIFEST_FILE}`);
    if (e.carriedForward !== entry.carriedForward) errors.push(`${file}: carriedForward differs from ${MANIFEST_FILE}`);
  }
  return errors;
}

if (isMain(import.meta.url)) {
  const dir = path.resolve(process.argv[2] ?? 'site/data/live');
  const errors = await validateLive(dir);
  if (errors.length > 0) {
    for (const e of errors) console.error(`validate-live: ${e}`);
    console.error(`validate-live: ${errors.length} problem(s) in ${dir}`);
    process.exit(1);
  }
  console.log(`validate-live: ${dir} is valid`);
}
