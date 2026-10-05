// @ts-check
/** Gauge loading and nearby ranking, with injected network and status deps. Owner: lane L7. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GAUGE_POLICY, loadGauges, nearbyGauges } from '../../../site/static/js/hydro/gauges-service.js';

const NOW = new Date('2026-10-05T12:00:00Z');
const gauge = (/** @type {string} */ id, /** @type {number} */ lat, /** @type {number} */ lon, /** @type {boolean} */ fp = false) => ({
  id, country: /** @type {const} */ ('US'), agency: /** @type {const} */ ('NWS'), lid: id.slice(5), usgsId: null, wscId: null, name: id, river: null,
  region: /** @type {const} */ ('wa'), wfo: null, rfc: null, lat, lon, timeZone: 'America/Los_Angeles', stages: null,
  isForecastPoint: fp, hydrographImage: null, links: {}, nationIds: [], selection: /** @type {const} */ ('auto'),
});
const envelope = (/** @type {string} */ id, /** @type {any[]} */ items, /** @type {any} */ over = {}) => ({
  schema: `cthd.live.${id}/1`, id, sourceIds: ['x'], generatedAt: NOW.toISOString(), observedAt: NOW.toISOString(), asOf: '2026-10-05T11:45:00Z',
  asOfBasis: 'valid', completeness: 'complete', carriedForward: false, failure: null, perSource: {}, diagnostics: {}, items, ...over,
});

/** @param {Record<string, unknown>} files */
function deps(files) {
  /** @type {any[]} */
  const derived = [];
  return {
    derived,
    deps: {
      now: () => NOW,
      fetchLocal: async (/** @type {string} */ p) => (p in files ? { ok: true, data: files[p], status: 200, fetchedAt: NOW.toISOString(), lastModified: null, sourceId: 'local' }
        : { ok: false, error: { kind: 'http', status: 404, message: 'missing' }, fetchedAt: NOW.toISOString(), sourceId: 'local' }),
      deriveStatus: (/** @type {any} */ inputs) => {
        derived.push(inputs);
        return { state: inputs.unavailableReason ? 'unavailable' : 'live', asOf: inputs.snapshot?.asOf ?? null, asOfBasis: inputs.snapshot?.asOfBasis ?? null,
          sourceIds: inputs.sourceIds, origin: 'snapshot', completeness: 'complete', checkedAt: NOW.toISOString(), detail: inputs.unavailableReason };
      },
    },
  };
}

test('loadGauges merges NWPS gauges and WSC stations with their live statuses', async () => {
  const wscStation = { id: 'wsc:08MF005', name: 'FRASER RIVER AT HOPE', lat: 49.38, lon: -121.45, region: 'bc', timeZone: 'America/Vancouver', links: {}, stages: null, thresholdNote: 'n', nationIds: [] };
  const d = deps({
    'data/ref/gauges.json': { gauges: [gauge('nwps:MVEW1', 48.4, -122.3)] },
    'data/ref/wsc-stations.json': { stations: [wscStation] },
    'data/live/gauges-status.json': envelope('gauges-status', [{ id: 'nwps:MVEW1', observed: null, forecast: null }]),
    'data/live/wsc-status.json': envelope('wsc-status', [{ id: 'wsc:08MF005', observed: null, forecast: null }], { asOf: '2026-10-05T10:00:00Z', asOfBasis: 'observed' }),
  });
  const out = await loadGauges({ nation: null, deps: /** @type {any} */ (d.deps) });
  assert.deepEqual(out.gauges.map((g) => g.id), ['nwps:MVEW1', 'wsc:08MF005']);
  assert.equal(out.gauges[1]?.agency, 'WSC');
  assert.equal(out.gauges[1]?.stages, null);
  assert.equal(out.gauges[1]?.wscId, '08MF005');
  assert.deepEqual([...out.statuses.keys()], ['nwps:MVEW1', 'wsc:08MF005']);
  // The stalest upstream time governs the panel status.
  assert.equal(d.derived[0].snapshot.asOf, '2026-10-05T10:00:00Z');
  assert.deepEqual(d.derived[0].policy, GAUGE_POLICY);
  assert.equal(out.status.state, 'live');
});

