// @ts-check
/**
 * Compile data/sources/*.yaml into site/data/curated/sources.json (blueprint 5.4, 6.3), validating each
 * record against schemas/source.schema.json and rejecting duplicate ids.
 *
 * L0 minimal implementation. Lane L15 adds DATA.md and the Usage page table output; the export
 * scripts (to-cast, to-ddm) read the compiled file.
 */
import { readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { SCHEMA_BASE, loadAjv, parseDataFile } from '../check/lib/data-files.mjs';

/**
 * @param {import('./all.mjs').CompileContext} ctx
 * @returns {Promise<import('./all.mjs').CompileResult>}
 */
export async function compileSources(ctx) {
  const dir = path.join(ctx.root, 'data', 'sources');
  /** @type {string[]} */
  let names = [];
  try { names = (await readdir(dir)).filter((n) => n.endsWith('.yaml')).sort(); } catch { /* no directory yet */ }
  const ajv = await loadAjv();
  const validate = ajv.getSchema(`${SCHEMA_BASE}source.schema.json`);
  if (!validate) throw new Error('source schema missing');
  /** @type {Record<string, unknown>[]} */
  const items = [];
  const seen = new Set();
  for (const n of names) {
    const rel = `data/sources/${n}`;
    const rec = /** @type {Record<string, unknown>} */ (await parseDataFile(rel));
    if (!validate(rec)) throw new Error(`${rel}: ${(validate.errors ?? []).map((e) => `${e.instancePath || '/'} ${e.message}`).join('; ')}`);
    if (`${rec.id}.yaml` !== n) throw new Error(`${rel}: id "${String(rec.id)}" does not match the file name`);
    if (seen.has(rec.id)) throw new Error(`${rel}: duplicate id`);
    seen.add(rec.id);
    items.push(rec);
  }
  const out = path.join(ctx.outDir, 'sources.json');
  await writeFile(out, JSON.stringify({ schema: 'cthd.curated.sources/1', generatedAt: ctx.generatedAt, items }) + '\n');
  return { outputs: [out], skipped: null };
}
