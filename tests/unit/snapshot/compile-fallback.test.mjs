// @ts-check
/**
 * scripts/lib/compile-fallback.mjs (blueprint 6.3): restoring the last good curated files and reporting
 * the compile failure in health.json. Owner: lane L9.
 */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { loadAjv } from '../../../scripts/check/lib/data-files.mjs';
import {
  clearCompileFailure, curatedOutputs, readCompileFailure, recordCompileFailure, restoreCurated,
} from '../../../scripts/lib/compile-fallback.mjs';
import { envelopeErrors, healthEnvelope } from '../../../scripts/lib/live.mjs';

/** @type {string} */
let tmp;
before(async () => { tmp = await mkdtemp(path.join(os.tmpdir(), 'cthd-compile-')); });
after(async () => { await rm(tmp, { recursive: true, force: true }); });

test('curatedOutputs lists the compiled files named in the schema catalog', async () => {
  const files = (await curatedOutputs()).map((o) => o.file);
  assert.ok(files.includes('sources.json'));
  assert.ok(files.includes('contacts.json'));
});

test('restoreCurated keeps only production files that pass their schema', async () => {
  const prod = path.join(tmp, 'prod');
  await mkdir(prod, { recursive: true });
  await writeFile(path.join(prod, 'sources.json'), '{"schema":"cthd.curated.sources/1","generatedAt":"2026-10-05T06:00:00.000Z","items":[]}\n');
  await writeFile(path.join(prod, 'contacts.json'), '{"not":"valid"}');
  const out = path.join(tmp, 'curated');
  const r = await restoreCurated({ base: prod, outDir: out });
  assert.deepEqual(r.restored, ['sources.json']);
  assert.ok(r.missing.includes('contacts.json'));
  assert.deepEqual(await readdir(out), ['sources.json']);
});

test('a fresh compile failure appears in health.json; a stale or cleared one does not', async () => {
  const now = new Date('2026-10-05T07:00:00Z');
  await recordCompileFailure(tmp, { step: 'contacts', message: 'data/contacts/x.csv: bad row', at: '2026-10-05T06:58:00Z' });
  const rec = await readCompileFailure(tmp, now);
  assert.equal(rec?.step, 'contacts');
  const health = healthEnvelope([], now, rec);
  assert.deepEqual(envelopeErrors(await loadAjv(), 'health.json', health), []);
  const item = /** @type {any[]} */ (health.items).find((i) => i.kind === 'compile');
  assert.equal(item.id, 'compile-contacts');
  assert.equal(item.state, 'degraded');
  assert.equal(await readCompileFailure(tmp, new Date('2026-10-05T09:00:00Z')), null, 'older than an hour');
  await clearCompileFailure(tmp);
  assert.equal(await readCompileFailure(tmp, now), null);
});