test('loadGauges reports unavailable, not an empty success, when live files are missing or rejected', async () => {
  const ref = { 'data/ref/gauges.json': { gauges: [gauge('nwps:MVEW1', 48.4, -122.3)] } };
  const missing = deps(ref);
  const a = await loadGauges({ nation: null, deps: /** @type {any} */ (missing.deps) });
  assert.equal(a.status.state, 'unavailable');
  assert.equal(a.gauges.length, 1, 'the reference still lists the gauges');
  assert.equal(a.statuses.size, 0);
  const rejected = deps({ ...ref, 'data/live/gauges-status.json': envelope('gauges-status', [], { completeness: 'rejected' }) });
  const b = await loadGauges({ nation: null, deps: /** @type {any} */ (rejected.deps) });
  assert.equal(b.status.state, 'unavailable');
  const noRef = deps({});
  const c = await loadGauges({ nation: null, deps: /** @type {any} */ (noRef.deps) });
  assert.equal(c.status.state, 'unavailable');
  assert.equal(c.gauges.length, 0);
});

test('a partial or carried-forward file is reported, never hidden', async () => {
  const d = deps({
    'data/ref/gauges.json': { gauges: [gauge('nwps:MVEW1', 48.4, -122.3)] },
    'data/live/gauges-status.json': envelope('gauges-status', [{ id: 'nwps:MVEW1', observed: null, forecast: null }], { completeness: 'partial', carriedForward: true }),
  });
  const out = await loadGauges({ nation: null, deps: /** @type {any} */ (d.deps) });
  assert.equal(out.status.completeness, 'partial');
  assert.equal(d.derived[0].snapshot.carriedForward, true);
});

/** @param {Partial<import('../../../site/static/js/types.js').NationRecord>} over */
const nation = (over) => /** @type {import('../../../site/static/js/types.js').NationRecord} */ (/** @type {unknown} */ ({
  gauges: [], samples: [[48.4, -122.3]], hq: { lat: 48.4, lon: -122.3 }, ...over }));

test('nearbyGauges lists the Nation record gauges first, in record order, skipping unknown ids', () => {
  const all = [gauge('nwps:AAAA1', 48.4, -122.3), gauge('nwps:BBBB1', 48.5, -122.3), gauge('nwps:CCCC1', 48.45, -122.3)];
  const out = nearbyGauges(nation({ gauges: ['nwps:CCCC1', 'nwps:NOPE1', 'nwps:AAAA1'] }), all);
  assert.deepEqual(out.map((g) => g.id), ['nwps:CCCC1', 'nwps:AAAA1']);
});

test('nearbyGauges falls back to gauges within 25 km, forecast points first, then nearest, at most six', () => {
  const all = [
    gauge('nwps:NEAR1', 48.401, -122.3), gauge('nwps:FARR1', 49.5, -122.3), gauge('nwps:FCST1', 48.5, -122.3, true),
    ...Array.from({ length: 8 }, (_, i) => gauge(`nwps:EXT0${i}`, 48.41 + i * 0.01, -122.3)),
  ];
  const out = nearbyGauges(nation({}), all);
  assert.ok(out.length <= 6);
  assert.equal(out[0]?.id, 'nwps:FCST1', 'the forecast point ranks first despite being farther');
  assert.ok(!out.some((g) => g.id === 'nwps:FARR1'), 'a gauge over 25 km away is excluded');
  assert.equal(out[1]?.id, 'nwps:NEAR1');
  assert.deepEqual(nearbyGauges(nation(/** @type {any} */ ({ samples: [], hq: undefined })), all), []);
});
