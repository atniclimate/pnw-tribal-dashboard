// @ts-check
/**
 * Dependency-free geometry helpers (blueprint 3.7.8). DOM-free.
 *
 * STUB (lane L0). Owner: lane L2. Signatures are the contract; bodies throw until the owner implements them.
 */

/** @typedef {import('../types.js').Geometry} Geometry */

const NOT_IMPLEMENTED = 'not implemented';

/**
 * Great-circle distance in kilometres.
 * @param {[number, number]} a [lat, lon]
 * @param {[number, number]} b [lat, lon]
 * @returns {number}
 */
export function haversineKm(a, b) {
  throw new Error(NOT_IMPLEMENTED);
}

/**
 * Ray casting.
 * @param {[number, number]} lonLat
 * @param {Geometry} geometry Polygon or MultiPolygon; holes respected
 * @returns {boolean}
 */
export function pointInGeometry(lonLat, geometry) {
  throw new Error(NOT_IMPLEMENTED);
}

/**
 * [west, south, east, north].
 * @param {Geometry} geometry
 * @returns {[number, number, number, number]}
 */
export function bboxOf(geometry) {
  throw new Error(NOT_IMPLEMENTED);
}

/**
 * @param {[number, number, number, number]} a
 * @param {[number, number, number, number]} b
 * @returns {boolean}
 */
export function bboxIntersects(a, b) {
  throw new Error(NOT_IMPLEMENTED);
}

/**
 * The n nearest items by haversine distance.
 * @template T
 * @param {[number, number]} origin [lat, lon]
 * @param {T[]} items
 * @param {(item: T) => [number, number]} latLonOf
 * @param {number} n
 * @returns {Array<{ item: T, distanceKm: number }>}
 */
export function nearest(origin, items, latLonOf, n) {
  throw new Error(NOT_IMPLEMENTED);
}
