// @ts-check
/**
 * CAST parity inputs (blueprint 10.1): the files under tests/fixtures/cast/ are byte-for-byte copies of
 * ATNI-CAST at the commit in UPSTREAM.json. The parity tests themselves (core-status validation cases;
 * NWS and ECCC band, posture, and confidence mappings) are added by lanes L2 and L3 in this directory.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'cast');
const upstream = JSON.parse(await readFile(path.join(DIR, 'UPSTREAM.json'), 'utf8'));

test('UPSTREAM.json pins a CAST commit', () => {
  assert.match(upstream.commit, /^[0-9a-f]{40}$/);
  assert.ok(upstream.files.length > 0);
});

test('every copied file matches its recorded SHA-256', async () => {
  for (const f of upstream.files) {
    const buf = await readFile(path.join(DIR, f.path));
    assert.equal(buf.length, f.bytes, f.path);
    assert.equal(createHash('sha256').update(buf).digest('hex'), f.sha256, f.path);
  }
});

test('no unlisted file sits in the CAST fixture directory', async () => {
  /** @param {string} d @returns {Promise<string[]>} */
  const walk = async (d) => (await Promise.all((await readdir(d, { withFileTypes: true })).map((e) => {
    const p = path.join(d, e.name);
    return e.isDirectory() ? walk(p) : Promise.resolve([path.relative(DIR, p).split(path.sep).join('/')]);
  }))).flat();
  const listed = new Set(upstream.files.map((/** @type {{ path: string }} */ f) => f.path));
  const extra = (await walk(DIR)).filter((p) => p !== 'UPSTREAM.json' && p !== 'README.md' && !listed.has(p));
  assert.deepEqual(extra, []);
});
