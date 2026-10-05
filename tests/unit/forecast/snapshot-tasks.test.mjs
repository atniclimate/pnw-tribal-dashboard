// @ts-check
/**
 * Blueprint 5.9 and 6.4 (L12): the imagery-stamps and ar-products snapshot tasks. HEAD results come from the
 * real probe bundles in tests/fixtures/upstream; envelopes validate against their live schemas.
 */
import assert from 'node:assert/strict';
import { before, describe, test } from 'node:test';
import { loadAjv } from '../../../scripts/check/lib/data-files.mjs';
import { envelopeErrors } from '../../../scripts/lib/live.mjs';
import arProducts from '../../../scripts/snapshot/tasks/ar-products.mjs';
import imageryStamps, { httpDateToIso, stampedProducts } from '../../../scripts/snapshot/tasks/imagery-stamps.mjs';
import { fixture } from './helpers.mjs';

/** @type {Awaited<ReturnType<typeof loadAjv>>} */
let ajv;
before(async () => { ajv = await loadAjv(); });

const bundles = ['goes18-star-cdn', 'wpc-images', 'nws-ridge', 'ssec-mtpw2'].flatMap((s) => fixture(s, '2026-10-05-head-probe.json').results);
const byUrl = new Map(bundles.map((/** @type {any} */ r) => [r.url, r]));
const NOW = new Date('2026-10-05T09:55:00Z');

/** @param {(url: string) => any} answer */
const http = (answer) => ({
  /** @param {string} id @param {string} url */
  async head(id, url) {
    const r = answer(url);
    const at = NOW.toISOString();
    return r && r.status === 200
      ? { ok: /** @type {const} */ (true), data: null, status: 200, fetchedAt: at, lastModified: r.lastModified, sourceId: id }
      : { ok: /** @type {const} */ (false), error: { kind: /** @type {const} */ ('http'), status: r?.status ?? 404, message: 'HTTP 404' }, fetchedAt: at, sourceId: id };
  },
  async getJson() { throw new Error('unused'); },
  async getText() { throw new Error('unused'); },
});
const ctx = (/** @type {any} */ h) => /** @type {any} */ ({ now: NOW, http: h, log() {} });

describe('imagery-stamps', () => {
  test('every stamped product is read once, and the envelope validates', async () => {
    const products = await stampedProducts();
    assert.ok(products.length >= 70);
    assert.ok(products.every((p) => p.sourceId !== 'cw3e-images'), 'CW3E is stamped from the model cycle by ar-products');
    const out = await imageryStamps.run(ctx(http((u) => byUrl.get(u))));
    const env = /** @type {any} */ (out['imagery-stamps.json']);
    assert.deepEqual(envelopeErrors(ajv, 'imagery-stamps.json', env), []);
    assert.equal(env.completeness, 'complete');
    assert.equal(env.items.length, products.length);
    assert.equal(env.asOfBasis, 'issued');
    for (const i of env.items) assert.match(i.lastModified, /^\d{4}-\d\d-\d\dT/);
    assert.deepEqual(Object.keys(env.perSource).sort(), ['goes18-star-cdn', 'nws-ridge', 'ssec-mtpw2', 'wpc-images']);
    assert.equal(env.asOf, [...env.items.map((/** @type {any} */ i) => i.lastModified)].sort().at(-1));
  });

  test('a product that answers 404 is recorded and the envelope is partial', async () => {
    const out = await imageryStamps.run(ctx(http((u) => (u.includes('p168i') ? { status: 404 } : byUrl.get(u)))));
    const env = /** @type {any} */ (out['imagery-stamps.json']);
    assert.equal(env.completeness, 'partial');
    assert.equal(env.items.find((/** @type {any} */ i) => i.productId === 'wpc-qpf-7-day-total').status, 404);
    assert.equal(env.items.find((/** @type {any} */ i) => i.productId === 'wpc-qpf-7-day-total').lastModified, null);
    assert.deepEqual(envelopeErrors(ajv, 'imagery-stamps.json', env), []);
  });

  test('with every source down the envelope is rejected with no items', async () => {
    const out = await imageryStamps.run(ctx(http(() => null)));
    const env = /** @type {any} */ (out['imagery-stamps.json']);
    assert.equal(env.completeness, 'rejected');
    assert.deepEqual(env.items, []);
    assert.equal(env.asOf, null);
    assert.deepEqual(envelopeErrors(ajv, 'imagery-stamps.json', env), []);
  });

  test('HTTP dates become ISO 8601; nothing else passes', () => {
    assert.equal(httpDateToIso('Mon, 05 Oct 2026 09:06:05 GMT'), '2026-10-05T09:06:05.000Z');
    assert.equal(httpDateToIso(null), null);
    assert.equal(httpDateToIso('yesterday'), null);
  });
});

describe('ar-products envelope', () => {
  test('validates against its live schema', async () => {
    const real = fixture('cw3e-images', '2026-10-05-head-probe-ivt-uswc.json');
    const ok = new Map(real.results.map((/** @type {any} */ r) => [r.url, r]));
    const out = await arProducts.run(ctx(http((u) => ok.get(u))));
    assert.deepEqual(envelopeErrors(ajv, 'ar-products.json', out['ar-products.json']), []);
  });
});
