// @ts-check
/**
 * Blueprint 5.9 and 7.3 (L12): CW3E cycle resolution. Probe bundles are real HEAD results; the one-missing-hour
 * bundle is derived from the real one (see tests/fixtures/upstream/cw3e-images/README.md).
 */
import assert from 'node:assert/strict';
import { before, describe, test } from 'node:test';
import {
  FORECAST_HOURS, candidateCycles, cw3eUrl, cycleDate, manifestItem, modelRunLabel, newestCompleteCycle, probeCycleInBrowser, resolveCycleFromManifest,
} from '../../../site/static/js/forecast/cw3e.js';
import arProducts, { parseFolder } from '../../../scripts/snapshot/tasks/ar-products.mjs';
import { fixture, loadRegistry } from './helpers.mjs';

/** @type {string} */
let template = '';
before(() => { template = /** @type {string} */ (loadRegistry().find((s) => s.id === 'cw3e-images').urlTemplate); });

/**
 * @param {{ results: any[] }} bundle
 * @param {string} model
 */
function hasFrom(bundle, model) {
  const ok = new Set(bundle.results.filter((r) => r.model === model && r.status === 200).map((r) => `${r.cycle}/${r.fh}`));
  return async (/** @type {string} */ cycle, /** @type {number} */ fh) => ok.has(`${cycle}/${fh}`);
}

describe('URL and cycle arithmetic', () => {
  test('the template fills product, model, domain, cycle, and a three-digit forecast hour', () => {
    assert.equal(
      cw3eUrl(template, { product: 'ivt_map', model: 'GFS_25', domain: 'USWC', cycle: '2026100412', fh: 0 }),
      'https://cw3e.ucsd.edu/images/ivt_map/v1/GFS_25/USWC/2026100412/1/ivt_map__v1__GFS_25__USWC__2026100412__1__F000.png');
    assert.match(cw3eUrl(template, { product: 'iwv_map', model: 'ECMWF_HRes', domain: 'NEPac', cycle: '2026100500', fh: 168 }), /__F168\.png$/);
    assert.throws(() => cw3eUrl(template, { product: '../x', model: 'GFS_25', domain: 'USWC', cycle: '2026100412', fh: 0 }), /product/);
    assert.throws(() => cw3eUrl(template, { product: 'ivt_map', model: 'GFS_25', domain: 'USWC', cycle: '20261004', fh: 0 }), /cycle/);
    assert.throws(() => cw3eUrl(template, { product: 'ivt_map', model: 'GFS_25', domain: 'USWC', cycle: '2026100412', fh: -1 }), /hour/);
  });

  test('candidate cycles step back six hours from the cycle at or before now', () => {
    assert.deepEqual(candidateCycles(new Date('2026-10-05T09:50:00Z'), 4), ['2026100506', '2026100500', '2026100418', '2026100412']);
    assert.equal(candidateCycles(new Date('2026-10-05T09:50:00Z')).length, 8);
    assert.equal(cycleDate('2026100500').toISOString(), '2026-10-05T00:00:00.000Z');
    assert.equal(modelRunLabel('2026100412'), 'Model run 10/04/2026 12 UTC');
    assert.deepEqual(FORECAST_HOURS.slice(0, 3), [0, 12, 24]);
    assert.equal(FORECAST_HOURS.at(-1), 168);
  });
});

