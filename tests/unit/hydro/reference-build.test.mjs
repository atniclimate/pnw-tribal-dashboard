// @ts-check
/** The reference build (60-gauges) with a fixture-backed HTTP client, plus the committed reference files. Owner: lane L7. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { load } from 'js-yaml';
import { buildGauges, serializeReference, STATIONS_URL } from '../../../scripts/reference/60-gauges.mjs';
import { loadAjv, SCHEMA_BASE } from '../../../scripts/check/lib/data-files.mjs';

const FX = new URL('../../fixtures/upstream/', import.meta.url);
/** @param {string} dir @param {string} name */
const fixture = (dir, name) => JSON.parse(readFileSync(new URL(`${dir}/2026-10-05-${name}.json`, FX), 'utf8'));
const NOW = new Date('2026-10-05T07:00:00Z');
const OVERRIDES = /** @type {any[]} */ (load(readFileSync(new URL('../../../data/registry/gauges-overrides.yaml', import.meta.url), 'utf8')));

/** A client over the dated captures; lids without a capture answer 404 like NWPS does. */
/** @returns {{ calls: string[], http: any }} */
function http() {
  /** @type {string[]} */
  const calls = [];
  return {
    calls,
    http: {
      getJson: async (/** @type {string} */ sourceId, /** @type {string} */ url) => {
        calls.push(url);
        const base = { fetchedAt: NOW.toISOString(), sourceId };
        if (url.includes('?bbox.')) {
          const g = fixture('nwps-gauges', 'bbox-skagit-nooksack').gauges;
          return { ok: true, data: { gauges: g }, status: 200, lastModified: null, ...base };
        }
        if (url === STATIONS_URL) return { ok: true, data: fixture('eccc-hydrometric-stations', 'bc-active-realtime'), status: 200, lastModified: null, ...base };
        const lid = url.split('/').pop()?.toLowerCase();
        const file = lid === 'hutw1' ? 'hutw1-null-thresholds' : lid;
        try { return { ok: true, data: JSON.parse(readFileSync(new URL(`nwps-gauges/2026-10-05-gauge-${file}.json`, FX), 'utf8')), status: 200, lastModified: null, ...base }; } catch {
          return { ok: false, error: { kind: 'http', status: 404, message: 'HTTP 404' }, ...base };
        }
      },
    },
  };
}

test('buildGauges: refuses to write a partial reference when too many detail requests fail', async () => {
  const h = http();
  const out = await buildGauges({ http: h.http, now: NOW, overrides: OVERRIDES, spacingMs: 0, concurrency: 4 }).catch((e) => e);
  // Most of the listed gauges have no detail capture, so their requests fail; the failure rate exceeds the 2 percent gate.
  assert.ok(out instanceof Error);
  assert.match(out.message, /refusing to write a partial reference/);
  assert.ok(h.calls.length > 10);
});

test('buildGauges: with detail for every listed gauge the result is complete and schema-valid', async () => {
  const h = http();
  const listed = fixture('nwps-gauges', 'bbox-skagit-nooksack').gauges.map((/** @type {any} */ g) => g.lid);
  const have = new Set(['HUTW1', ...OVERRIDES.map((o) => o.gaugeId.slice(5)), 'CRNZ1']);
  const missing = listed.filter((/** @type {string} */ l) => !have.has(l));
  // Drop listed gauges that have no detail capture from the tile response, so the build sees only gauges with real detail.
  const baseGet = h.http.getJson;
  h.http.getJson = async (/** @type {string} */ id, /** @type {string} */ url) => {
    const r = await baseGet(id, url);
    if (r.ok && url.includes('?bbox.')) {
      const data = /** @type {any} */ (r.data);
      return { ...r, data: { gauges: data.gauges.filter((/** @type {any} */ g) => !missing.includes(g.lid)) } };
    }
    return r;
  };
  const withCrnz1 = { ...h.http, getJson: async (/** @type {string} */ id, /** @type {string} */ url) => {
    const r = await h.http.getJson(id, url);
    if (r.ok && url.includes('?bbox.')) {
      const data = /** @type {any} */ (r.data);
      return { ...r, data: { gauges: [...data.gauges, { lid: 'CRNZ1', state: { abbreviation: 'WA' } }] } };
    }
    return r;
  } };
  const out = await buildGauges({ http: withCrnz1, now: NOW, overrides: OVERRIDES, spacingMs: 0 });
  const ids = out.gauges.gauges.map((g) => g.id);
  assert.deepEqual(ids, [...ids].sort());
  assert.ok(ids.includes('nwps:CRNW1'));
  assert.ok(!ids.includes('nwps:CRNZ1'), 'the discharge pseudo-point shares USGS 12149000 with CRNW1');
  assert.deepEqual(out.report.dischargePseudoPoints, ['nwps:CRNZ1']);
  const crnw1 = out.gauges.gauges.find((g) => g.id === 'nwps:CRNW1');
  assert.equal(crnw1?.stages?.action, 50.7);
  assert.equal(crnw1?.selection, 'curated');
  assert.equal(out.gauges.gauges.find((g) => g.id === 'nwps:HUTW1')?.selection, 'auto');
  assert.equal(out.report.curated.length, OVERRIDES.length);
  assert.equal(out.wsc.stations.length, out.report.wscStations);
  const ajv = await loadAjv();
  const vg = ajv.getSchema(`${SCHEMA_BASE}gauges.schema.json`);
  const vw = ajv.getSchema(`${SCHEMA_BASE}wsc-stations.schema.json`);
  assert.ok(vg?.(out.gauges), JSON.stringify(vg?.errors?.slice(0, 3)));
  assert.ok(vw?.(out.wsc), JSON.stringify(vw?.errors?.slice(0, 3)));
  assert.ok(out.report.noThresholds >= 1, 'HUTW1 has no categories and stays in with null thresholds');
});

