// @ts-check
/**
 * Module contract (blueprint 12.3, L0 "Provides: module signatures"). Every module in
 * module-contract.json exists, starts with // @ts-check, imports cleanly in Node (no top-level DOM access,
 * so DOM-free modules run unchanged in the snapshot scripts), and exports every contracted name. Lanes may
 * add exports; they may not remove or rename contracted ones without L0's owner.
 */
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
/** @type {{ modules: { path: string, owner: string, dom: boolean, exports: string[], complete?: boolean }[] }} */
const contract = JSON.parse(await readFile(path.join(ROOT, 'tests', 'unit', 'contracts', 'module-contract.json'), 'utf8'));

/** @param {string} dir @returns {Promise<string[]>} */
async function jsFiles(dir) {
  /** @type {string[]} */
  const out = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...await jsFiles(p));
    else if (e.name.endsWith('.js') && !e.name.endsWith('.d.ts')) out.push(path.relative(ROOT, p).split(path.sep).join('/'));
  }
  return out;
}

describe('module contract', () => {
  test('every module in the tree is in the contract, and every contracted module exists', async () => {
    const js = path.join(ROOT, 'site', 'static', 'js');
    const onDisk = (await jsFiles(js)).filter((p) => !p.endsWith('/boot/flags.js')).sort();
    const listed = contract.modules.map((m) => m.path).sort();
    assert.deepEqual(onDisk.filter((p) => !listed.includes(p)), [], 'modules missing from module-contract.json');
    assert.deepEqual(listed.filter((p) => !onDisk.includes(p)), [], 'contracted modules missing on disk');
  });

  for (const mod of contract.modules) {
    test(`${mod.path} (${mod.owner}) exports its contract`, async () => {
      const src = await readFile(path.join(ROOT, mod.path), 'utf8');
      assert.ok(src.startsWith('// @ts-check'), 'starts with // @ts-check');
      const m = await import(pathToFileURL(path.join(ROOT, mod.path)).href);
      for (const name of mod.exports) assert.ok(name in m, `missing export ${name}`);
    });
  }
});
