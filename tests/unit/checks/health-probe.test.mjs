// @ts-check
/**
 * Source health probe (decision Q10, 10/05/2026): a CARTO watermark tile passes the status and byte checks, so
 * the probe script must reject it by its ETag.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { isWatermarkEtag, judgeProbe, loadProbeRecords, probeRecord, resolveProbeUrl } from '../../../scripts/health/probe-sources.mjs';

const health = { expectStatus: 200, expectAcao: '*', expectType: 'image/png', minBytes: 500, maxBytes: null };
/** @param {Record<string, string>} h */
const headers = (h) => ({ get: (/** @type {string} */ n) => h[n.toLowerCase()] ?? null });

describe('watermark rejection', () => {
  test('the captured watermark tile response is a failure even though status, type, and size pass', () => {
    const res = { status: 200, bytes: 2513, headers: headers({ 'access-control-allow-origin': '*', 'content-type': 'image/png', etag: '"wm-da89c20e77c1-dark"' }) };
    const v = judgeProbe(health, res);
    assert.equal(v.ok, false);
    assert.match(v.failures.join(' '), /watermark tile/);
  });

  test('a real tile with an ordinary ETag passes', () => {
    const res = { status: 200, bytes: 9120, headers: headers({ 'access-control-allow-origin': '*', 'content-type': 'image/png', etag: '"a1b2c3d4"' }) };
    assert.deepEqual(judgeProbe(health, res), { ok: true, failures: [] });
  });

  test('ETag forms: quoted, weak, bare, absent, and a value that only contains wm-', () => {
    assert.equal(isWatermarkEtag('"wm-abc"'), true);
    assert.equal(isWatermarkEtag('W/"wm-abc"'), true);
    assert.equal(isWatermarkEtag('wm-abc'), true);
    assert.equal(isWatermarkEtag(null), false);
    assert.equal(isWatermarkEtag('"abc-wm-def"'), false);
  });

  test('the ordinary checks still fail a bad response', () => {
    const v = judgeProbe(health, { status: 503, bytes: 10, headers: headers({ 'content-type': 'text/html' }) });
    assert.equal(v.ok, false);
    assert.equal(v.failures.length, 4);
  });
});

describe('keyed probe', () => {
  test('the placeholder is skipped, not reported healthy, and a key fills it in', async () => {
    const rec = { id: 'carto-dark-matter', health: { ...health, probe: 'https://basemaps.cartocdn.com/dark_all/6/10/22.png?key=<ATNI_BASEMAP_KEY>' } };
    assert.equal(resolveProbeUrl(rec.health.probe, {}), null);
    const skipped = await probeRecord(rec, async () => { throw new Error('no request without a key'); }, {});
    assert.equal(skipped.result, 'skipped');
    assert.equal(resolveProbeUrl(rec.health.probe, { ATNI_BASEMAP_KEY: 'k1' }), 'https://basemaps.cartocdn.com/dark_all/6/10/22.png?key=k1');
  });

  test('a watermark answer to a keyed request is reported as failed', async () => {
    const rec = { id: 'carto-dark-matter', health: { ...health, probe: 'https://basemaps.cartocdn.com/dark_all/6/10/22.png?key=<ATNI_BASEMAP_KEY>' } };
    const body = new Uint8Array(2513);
    const fetchImpl = async () => new Response(body, { status: 200, headers: { 'content-type': 'image/png', 'access-control-allow-origin': '*', etag: '"wm-da89c20e77c1-dark"' } });
    const r = await probeRecord(rec, fetchImpl, { ATNI_BASEMAP_KEY: 'k1' });
    assert.equal(r.result, 'failed');
  });

  test('the registry record for the basemap carries a probe the script can find', async () => {
    const records = await loadProbeRecords();
    const carto = records.find((r) => r.id === 'carto-dark-matter');
    assert.ok(carto, 'carto-dark-matter has a health block');
    assert.equal(resolveProbeUrl(carto.health.probe, {}), null, 'the placeholder is unresolved without a key');
    assert.match(resolveProbeUrl(carto.health.probe, { ATNI_BASEMAP_KEY: 'k1' }) ?? '', /\.png\?key=k1$/);
  });
});
