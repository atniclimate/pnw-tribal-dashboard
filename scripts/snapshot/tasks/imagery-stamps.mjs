// @ts-check
/**
 * Snapshot task `imagery-stamps` (blueprint 5.9, 6.4): Last-Modified per catalog image, read with HEAD
 * requests, so the browser can stamp every image without a cross-origin read (WPC and RIDGE send no CORS
 * header). CW3E and SSEC are link-only (decision Q11, 10/05/2026) and are never requested.
 * Never throws for upstream failures: a failed HEAD is recorded with its status, and when nothing answers
 * the envelope is `rejected` so the runner carries the previous copy forward.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CORE_SCHEMA, load as loadYaml } from 'js-yaml';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
export const PRODUCTS_FILE = path.join(ROOT, 'data', 'imagery', 'products.yaml');
export const STAMPED_SOURCES = Object.freeze(['goes18-star-cdn', 'nws-ridge', 'wpc-images']);
const CONCURRENCY = 6;

/**
 * Products whose stamp comes from a Last-Modified header.
 * @param {string} [file]
 * @returns {Promise<{ id: string, sourceId: string, url: string, stamp?: string }[]>}
 */
export async function stampedProducts(file = PRODUCTS_FILE) {
  const doc = /** @type {any[]} */ (loadYaml(await readFile(file, 'utf8'), { schema: CORE_SCHEMA }));
  return doc.filter((p) => STAMPED_SOURCES.includes(p.sourceId) && p.stamp !== 'none');
}

/**
 * HTTP date to ISO 8601, or null.
 * @param {string | null | undefined} value
 * @returns {string | null}
 */
export function httpDateToIso(value) {
  if (!value) return null;
  const t = Date.parse(value);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

/** @type {import('../../../site/static/js/types.js').SnapshotTask} */
export default {
  id: 'imagery-stamps',
  sourceIds: [...STAMPED_SOURCES],
  cadenceMin: 30,
  outputs: ['imagery-stamps.json'],
  async run(ctx) {
    const at = ctx.now.toISOString();
    const products = await stampedProducts();
    /** @type {{ productId: string, url: string, status: number, lastModified: string | null, contentLength: number | null, checkedAt: string }[]} */
    const items = new Array(products.length);
    let next = 0;
    let firstError = '';
    await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
      for (;;) {
        const i = next++;
        const p = products[i];
        if (!p) return;
        const res = await ctx.http.head(p.sourceId, p.url, { timeoutMs: 20000 });
        if (!res.ok) firstError ||= `${res.error.kind}: ${res.error.message}`;
        items[i] = {
          productId: p.id,
          url: p.url,
          status: res.ok ? res.status : (res.error.status ?? 0),
          lastModified: res.ok ? httpDateToIso(res.lastModified) : null,
          contentLength: null,
          checkedAt: res.fetchedAt,
        };
      }
    }));
    const stamped = items.filter((i) => i.status === 200 && i.lastModified !== null);
    const times = stamped.map((i) => /** @type {string} */ (i.lastModified)).sort();
    const asOf = times.length ? /** @type {string} */ (times[times.length - 1]) : null;
    /** @type {Record<string, { ok: boolean, count: number, asOf: string | null }>} */
    const perSource = {};
    for (const id of STAMPED_SOURCES) {
      const own = products.map((p, i) => ({ p, item: items[i] })).filter((x) => x.p.sourceId === id);
      const ok = own.filter((x) => x.item?.status === 200 && x.item.lastModified !== null);
      const t = ok.map((x) => /** @type {string} */ (x.item?.lastModified)).sort();
      perSource[id] = { ok: ok.length > 0, count: ok.length, asOf: t.length ? /** @type {string} */ (t[t.length - 1]) : null };
    }
    const rejected = stamped.length === 0;
    return {
      'imagery-stamps.json': {
        schema: 'cthd.live.imagery-stamps/1',
        id: 'imagery-stamps',
        sourceIds: [...STAMPED_SOURCES],
        generatedAt: at,
        observedAt: at,
        asOf: rejected ? null : asOf,
        asOfBasis: rejected ? null : 'issued',
        completeness: rejected ? 'rejected' : stamped.length === products.length ? 'complete' : 'partial',
        carriedForward: false,
        failure: rejected ? { code: 'upstream', message: firstError || 'no image answered', at } : null,
        perSource,
        diagnostics: { products: products.length, stamped: stamped.length, missing: products.length - stamped.length },
        items: rejected ? [] : items,
      },
    };
  },
};