describe('newest complete cycle', () => {
  const real = fixture('cw3e-images', '2026-10-05-head-probe-ivt-uswc.json');
  const missing = fixture('cw3e-images', '2026-10-05-head-probe-ivt-uswc-one-missing-hour.json');
  const cycles = ['2026100506', '2026100500', '2026100418'];

  test('real captures: the unpublished newest cycle is skipped and the next complete one is chosen', async () => {
    const r = await newestCompleteCycle({ cycles, hours: FORECAST_HOURS, has: hasFrom(real, 'GFS_25') });
    assert.equal(r?.cycle, '2026100500');
    assert.deepEqual(r?.skipped, [{ cycle: '2026100506', missing: [168] }]);
    const e = await newestCompleteCycle({ cycles, hours: FORECAST_HOURS, has: hasFrom(real, 'ECMWF_HRes') });
    assert.equal(e?.cycle, '2026100500');
  });

  test('a fixture with one missing hour: the newer cycle is rejected and the older complete cycle wins', async () => {
    const r = await newestCompleteCycle({ cycles, hours: FORECAST_HOURS, has: hasFrom(missing, 'GFS_25') });
    assert.equal(r?.cycle, '2026100418');
    assert.deepEqual(r?.skipped.find((s) => s.cycle === '2026100500'), { cycle: '2026100500', missing: [84] });
    assert.equal(missing.results.filter((/** @type {any} */ x) => x.status !== 200 && x.cycle === '2026100500' && x.model === 'GFS_25').length, 1, 'exactly one hour is missing');
  });

  test('the last hour is probed first, so an unwritten cycle costs one request', async () => {
    /** @type {string[]} */
    const asked = [];
    await newestCompleteCycle({ cycles: ['2026100506'], hours: FORECAST_HOURS, has: async (c, h) => { asked.push(`${c}/${h}`); return false; } });
    assert.deepEqual(asked, ['2026100506/168']);
  });

  test('no complete cycle gives null', async () => {
    assert.equal(await newestCompleteCycle({ cycles, hours: FORECAST_HOURS, has: async () => false }), null);
  });
});

describe('manifest and the browser fallback', () => {
  const NOW = new Date('2026-10-05T09:50:00Z');
  const manifest = {
    completeness: 'complete', carriedForward: false,
    items: [
      { product: 'ivt_map', model: 'GFS_25', domain: 'USWC', cycle: '2026100500', forecastHours: [0], urls: ['https://cw3e.ucsd.edu/x'] },
      { product: 'ivt_map', model: 'ECMWF_HRes', domain: 'USWC', cycle: '2026100412', forecastHours: [0], urls: ['https://cw3e.ucsd.edu/y'] },
    ],
  };

  test('the manifest resolves to its newest cycle; old, carried-forward, or rejected manifests are stale or null', () => {
    assert.deepEqual(resolveCycleFromManifest(manifest, NOW), { cycle: '2026100500', stale: false });
    assert.equal(resolveCycleFromManifest(manifest, new Date('2026-10-07T09:50:00Z'))?.stale, true);
    assert.equal(resolveCycleFromManifest({ ...manifest, carriedForward: true }, NOW)?.stale, true);
    assert.equal(resolveCycleFromManifest({ ...manifest, completeness: 'rejected' }, NOW), null);
    assert.equal(resolveCycleFromManifest({ items: [] }, NOW), null);
    assert.equal(resolveCycleFromManifest(null, NOW), null);
    assert.equal(manifestItem(manifest, 'ivt_map', 'GFS_25', 'USWC')?.cycle, '2026100500');
    assert.equal(manifestItem(manifest, 'iwv_map', 'GFS_25', 'USWC'), null);
  });

  test('the browser probe loads candidates stepping back six hours and returns the first that loads', async () => {
    /** @type {string[]} */
    const tried = [];
    const url = await probeCycleInBrowser((c) => cw3eUrl(template, { product: 'ivt_map', model: 'GFS_25', domain: 'USWC', cycle: c, fh: 0 }), NOW, undefined,
      async (src) => { tried.push(/(\d{10})__1__F/.exec(src)?.[1] ?? ''); return src.includes('2026100418'); });
    assert.deepEqual(tried, ['2026100506', '2026100500', '2026100418']);
    assert.match(url ?? '', /2026100418__1__F000\.png$/);
  });

  test('the probe gives null when nothing loads within two days, and stops when aborted', async () => {
    let calls = 0;
    assert.equal(await probeCycleInBrowser((c) => `https://cw3e.ucsd.edu/${c}`, NOW, undefined, async () => { calls += 1; return false; }), null);
    assert.equal(calls, 8);
    const ctl = new AbortController();
    ctl.abort();
    assert.equal(await probeCycleInBrowser((c) => c, NOW, ctl.signal, async () => true), null);
  });
});

