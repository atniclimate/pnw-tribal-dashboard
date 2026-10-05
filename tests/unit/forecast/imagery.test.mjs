// @ts-check
/**
 * Blueprint 5.9, 7.3, 8.1, and 8.3 (L12): the imagery catalog. WPC and ERO labels are exact, GOES URLs use the
 * lowercase sector, Bands 09 and 10 are stills only, no image over 150 KB loads without a tap, every image
 * is stamped from imagery-stamps.json or the model cycle, and the radar site is the nearest by great circle.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { before, describe, test } from 'node:test';
import { CORE_SCHEMA, load } from 'js-yaml';
import { GOES_PRODUCTS, goesAnimationUrl, goesProductIds, goesStillUrl } from '../../../site/static/js/forecast/goes.js';
import { AUTO_LOAD_MAX_BYTES, imageDims, imageryStatus, loadsWithoutTap, sizeLabel, stampMap } from '../../../site/static/js/forecast/imagery.js';
import { RIDGE_MOSAIC, iemValidTime, nearestRadarSite, radarTimeBucket, ridgeProductIds, ridgeSites } from '../../../site/static/js/forecast/radar.js';
import { WPC_LABELS, wpcLabel, wpcProducts } from '../../../site/static/js/forecast/wpc.js';
import { ROOT, fixture, loadRegistry } from './helpers.mjs';

/** @type {any[]} */
let catalog = [];
/** @type {any[]} */
let sources = [];
before(() => {
  sources = loadRegistry();
  catalog = /** @type {any[]} */ (load(readFileSync(new URL('data/imagery/products.yaml', ROOT), 'utf8'), { schema: CORE_SCHEMA }));
});

describe('catalog integrity', () => {
  test('ids are unique, sources are registered, larger and animation references resolve, URLs sit on the source host', () => {
    const ids = new Set(catalog.map((p) => p.id));
    assert.equal(ids.size, catalog.length);
    for (const p of catalog) {
      const src = sources.find((s) => s.id === p.sourceId);
      assert.ok(src, `${p.id}: source ${p.sourceId}`);
      assert.equal(new URL(p.url).hostname, new URL(src.url).hostname, `${p.id}: host`);
      if (p.larger) assert.ok(ids.has(p.larger), `${p.id}: larger ${p.larger}`);
      if (p.animation) assert.ok(ids.has(p.animation), `${p.id}: animation ${p.animation}`);
      assert.ok(['last-modified', 'cycle'].includes(p.stamp), `${p.id}: every image has a stamp rule, never none`);
      assert.equal(p.stamp, p.sourceId === 'cw3e-images' ? 'cycle' : 'last-modified');
    }
  });

  test('no image over 150 KB loads without a tap', () => {
    for (const p of catalog) {
      if (p.loadPolicy === 'auto') assert.ok(p.typicalBytes <= AUTO_LOAD_MAX_BYTES, `${p.id} is ${p.typicalBytes} bytes`);
      assert.equal(loadsWithoutTap(p), p.loadPolicy === 'auto' && p.typicalBytes <= AUTO_LOAD_MAX_BYTES);
      if (p.kind !== 'still') assert.notEqual(p.loadPolicy, 'auto', `${p.id}: loops and video wait for a tap`);
    }
    // A measured size over the budget overrides an auto policy.
    assert.equal(loadsWithoutTap({ ...catalog[0], loadPolicy: 'auto' }, 151_000), false);
  });

  test('every image has pixel dimensions, so none shifts the layout', () => {
    for (const p of catalog.filter((x) => x.kind !== 'video')) {
      const d = imageDims(p);
      assert.ok(d.width > 0 && d.height > 0, p.id);
    }
  });

  test('size labels read as the buttons print them', () => {
    assert.equal(sizeLabel(88_000), '88 KB');
    assert.equal(sizeLabel(1_100_000), '1.1 MB');
    assert.equal(sizeLabel(8_247_293), '8.2 MB');
  });
});

