// @ts-check
/**
 * GOES-18 Pacific Northwest sector stills and MP4 animations (blueprint 7.3). DOM-free.
 * URLs come from the source registry; the sector folder is the lowercase /pnw/ (the uppercase path returns 404).
 */
import { url } from '../core/sources.js';

const SOURCE_ID = 'goes18-star-cdn';

/**
 * Product buttons in display order. `dir` is the folder name; `animated` is false for Bands 09 and 10 (stills only).
 * `note` is the reading aid shown with the product.
 * @type {readonly { key: string, dir: string, slug: string, label: string, animated: boolean }[]}
 */
export const GOES_PRODUCTS = Object.freeze([
  { key: 'geocolor', dir: 'GEOCOLOR', slug: 'geocolor', label: 'GeoColor', animated: true },
  { key: 'airmass', dir: 'AirMass', slug: 'airmass', label: 'Air Mass', animated: true },
  { key: 'band-08', dir: '08', slug: 'band-08', label: 'Water Vapor (Band 08)', animated: true },
  { key: 'band-13', dir: '13', slug: 'band-13', label: 'Clean Infrared (Band 13)', animated: true },
  { key: 'band-09', dir: '09', slug: 'band-09', label: 'Mid-Level Water Vapor (Band 09)', animated: false },
  { key: 'band-10', dir: '10', slug: 'band-10', label: 'Lower-Level Water Vapor (Band 10)', animated: false },
]);

/**
 * @param {string} product folder name ("GEOCOLOR", "AirMass", "08") or product key ("geocolor", "band-08")
 * @returns {{ key: string, dir: string, slug: string, label: string, animated: boolean }}
 */
export function goesProduct(product) {
  const p = GOES_PRODUCTS.find((x) => x.dir === product || x.key === product);
  if (!p) throw new Error(`Unknown GOES product "${product}"`);
  return p;
}

/**
 * Lowercase /pnw/ sector path only.
 * @param {string} product
 * @param {300 | 600} size
 * @returns {string}
 */
export function goesStillUrl(product, size) {
  if (size !== 300 && size !== 600) throw new Error(`Unsupported GOES still size ${size}`);
  const p = goesProduct(product);
  return url(SOURCE_ID, { product: p.dir, file: `${size}x${size}.jpg` });
}

/**
 * Null for Bands 09 and 10 (stills only).
 * @param {string} product
 * @returns {string | null}
 */
export function goesAnimationUrl(product) {
  const p = goesProduct(product);
  if (!p.animated) return null;
  return url(SOURCE_ID, { product: p.dir, file: `GOES18-PNW-${p.dir}-600x600.mp4` });
}

/**
 * Imagery catalog ids for a product (data/imagery/products.yaml).
 * @param {string} product
 * @returns {{ still: string, larger: string, animation: string | null }}
 */
export function goesProductIds(product) {
  const p = goesProduct(product);
  return { still: `goes18-pnw-${p.slug}-300`, larger: `goes18-pnw-${p.slug}-600`, animation: p.animated ? `goes18-pnw-${p.slug}-mp4` : null };
}
