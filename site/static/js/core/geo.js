// @ts-check
/**
 * Dependency-free geometry helpers (blueprint 3.7.8). DOM-free. Coordinates are GeoJSON [lon, lat];
 * the footprint never crosses the antimeridian, so longitudes are not wrapped.
 */

/** @typedef {import('../types.js').Geometry} Geometry */

const EARTH_RADIUS_KM = 6371.0088;
const rad = (/** @type {number} */ deg) => (deg * Math.PI) / 180;

/**
 * Great-circle distance in kilometres.
 * @param {[number, number]} a [lat, lon]
 * @param {[number, number]} b [lat, lon]
 * @returns {number}
 */
export function haversineKm(a, b) {
  const dLat = rad(b[0] - a[0]);
  const dLon = rad(b[1] - a[1]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a[0])) * Math.cos(rad(b[0])) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * @param {[number, number]} pt
 * @param {number[][]} ring
 * @returns {boolean}
 */
function inRing(pt, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const [xi = 0, yi = 0] = ring[i] ?? [];
    const [xj = 0, yj = 0] = ring[j] ?? [];
    if ((yi > pt[1]) !== (yj > pt[1]) && pt[0] < ((xj - xi) * (pt[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/**
 * @param {[number, number]} pt
 * @param {number[][][]} rings outer ring first, then holes
 * @returns {boolean}
 */
function inPolygon(pt, rings) {
  const outer = rings[0];
  if (!outer || !inRing(pt, outer)) return false;
  for (const hole of rings.slice(1)) if (inRing(pt, hole)) return false;
  return true;
}

/**
 * Ray casting.
 * @param {[number, number]} lonLat
 * @param {Geometry} geometry Polygon or MultiPolygon; holes respected
 * @returns {boolean}
 */
export function pointInGeometry(lonLat, geometry) {
  if (geometry.type === 'Polygon') return inPolygon(lonLat, geometry.coordinates);
  if (geometry.type === 'MultiPolygon') return geometry.coordinates.some((p) => inPolygon(lonLat, p));
  if (geometry.type === 'GeometryCollection') return geometry.geometries.some((g) => pointInGeometry(lonLat, g));
  return false;
}

/**
 * @param {unknown} coords
 * @param {number[]} box [west, south, east, north], updated in place
 */
function extend(coords, box) {
  if (!Array.isArray(coords)) return;
  if (typeof coords[0] === 'number') {
    const x = /** @type {number} */ (coords[0]);
    const y = /** @type {number} */ (coords[1]);
    box[0] = Math.min(/** @type {number} */ (box[0]), x);
    box[1] = Math.min(/** @type {number} */ (box[1]), y);
    box[2] = Math.max(/** @type {number} */ (box[2]), x);
    box[3] = Math.max(/** @type {number} */ (box[3]), y);
    return;
  }
  for (const c of coords) extend(c, box);
}

/**
 * [west, south, east, north]. Throws on a geometry with no coordinates.
 * @param {Geometry} geometry
 * @returns {[number, number, number, number]}
 */
export function bboxOf(geometry) {
  const box = [Infinity, Infinity, -Infinity, -Infinity];
  if (geometry.type === 'GeometryCollection') {
    for (const g of geometry.geometries) {
      const b = bboxOf(g);
      extend([b[0], b[1]], box);
      extend([b[2], b[3]], box);
    }
  } else {
    extend(geometry.coordinates, box);
  }
  if (!Number.isFinite(box[0])) throw new Error('bboxOf: geometry has no coordinates');
  return /** @type {[number, number, number, number]} */ (box);
}

/**
 * @param {[number, number, number, number]} a
 * @param {[number, number, number, number]} b
 * @returns {boolean}
 */
export function bboxIntersects(a, b) {
  return a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];
}

/**
 * The n nearest items by haversine distance; ties keep input order.
 * @template T
 * @param {[number, number]} origin [lat, lon]
 * @param {T[]} items
 * @param {(item: T) => [number, number]} latLonOf
 * @param {number} n
 * @returns {Array<{ item: T, distanceKm: number }>}
 */
export function nearest(origin, items, latLonOf, n) {
  return items
    .map((item, index) => ({ item, index, distanceKm: haversineKm(origin, latLonOf(item)) }))
    .sort((x, y) => x.distanceKm - y.distanceKm || x.index - y.index)
    .slice(0, Math.max(0, n))
    .map(({ item, distanceKm }) => ({ item, distanceKm }));
}
