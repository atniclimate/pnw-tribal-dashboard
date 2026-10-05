// @ts-check
/**
 * The imagery catalog (data/imagery/products.yaml, compiled to data/curated/imagery-products.json) and the
 * scheduled stamps (data/live/imagery-stamps.json). Every image on the forecasts page is stamped from here or
 * from the model cycle; an image with no stamp is not shown. DOM-free.
 */
import { APP } from '../config/app.js';
import { fetchLocal } from '../core/net.js';
import { findSource } from '../core/sources.js';
import { deriveStatus } from '../core/status.js';

/** @typedef {import('../types.js').ImageryProduct} ImageryProduct */
/** @typedef {import('../types.js').StatusSnapshot} StatusSnapshot */
/** @typedef {{ productId: string, url: string, status: number, lastModified: string | null, contentLength: number | null, checkedAt: string }} Stamp */

/** No image larger than this loads without a tap (blueprint 8.1). */
export const AUTO_LOAD_MAX_BYTES = 150_000;

/**
 * @param {{ signal?: AbortSignal }} [opts]
 * @returns {Promise<Map<string, ImageryProduct> | null>} null when the compiled catalog cannot be read
 */
export async function loadCatalog(opts = {}) {
  const res = await fetchLocal('data/curated/imagery-products.json', { priority: 1, ...(opts.signal ? { signal: opts.signal } : {}) });
  const items = res.ok ? /** @type {any} */ (res.data)?.items : null;
  if (!Array.isArray(items)) return null;
  return new Map(items.map((/** @type {ImageryProduct} */ p) => [p.id, p]));
}

/**
 * @param {unknown} env imagery-stamps.json
 * @returns {Map<string, Stamp>}
 */
export function stampMap(env) {
  const e = /** @type {any} */ (env);
  /** @type {Map<string, Stamp>} */
  const out = new Map();
  if (!e || e.completeness === 'rejected' || !Array.isArray(e.items)) return out;
  for (const i of e.items) if (i && typeof i.productId === 'string' && i.status === 200 && typeof i.lastModified === 'string') out.set(i.productId, i);
  return out;
}

/**
 * @param {{ signal?: AbortSignal }} [opts]
 * @returns {Promise<{ env: any | null, stamps: Map<string, Stamp> }>}
 */
export async function loadStamps(opts = {}) {
  const res = await fetchLocal('data/live/imagery-stamps.json', { priority: 2, cache: 'no-cache', ...(opts.signal ? { signal: opts.signal } : {}) });
  return { env: res.ok ? res.data : null, stamps: res.ok ? stampMap(res.data) : new Map() };
}

/**
 * Whether a product may load without a tap: policy auto and a size that fits the budget.
 * @param {ImageryProduct} product
 * @param {number | null} [measuredBytes] the stamp's size when known
 * @returns {boolean}
 */
export function loadsWithoutTap(product, measuredBytes = null) {
  const bytes = measuredBytes ?? product.typicalBytes;
  return product.loadPolicy === 'auto' && bytes <= AUTO_LOAD_MAX_BYTES;
}

/**
 * Pixel size of a catalog image, measured from real files on 10/05/2026, so every image has width and height
 * set before it loads (no layout shift).
 * @param {ImageryProduct} product
 * @returns {{ width: number, height: number }}
 */
export function imageDims(product) {
  const id = product.id;
  if (product.sourceId === 'goes18-star-cdn') return id.endsWith('-300') ? { width: 300, height: 300 } : { width: 600, height: 600 };
  if (product.sourceId === 'wpc-images') return { width: 800, height: 561 };
  if (product.sourceId === 'nws-ridge') return id.includes('pacnorthwest') ? { width: 600, height: 571 } : { width: 600, height: 550 };
  if (product.sourceId === 'ssec-mtpw2') return { width: 1000, height: 470 };
  if (id.includes('arscale')) return { width: 769, height: 942 };
  if (id.includes('landfalltool')) return { width: 2203, height: 1007 };
  if (id.endsWith('-nepac')) return { width: 1704, height: 1400 };
  if (id.endsWith('-npac')) return { width: 1725, height: 1015 };
  if (id.includes('iwv')) return { width: 1655, height: 1466 };
  return { width: 1692, height: 1477 };
}

/**
 * "88 KB" or "1.1 MB" (decimal units, as the sources report them).
 * @param {number} bytes
 * @returns {string}
 */
export function sizeLabel(bytes) {
  if (bytes >= 1_000_000) return `${(Math.round(bytes / 100_000) / 10).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1000))} KB`;
}

/**
 * Status for an image panel: the newest Last-Modified among its products, judged by the source's freshness
 * policy. Unavailable when no product has a stamp.
 * @param {string} sourceId
 * @param {unknown} env imagery-stamps.json
 * @param {Map<string, Stamp>} stamps
 * @param {string[]} productIds products the panel can show
 * @param {Date} now
 * @returns {StatusSnapshot}
 */
export function imageryStatus(sourceId, env, stamps, productIds, now) {
  const policy = findSource(sourceId)?.freshness ?? APP.freshness.forecasts;
  const times = productIds.map((id) => stamps.get(id)?.lastModified).filter((t) => typeof t === 'string').map((t) => Date.parse(/** @type {string} */ (t))).filter((t) => !Number.isNaN(t));
  if (times.length === 0) {
    return deriveStatus({
      sourceIds: [sourceId], policy, now,
      unavailableReason: env ? 'The source publishes no usable update time for these images, so they are not shown.' : 'The scheduled image update times could not be read, so the images are not shown.',
    });
  }
  return deriveStatus({
    sourceIds: [sourceId], policy, now,
    snapshot: { asOf: new Date(Math.max(...times)).toISOString(), asOfBasis: 'issued', carriedForward: Boolean(/** @type {any} */ (env)?.carriedForward) },
  });
}
