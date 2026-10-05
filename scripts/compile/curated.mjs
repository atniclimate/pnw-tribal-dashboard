// @ts-check
/**
 * Compile resources.yaml, declarations/curated.yaml, news-sources.yaml, imagery/products.yaml, and
 * events/*.yaml into site/data/curated/*.json (blueprint 6.3).
 *
 * L0 baseline: each present input is validated against its schema and written as a curated envelope
 * (`{ schema: 'cthd.curated.<kind>/1', generatedAt, items }`), so lanes adding inputs never break
 * `npm run dev`. Owner after Wave 0: lane L6, which adds the 6.6 honesty rules (no curated value without
 * a source; event items rejected from resources.yaml; reviewBy at most 30 days after verifiedAt).
 */
import { readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { SCHEMA_BASE, loadAjv, parseDataFile } from '../check/lib/data-files.mjs';

/** @type {{ kind: string, input: string, schema: string, many?: boolean }[]} */
const INPUTS = [
  { kind: 'agencies', input: 'data/agencies.yaml', schema: 'agencies.schema.json' },
  { kind: 'resources', input: 'data/resources.yaml', schema: 'resources.schema.json' },
  { kind: 'declarations', input: 'data/declarations/curated.yaml', schema: 'declarations-curated.schema.json' },
  { kind: 'news-sources', input: 'data/news-sources.yaml', schema: 'news-sources.schema.json' },
  { kind: 'imagery-products', input: 'data/imagery/products.yaml', schema: 'imagery-products.schema.json' },
  { kind: 'events', input: 'data/events', schema: 'event.schema.json', many: true },
];

/**
 * @param {import('./all.mjs').CompileContext} ctx
 * @returns {Promise<import('./all.mjs').CompileResult>}
 */
export async function compileCurated(ctx) {
  const ajv = await loadAjv();
  /** @type {string[]} */
  const outputs = [];
  for (const spec of INPUTS) {
    /** @type {string[]} */
    let files = [];
    if (spec.many) {
      try { files = (await readdir(path.join(ctx.root, spec.input))).filter((n) => n.endsWith('.yaml')).sort().map((n) => `${spec.input}/${n}`); } catch { /* absent */ }
    } else {
      try { await readdir(path.dirname(path.join(ctx.root, spec.input))); files = (await readdir(path.dirname(path.join(ctx.root, spec.input)))).includes(path.basename(spec.input)) ? [spec.input] : []; } catch { /* absent */ }
    }
    if (files.length === 0) continue;
    const validate = ajv.getSchema(SCHEMA_BASE + spec.schema);
    if (!validate) throw new Error(`schema ${spec.schema} missing`);
    /** @type {unknown[]} */
    const items = [];
    for (const rel of files) {
      const value = await parseDataFile(rel);
      if (!validate(value)) throw new Error(`${rel}: ${(validate.errors ?? []).map((e) => `${e.instancePath || '/'} ${e.message}`).join('; ')}`);
      if (spec.many) items.push(value); else items.push(...(Array.isArray(value) ? value : [value]));
    }
    const out = path.join(ctx.outDir, `${spec.kind}.json`);
    await writeFile(out, JSON.stringify({ schema: `cthd.curated.${spec.kind}/1`, generatedAt: ctx.generatedAt, items }) + '\n');
    outputs.push(out);
  }
  return { outputs, skipped: outputs.length ? null : 'no curated inputs yet (lanes L6, L12, L14)' };
}
