// @ts-check
/**
 * Dated real fixtures (blueprint 1.1, 12.1, 12.3): every capture under tests/fixtures/upstream/ has a
 * metadata sidecar whose SHA-256 and size match the bytes on disk, a capture instant, and a file name
 * dated by that instant. A derived fixture names its parent, lists its edits, and is described in the
 * README.md next to it. The L0 fixture list is covered.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const UP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'fixtures', 'upstream');
/** @type {{ dir: string, name: string, meta: any }[]} */
const metas = [];
for (const dir of (await readdir(UP, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name)) {
  for (const name of (await readdir(path.join(UP, dir))).filter((n) => n.endsWith('.meta.json'))) {
    metas.push({ dir, name, meta: JSON.parse(await readFile(path.join(UP, dir, name), 'utf8')) });
  }
}

describe('upstream fixtures', () => {
  test('every capture file has a metadata sidecar', async () => {
    for (const dir of new Set(metas.map((m) => m.dir))) {
      const files = (await readdir(path.join(UP, dir))).filter((n) => !n.endsWith('.meta.json') && n !== 'README.md');
      for (const f of files) assert.ok(metas.some((m) => m.dir === dir && m.meta.file === f), `${dir}/${f} has no .meta.json`);
    }
  });

  for (const { dir, name, meta } of metas) {
    test(`${dir}/${meta.file}`, async () => {
      assert.equal(meta.sourceId, dir);
      assert.equal(name, meta.file.replace(/\.[a-z]+$/, '.meta.json'));
      assert.ok(meta.file.startsWith(meta.capturedAt.slice(0, 10)), 'file name carries the capture date');
      assert.ok(!Number.isNaN(Date.parse(meta.capturedAt)));
      const body = await readFile(path.join(UP, dir, meta.file));
      assert.equal(body.length, meta.bytes, 'size');
      assert.equal(createHash('sha256').update(body).digest('hex'), meta.sha256, 'sha256');
      if (meta.derivedFrom) {
        assert.ok(meta.edits.length > 0, 'a derived fixture lists its edits');
        assert.ok(metas.some((m) => m.dir === dir && m.meta.file === meta.derivedFrom), 'parent capture exists');
        const readme = await readFile(path.join(UP, dir, 'README.md'), 'utf8');
        assert.ok(readme.includes(meta.file), 'README.md next to it describes the edit');
      } else {
        assert.equal(meta.edits.length, 0);
      }
    });
  }

  test('the L0 fixture list is covered (blueprint 12.3)', () => {
    /** @param {string} source @param {string} cover */
    const has = (source, cover) => metas.some((m) => m.dir === source && m.meta.covers.includes(cover));
    const required = [
      ['nws-alerts-active', 'null-geometry-zone-alert'], ['nws-alerts-active', 'fire-zone-alert'], ['nws-alerts-active', 'fire-public-zone-code-collision'],
      ['nws-alerts-active', 'marine-alert'], ['nws-alerts-active', 'update-chain'], ['nws-alerts-active', 'cancel'], ['nws-alerts-active', 'test-message'],
      ['nws-alerts-active', 'paginated-collection'], ['nws-alerts-active', 'malformed-item'],
      ['eccc-geomet-weather-alerts', 'bilingual'], ['eccc-geomet-weather-alerts', 'with-geometry'], ['eccc-geomet-weather-alerts', 'without-geometry'],
      ['eccc-geomet-weather-alerts', 'truncated-collection'], ['eccc-geomet-weather-alerts', 'bc-scope'],
      ['ntwc-atom', 'atom-feed'], ['bc-rfc-flood-advisories', 'attributes-only'], ['bc-emcr-evacuations', 'orders'],
      ['nwps-gauges', 'bbox-list'], ['nwps-gauges', 'null-thresholds'], ['nws-gridpoints', 'dst-transition-2026-11-01'],
      ['eccc-citypage-realtime', 'city-page-forecast'], ['openfema-declarations', 'multi-county-rows'],
      ['news-opb', 'html-summaries'], ['news-opb', 'javascript-link'],
    ];
    for (const [s, c] of required) assert.ok(has(s ?? '', c ?? ''), `${s}: ${c}`);
  });
});
