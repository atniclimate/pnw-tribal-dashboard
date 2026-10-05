// @ts-check
/**
 * validate:data (blueprint 6.6, 10.1). Schema gate over every file in schemas/catalog.json, plus the
 * named-person guard over data/, site/data/, and tests/fixtures/registry/.
 *
 * L0 skeleton: schema and named-person gates. Lane L15 owns this file after Wave 0 and adds the
 * cross-reference, names, honesty, contacts-freshness, and footprint-ratified gates of blueprint 6.6.
 */
import path from 'node:path';
import { readdir } from 'node:fs/promises';
import { ROOT, isMain } from './lib/pages.mjs';
import { SCHEMA_BASE, expand, loadAjv, loadCatalog, parseDataFile, personKeyHits } from './lib/data-files.mjs';

const GUARDED_DIRS = ['data', 'site/data', 'tests/fixtures/registry'];

/** @param {string} dir repository-relative @returns {Promise<string[]>} */
async function walkData(dir) {
  /** @type {string[]} */
  const out = [];
  /** @param {string} rel */
  async function walk(rel) {
    let entries;
    try { entries = await readdir(path.join(ROOT, rel), { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const r = `${rel}/${e.name}`;
      if (e.isDirectory()) await walk(r);
      else if (/\.(json|ya?ml|csv)$/.test(e.name)) out.push(r);
    }
  }
  await walk(dir);
  return out;
}

export async function validateData() {
  const ajv = await loadAjv();
  /** @type {string[]} */
  const problems = [];
  let files = 0;
  for (const entry of await loadCatalog()) {
    const validate = ajv.getSchema(SCHEMA_BASE + entry.schema);
    if (!validate) { problems.push(`schema ${entry.schema} is not registered`); continue; }
    for (const pattern of entry.files) {
      for (const rel of await expand(pattern)) {
        files += 1;
        let value;
        try { value = await parseDataFile(rel); } catch (e) { problems.push(`${rel}: ${/** @type {Error} */ (e).message}`); continue; }
        const targets = entry.format === 'csv-rows' && Array.isArray(value) ? value.map((row, i) => ({ row, at: `row ${i + 2}` })) : [{ row: value, at: '' }];
        for (const { row, at } of targets) {
          if (!validate(row)) {
            for (const err of validate.errors ?? []) problems.push(`${rel}${at ? ` ${at}` : ''}: ${err.instancePath || '/'} ${err.message ?? ''} (${entry.schema})`);
          }
        }
      }
    }
  }
  for (const dir of GUARDED_DIRS) {
    for (const rel of await walkData(dir)) {
      let value;
      try { value = await parseDataFile(rel); } catch { continue; }
      for (const hit of personKeyHits(value)) problems.push(`${rel}: named-person key ${hit} (blueprint 6.6)`);
    }
  }
  return { files, problems };
}

if (isMain(import.meta.url)) {
  const { files, problems } = await validateData();
  if (problems.length) {
    for (const p of problems) console.error(`validate:data ${p}`);
    console.error(`validate:data failed: ${problems.length} problem(s) in ${files} file(s)`);
    process.exit(1);
  }
  console.log(`validate:data ok (${files} files; schema and named-person gates; L15 adds the remaining 6.6 gates)`);
}