describe('ar-products snapshot task', () => {
  /**
   * An http stub that answers HEAD from a probe bundle (only the combinations the bundle covers exist).
   * @param {{ results: any[] }} bundle
   */
  function http(bundle) {
    const ok = new Map(bundle.results.map((r) => [r.url, r]));
    return {
      /** @param {string} _id @param {string} u */
      async head(_id, u) {
        const r = ok.get(u);
        const at = '2026-10-05T09:50:00.000Z';
        return r && r.status === 200 ? { ok: /** @type {const} */ (true), data: null, status: 200, fetchedAt: at, lastModified: r.lastModified, sourceId: 'cw3e-images' }
          : { ok: /** @type {const} */ (false), error: { kind: /** @type {const} */ ('http'), status: 404, message: 'HTTP 404' }, fetchedAt: at, sourceId: 'cw3e-images' };
      },
      async getJson() { throw new Error('unused'); },
      async getText() { throw new Error('unused'); },
    };
  }
  const ctx = (/** @type {any} */ h) => /** @type {any} */ ({ now: new Date('2026-10-05T09:50:00Z'), http: h, log() {} });

  test('resolves the newest complete cycle per combination, partial when others have none', async () => {
    const out = await arProducts.run(ctx(http(fixture('cw3e-images', '2026-10-05-head-probe-ivt-uswc.json'))));
    const env = /** @type {any} */ (out['ar-products.json']);
    assert.equal(env.schema, 'cthd.live.ar-products/1');
    assert.equal(env.completeness, 'partial');
    assert.deepEqual(env.items.map((/** @type {any} */ i) => `${i.model}/${i.domain}/${i.cycle}`), ['ECMWF_HRes/USWC/2026100500', 'GFS_25/USWC/2026100500']);
    assert.equal(env.asOf, '2026-10-05T00:00:00.000Z');
    assert.equal(env.asOfBasis, 'model-run');
    assert.equal(env.items[0].urls.length, 15);
    assert.ok(env.items[0].urls[0].endsWith('__F000.png') && env.items[0].urls[14].endsWith('__F168.png'));
  });

  test('with the derived one-missing-hour bundle the GFS item steps back to the older complete cycle', async () => {
    const out = await arProducts.run(ctx(http(fixture('cw3e-images', '2026-10-05-head-probe-ivt-uswc-one-missing-hour.json'))));
    const env = /** @type {any} */ (out['ar-products.json']);
    const gfs = env.items.find((/** @type {any} */ i) => i.model === 'GFS_25');
    assert.equal(gfs.cycle, '2026100418');
    assert.equal(env.items.find((/** @type {any} */ i) => i.model === 'ECMWF_HRes').cycle, '2026100500');
    assert.ok(env.diagnostics.skippedCycles >= 1);
  });

  test('when every request fails the envelope is rejected with no items, never an empty success', async () => {
    const out = await arProducts.run(ctx(http({ results: [] })));
    const env = /** @type {any} */ (out['ar-products.json']);
    assert.equal(env.completeness, 'rejected');
    assert.deepEqual(env.items, []);
    assert.equal(env.asOf, null);
    assert.ok(env.failure?.code);
  });

  test('catalog folder URLs parse to product, model, and domain', () => {
    assert.deepEqual(parseFolder('https://cw3e.ucsd.edu/images/ivt_map/v1/GFS_25/USWC/'), { product: 'ivt_map', model: 'GFS_25', domain: 'USWC' });
    assert.equal(parseFolder('https://cw3e.ucsd.edu/elsewhere/'), null);
  });
});