describe('GOES-18', () => {
  test('300 px stills load on their own, 600 px stills and MP4 wait for a tap', () => {
    for (const g of GOES_PRODUCTS) {
      const ids = goesProductIds(g.key);
      const still = catalog.find((p) => p.id === ids.still);
      const larger = catalog.find((p) => p.id === ids.larger);
      assert.equal(still.loadPolicy, 'auto', `${g.key} 300 px`);
      assert.equal(larger.loadPolicy, 'tap', `${g.key} 600 px`);
      assert.equal(still.larger, ids.larger);
      if (ids.animation) {
        const anim = catalog.find((p) => p.id === ids.animation);
        assert.equal(anim.kind, 'video');
        assert.equal(anim.loadPolicy, 'tap');
        assert.equal(still.animation, ids.animation);
      } else assert.equal(still.animation, undefined);
    }
  });

  test('URLs use the lowercase pnw sector and match the catalog', () => {
    assert.equal(goesStillUrl('GEOCOLOR', 300), 'https://cdn.star.nesdis.noaa.gov/GOES18/ABI/SECTOR/pnw/GEOCOLOR/300x300.jpg');
    assert.equal(goesStillUrl('airmass', 600), 'https://cdn.star.nesdis.noaa.gov/GOES18/ABI/SECTOR/pnw/AirMass/600x600.jpg');
    for (const g of GOES_PRODUCTS) {
      for (const size of /** @type {const} */ ([300, 600])) {
        const u = goesStillUrl(g.key, size);
        assert.ok(!u.includes('/PNW/'));
        assert.ok(catalog.some((p) => p.url === u), u);
      }
    }
    assert.throws(() => goesStillUrl('GEOCOLOR', /** @type {any} */ (450)), /size/);
    assert.throws(() => goesStillUrl('nope', 300), /Unknown/);
  });

  test('Bands 09 and 10 are stills only; the others animate as MP4', () => {
    assert.equal(goesAnimationUrl('09'), null);
    assert.equal(goesAnimationUrl('band-10'), null);
    assert.equal(goesAnimationUrl('13'), 'https://cdn.star.nesdis.noaa.gov/GOES18/ABI/SECTOR/pnw/13/GOES18-PNW-13-600x600.mp4');
    for (const key of ['geocolor', 'airmass', 'band-08', 'band-13']) assert.ok(catalog.some((p) => p.url === goesAnimationUrl(key)), key);
    const probe = fixture('goes18-star-cdn', '2026-10-05-head-probe-stills-only-bands.json').results;
    assert.ok(probe.filter((/** @type {any} */ r) => /\/(09|10)\//.test(r.url) && !r.url.includes('PNW/GEOCOLOR')).every((/** @type {any} */ r) => r.status === 404), 'no animation files exist for Bands 09 and 10');
    assert.equal(probe.find((/** @type {any} */ r) => r.url.includes('/PNW/'))?.status, 404, 'the uppercase sector path returns 404');
  });
});

describe('WPC labels', () => {
  test('QPF and Excessive Rainfall labels and file names are exact', () => {
    assert.deepEqual(WPC_LABELS.map((s) => [s.label, s.file]), [
      ['Day 1', 'fill_94qwbg.gif'], ['Day 2', 'fill_98qwbg.gif'], ['Day 3', 'fill_99qwbg.gif'], ['Days 1 to 3', 'd13_fill.gif'],
      ['Days 4 and 5', '95ep48iwbg_fill.gif'], ['Days 6 and 7', '97ep48iwbg_fill.gif'], ['7-Day Total', 'p168i.gif'],
      ['Day 1', '94ewbg.gif'], ['Day 2', '98ewbg.gif'], ['Day 3', '99ewbg.gif'],
    ]);
    assert.equal(wpcLabel('wpc-qpf-days-1-3'), 'Quantitative Precipitation Forecast, Days 1 to 3');
    assert.equal(wpcLabel('wpc-ero-day-2'), 'Excessive Rainfall Outlook, Day 2');
    assert.equal(wpcLabel('nope'), null);
  });

  test('the catalog carries every WPC product under its exact file name, in display order', () => {
    const products = wpcProducts(catalog);
    assert.deepEqual(products.map((p) => p.url.split('/').pop()), WPC_LABELS.map((s) => s.file));
    assert.ok(products.every((p) => p.loadPolicy === 'auto' && p.typicalBytes <= AUTO_LOAD_MAX_BYTES));
    assert.equal(wpcProducts(catalog.map((p) => (p.id === 'wpc-qpf-day-1' ? { ...p, url: p.url.replace('fill_94qwbg', 'fill_93qwbg') } : p))).length, 9, 'a mismatched file name is dropped, not relabeled');
  });
});

describe('radar', () => {
  const ref = JSON.parse(readFileSync(new URL('site/data/ref/radar-sites.json', ROOT), 'utf8'));
  const sites = ridgeSites(ref);

  test('nearest station by great-circle distance over real site coordinates', () => {
    assert.equal(nearestRadarSite([48.79202, -122.6262], sites)?.id, 'KATX', 'Lummi headquarters');
    assert.equal(nearestRadarSite([43.03, -112.43], sites)?.id, 'KSFX', 'Fort Hall');
    assert.equal(nearestRadarSite([55.54, -132.4], sites)?.id, 'PACG', 'Kasaan, Southeast Alaska');
    assert.equal(nearestRadarSite([47.0, -113.99], sites)?.id, 'KMSX', 'western Montana');
    assert.equal(nearestRadarSite([0, 0], []), null);
  });

  test('regression: the raw-degree lookup of the legacy page chose a different, farther station for northern British Columbia', () => {
    const witset = /** @type {[number, number]} */ ([55.02157, -127.33091]);
    let raw = null;
    for (const s of sites) { const d = Math.hypot(s.lat - witset[0], s.lon - witset[1]); if (!raw || d < raw.d) raw = { id: s.id, d }; }
    const best = nearestRadarSite(witset, sites);
    assert.equal(raw?.id, 'KATX');
    assert.equal(best?.id, 'PACG');
    assert.ok(best && best.distanceKm > 500, 'the distance is reported so the page can say it is too far');
  });

  test('new footprint sites are in the reference list and in the catalog, each with a still and a loop', () => {
    for (const id of ['KMSX', 'KBHX', 'PACG', 'KSFX', 'KCBX', 'KLGX', 'KATX']) {
      const ids = ridgeProductIds(id);
      assert.ok(sites.some((s) => s.id === id), `${id} in radar-sites.json`);
      assert.equal(catalog.find((p) => p.id === ids.still)?.loadPolicy, 'auto');
      assert.equal(catalog.find((p) => p.id === ids.loop)?.loadPolicy, 'tap');
    }
    const mosaic = ridgeProductIds(RIDGE_MOSAIC);
    assert.equal(catalog.find((p) => p.id === mosaic.still)?.loadPolicy, 'tap', 'the regional mosaic loads on tap');
    for (const s of sites) assert.ok(catalog.some((p) => p.id === ridgeProductIds(s.id).still), `${s.id} has a catalog still`);
  });

  test('the IEM valid time and the five-minute tile bucket', () => {
    assert.equal(iemValidTime({ meta: { valid: '2026-10-05T09:45:00Z' } }), '2026-10-05T09:45:00.000Z');
    assert.equal(iemValidTime({ meta: {} }), null);
    assert.equal(iemValidTime(null), null);
    assert.equal(radarTimeBucket(new Date('2026-10-05T09:47:31Z')), '202610050945');
    assert.equal(radarTimeBucket(new Date('2026-10-05T09:49:59Z')), '202610050945');
    assert.equal(radarTimeBucket(new Date('2026-10-05T09:50:00Z')), '202610050950');
  });
});

describe('every image is stamped', () => {
  const heads = ['goes18-star-cdn', 'wpc-images', 'nws-ridge', 'ssec-mtpw2'].flatMap((s) => fixture(s, '2026-10-05-head-probe.json').results);

  test('a real Last-Modified exists for every stamped product, and the stamp map reads them', () => {
    const items = heads.map((/** @type {any} */ r) => ({ productId: r.productId, url: r.url, status: r.status, lastModified: r.lastModified ? new Date(r.lastModified).toISOString() : null, contentLength: r.contentLength, checkedAt: '2026-10-05T09:50:00.000Z' }));
    const stamps = stampMap({ completeness: 'complete', items });
    const stamped = catalog.filter((p) => p.sourceId !== 'cw3e-images');
    for (const p of stamped) assert.ok(stamps.get(p.id)?.lastModified, `${p.id} has a stamp`);
  });

  test('a panel with no stamp is unavailable with a reason, never shown unstamped', () => {
    const now = new Date('2026-10-05T10:00:00Z');
    const none = imageryStatus('wpc-images', null, new Map(), ['wpc-qpf-day-1'], now);
    assert.equal(none.state, 'unavailable');
    assert.match(none.detail ?? '', /could not be read/);
    const rejected = imageryStatus('wpc-images', { completeness: 'rejected', items: [] }, stampMap({ completeness: 'rejected', items: [] }), ['wpc-qpf-day-1'], now);
    assert.equal(rejected.state, 'unavailable');
    assert.equal(stampMap({ completeness: 'complete', items: [{ productId: 'x', status: 404, lastModified: null }] }).size, 0);
  });

  test('a stamped panel takes the newest Last-Modified as its issued time, aged by the source policy', () => {
    const stamps = stampMap({ completeness: 'complete', items: [
      { productId: 'a', status: 200, lastModified: '2026-10-05T05:52:06.000Z' }, { productId: 'b', status: 200, lastModified: '2026-10-05T09:06:05.000Z' }] });
    const live = imageryStatus('wpc-images', { carriedForward: false }, stamps, ['a', 'b'], new Date('2026-10-05T10:00:00Z'));
    assert.equal(live.asOf, '2026-10-05T09:06:05.000Z');
    assert.equal(live.asOfBasis, 'issued');
    assert.equal(live.state, 'live');
    const old = imageryStatus('wpc-images', { carriedForward: false }, stamps, ['a', 'b'], new Date('2026-10-05T20:00:00Z'));
    assert.notEqual(old.state, 'live');
  });
});
