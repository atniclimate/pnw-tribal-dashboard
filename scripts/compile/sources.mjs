// @ts-check
/**
 * Compile data/sources/*.yaml into site/data/curated/sources.json (blueprint 5.4, 6.3), validating each
 * record against schemas/source.schema.json and rejecting duplicate ids.
 *
 * Also renders the public data list (renderDataMd) to .cache/DATA.generated.md on every run; the
 * hand-written DATA.md is replaced only when CTHD_WRITE_DATA_MD=1. The Usage page and the export scripts
 * (to-cast, to-ddm) read the compiled sources.json. Owner: lane L15 (after L0's minimal version).
 */
import { mkdir, readdir, writeFile } from 'node:fs/promises';
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
  /** @type {string[]} */
  const outputs = [out];
  // DATA.md is hand-written until the maintainer opts in. The generated rendering goes to .cache/ for
  // review; CTHD_WRITE_DATA_MD=1 writes it over DATA.md at the repository root.
  const rendered = renderDataMd(items);
  await mkdir(path.join(ctx.root, '.cache'), { recursive: true });
  const generated = path.join(ctx.root, '.cache', 'DATA.generated.md');
  await writeFile(generated, rendered);
  outputs.push(generated);
  if (process.env.CTHD_WRITE_DATA_MD === '1') {
    const target = path.join(ctx.root, 'DATA.md');
    await writeFile(target, rendered);
    outputs.push(target);
  }
  return { outputs, skipped: null };
}

/** @param {unknown} s @returns {string} one table cell */
const cell = (s) => String(s ?? '').replace(/\|/g, '/').replace(/\s+/g, ' ').trim();

/**
 * The public data list (DATA.md) rendered from compiled source records: publisher, what the dashboard uses
 * it for, access, terms, and the date a person last verified it. Deterministic: sorted by owner, then
 * title, so a rerun on the same records is byte-identical. House style: no em dashes, dates MM/DD/YYYY.
 * @param {Record<string, any>[]} items
 * @returns {string}
 */
export function renderDataMd(items) {
  /** @param {string} iso */
  const us = (iso) => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso); return m ? `${m[2]}/${m[3]}/${m[1]}` : iso; };
  const active = items.filter((i) => !['deprecated', 'retired'].includes(i.status));
  const byOwner = (/** @type {any} */ a, /** @type {any} */ b) => String(a.owner).localeCompare(String(b.owner)) || String(a.title).localeCompare(String(b.title));
  const upstream = active.filter((i) => i.kind !== 'file').sort(byOwner);
  const own = active.filter((i) => i.kind === 'file').sort(byOwner);
  const row = (/** @type {any} */ i) => `| ${cell(i.owner)} | ${cell(i.title)} | ${cell(i.access.mode)} | ${cell(i.license)}${i.status === 'active-pending-terms' || i.status === 'candidate' ? ' (pending)' : ''} | ${us(String(i.verifiedAt))} |`;
  const head = '| Publisher | Source | Access | Terms | Verified |\n|---|---|---|---|---|';
  return [
    '# Data Sources',
    '',
    'Every source the dashboard uses, who publishes it, and its terms. This list is generated from the machine-readable records in `data/sources/`, which are authoritative. Sources marked "pending" stay hidden until their terms are confirmed.',
    '',
    '## Upstream Sources',
    '',
    head,
    ...upstream.map(row),
    '',
    '## Dashboard Files',
    '',
    head,
    ...own.map(row),
    '',
  ].join('\n');
}
