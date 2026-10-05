// @ts-check
/**
 * Reference step 10: fetch and verify the pinned upstream inputs (blueprint 6.2).
 *
 *   node scripts/reference/10-fetch-inputs.mjs                 verify .cache/inputs, download what is missing
 *   node scripts/reference/10-fetch-inputs.mjs --seed <dir>    copy missing files from a local download folder first
 *   node scripts/reference/10-fetch-inputs.mjs --update-lock   re-hash every input and rewrite sha256 in the file
 *   node scripts/reference/10-fetch-inputs.mjs --only <id>     limit to one input id
 *
 * data/pipeline/inputs.yaml pins every upstream file by URL, vintage, SHA-256, and licence. A file whose hash
 * does not match its pin is a hard failure: a reviewed change to the pin (--update-lock plus a diff review)
 * is the only way an upstream change reaches the committed reference files. Raw downloads live in
 * .cache/inputs (gitignored). The only inputs this script rewrites are the ones listed in NORMALIZERS, whose
 * upstream responses carry volatile fields (timestamps, latency counters) that are not part of the data.
 *
 * Node 24 ES module; the pipeline may call fetch directly (development and CI tooling only).
 */
import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CORE_SCHEMA, dump, load } from 'js-yaml';
import { downloadBytes } from '../lib/http.mjs';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const INPUTS_FILE = path.join(ROOT, 'data', 'pipeline', 'inputs.yaml');
export const INPUT_DIR = path.join(ROOT, '.cache', 'inputs');
export const USER_AGENT = '(atniclimate.github.io/pnw-tribal-dashboard, climate@atnitribes.org)';

/**
 * @typedef {{ id: string, sourceId: string, url: string, file: string, vintage: string, sha256: string,
 *             licence: string, notes?: string }} PinnedInput
 */

/** @param {Uint8Array | string} body */
export function sha256(body) {
  return createHash('sha256').update(body).digest('hex');
}

/** @returns {Promise<PinnedInput[]>} */
export async function loadInputs() {
  const doc = /** @type {{ inputs: PinnedInput[] }} */ (load(await readFile(INPUTS_FILE, 'utf8'), { schema: CORE_SCHEMA }));
  return doc.inputs;
}

/**
 * Absolute path of a verified input in the cache. Throws when the input is not pinned.
 * @param {PinnedInput[]} inputs
 * @param {string} id
 */
export function inputPath(inputs, id) {
  const hit = inputs.find((i) => i.id === id);
  if (!hit) throw new Error(`input "${id}" is not pinned in data/pipeline/inputs.yaml`);
  return path.join(INPUT_DIR, hit.file);
}

/**
 * Upstream responses with volatile fields are reduced to their stable content before hashing, so the pin
 * stays reproducible. The keys are input ids.
 * @type {Record<string, (raw: Buffer) => Buffer>}
 */
const NORMALIZERS = {
  'nws-radar-stations': (raw) => {
    const j = JSON.parse(raw.toString('utf8'));
    const stations = j.features
      .map((/** @type {any} */ f) => ({
        id: f.properties.id,
        name: f.properties.name,
        stationType: f.properties.stationType,
        lon: f.geometry.coordinates[0],
        lat: f.geometry.coordinates[1],
      }))
      .sort((/** @type {any} */ a, /** @type {any} */ b) => (a.id < b.id ? -1 : 1));
    return Buffer.from(JSON.stringify({ stations }, null, 1) + '\n');
  },
};

/** @param {string} p */
async function exists(p) {
  try { await stat(p); return true; } catch { return false; }
}

/**
 * @param {string} url
 * @returns {Promise<Buffer>}
 */
function download(url) {
  return downloadBytes(url);
}

/**
 * Serialize the pinned list with a stable layout (one record per block, key order fixed).
 * @param {PinnedInput[]} inputs
 */
export function serializeInputs(inputs) {
  const order = ['id', 'sourceId', 'url', 'file', 'vintage', 'sha256', 'licence', 'notes'];
  const ordered = inputs.map((i) => Object.fromEntries(order.filter((k) => k in i).map((k) => [k, /** @type {any} */ (i)[k]])));
  return `# Pinned upstream inputs (blueprint 6.2). Rewritten only by 10-fetch-inputs.mjs --update-lock.\n${dump({ inputs: ordered }, { lineWidth: 140, noRefs: true })}`;
}

/**
 * @param {string[]} argv
 * @returns {Promise<{ ok: boolean, lines: string[] }>}
 */
export async function run(argv) {
  const updateLock = argv.includes('--update-lock');
  const seedAt = argv.indexOf('--seed');
  const seed = seedAt >= 0 ? path.resolve(argv[seedAt + 1] ?? '') : (process.env.CTHD_SEED_DIR ?? null);
  const onlyAt = argv.indexOf('--only');
  const only = onlyAt >= 0 ? argv[onlyAt + 1] : null;
  const inputs = await loadInputs();
  await mkdir(INPUT_DIR, { recursive: true });
  /** @type {string[]} */
  const lines = [];
  let ok = true;
  for (const inp of inputs) {
    if (only && inp.id !== only) continue;
    const dest = path.join(INPUT_DIR, inp.file);
    let body = null;
    if (await exists(dest)) body = await readFile(dest);
    if (body && !updateLock && sha256(body) !== inp.sha256) body = null;
    if (!body && seed && (await exists(path.join(seed, inp.file)))) {
      await copyFile(path.join(seed, inp.file), dest);
      body = await readFile(dest);
      lines.push(`seeded   ${inp.id}`);
    }
    if (!body) {
      const norm = NORMALIZERS[inp.id];
      const raw = await download(inp.url);
      body = norm ? norm(raw) : raw;
      await writeFile(dest, body);
      lines.push(`download ${inp.id} (${body.length} bytes)`);
    }
    const got = sha256(body);
    if (got === inp.sha256) {
      lines.push(`ok       ${inp.id}`);
    } else if (updateLock) {
      inp.sha256 = got;
      lines.push(`relocked ${inp.id} ${got}`);
    } else {
      ok = false;
      lines.push(`MISMATCH ${inp.id}: pinned ${inp.sha256}, got ${got}`);
    }
  }
  if (updateLock) await writeFile(INPUTS_FILE, serializeInputs(inputs));
  return { ok, lines };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { ok, lines } = await run(process.argv.slice(2));
  for (const l of lines) console.log(l);
  process.exit(ok ? 0 : 1);
}