test('buildGauges: an override whose target is not found is an error, and remove drops a gauge', async () => {
  const h = http();
  const data = fixture('nwps-gauges', 'bbox-skagit-nooksack');
  const only = { ...h.http, getJson: async (/** @type {string} */ id, /** @type {string} */ url) => {
    const r = await h.http.getJson(id, url);
    return r.ok && url.includes('?bbox.') ? { ...r, data: { gauges: data.gauges.filter((/** @type {any} */ g) => g.lid === 'HUTW1') } } : r;
  } };
  await assert.rejects(buildGauges({ http: only, now: NOW, overrides: [{ gaugeId: 'nwps:ZZZZ9', action: 'add', note: 'n', sourceUrl: 'https://x.test/' }], spacingMs: 0 }));
  const removed = await buildGauges({ http: only, now: NOW, overrides: [{ gaugeId: 'nwps:HUTW1', action: 'remove', note: 'n', sourceUrl: 'https://x.test/' }], spacingMs: 0 });
  assert.equal(removed.gauges.gauges.length, 0);
});

test('serializeReference writes one record per line and round-trips', () => {
  const doc = { schema: 's', generatedAt: 'g', sourceIds: ['a'], gauges: [{ id: 'nwps:AAAA1' }, { id: 'nwps:BBBB1' }] };
  const text = serializeReference(doc, 'gauges');
  assert.equal(text.split('\n').length, 5);
  assert.deepEqual(JSON.parse(text), doc);
});

const REF = new URL('../../../site/data/ref/', import.meta.url);
test('committed reference files (when present) are schema-valid, honest about thresholds, and small', async (t) => {
  if (!existsSync(new URL('gauges.json', REF))) { t.skip('site/data/ref/gauges.json not generated yet'); return; }
  const gauges = JSON.parse(readFileSync(new URL('gauges.json', REF), 'utf8'));
  const wscDoc = JSON.parse(readFileSync(new URL('wsc-stations.json', REF), 'utf8'));
  const ajv = await loadAjv();
  assert.ok(ajv.getSchema(`${SCHEMA_BASE}gauges.schema.json`)?.(gauges));
  assert.ok(ajv.getSchema(`${SCHEMA_BASE}wsc-stations.schema.json`)?.(wscDoc));
  for (const g of gauges.gauges) {
    assert.ok(g.hydrographImage.endsWith(`${g.lid.toLowerCase()}_hg.png`));
    assert.ok(!/ - Discharge$/i.test(g.name) || !gauges.gauges.some((/** @type {any} */ o) => o !== g && o.usgsId === g.usgsId));
  }
  for (const lid of ['MVEW1', 'SQUW1', 'SNAW1', 'CENW1', 'ARLW1', 'GLBW1', 'GRAO3', 'BIGI1', 'SMNI1', 'EKTO3', 'SNAI1', 'CRNW1']) {
    assert.equal(gauges.gauges.find((/** @type {any} */ g) => g.id === `nwps:${lid}`)?.selection, 'curated', lid);
  }
  assert.equal(gauges.gauges.find((/** @type {any} */ g) => g.id === 'nwps:CRNW1').stages.action, 50.7);
  for (const s of wscDoc.stations) assert.equal(s.stages, null);
  assert.ok(gzipSync(readFileSync(new URL('gauges.json', REF))).length < 200 * 1024, 'reference stays small');
  assert.ok(statSync(new URL('gauges.json', REF)).size < 1024 * 1024);
});
