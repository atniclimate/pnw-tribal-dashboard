// @ts-check
/** core/geo.js: haversine, ray casting with holes, bounding boxes, nearest. Coordinates are real places. */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { bboxIntersects, bboxOf, haversineKm, nearest, pointInGeometry } from '../../../site/static/js/core/geo.js';

describe('haversineKm', () => {
  test('Seattle to Portland is about 233 km', () => {
    const d = haversineKm([47.6062, -122.3321], [45.5152, -122.6784]);
    assert.ok(d > 230 && d < 236, String(d));
  });

  test('Seattle to Vancouver is about 195 km', () => {
    const d = haversineKm([47.6062, -122.3321], [49.2827, -123.1207]);
    assert.ok(d > 191 && d < 199, String(d));
  });

  test('identical points are zero, and distance is symmetric', () => {
    assert.equal(haversineKm([47, -122], [47, -122]), 0);
    const a = /** @type {[number, number]} */ ([47.6, -122.3]);
    const b = /** @type {[number, number]} */ ([43.6, -116.2]);
    assert.equal(haversineKm(a, b), haversineKm(b, a));
  });

  test('one degree of latitude is about 111.2 km', () => {
    const d = haversineKm([45, -120], [46, -120]);
    assert.ok(Math.abs(d - 111.2) < 0.2, String(d));
  });
});

/** @type {import('../../../site/static/js/types.js').Geometry} */
const SQUARE_WITH_HOLE = {
  type: 'Polygon',
  coordinates: [
    [[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]],
    [[4, 4], [6, 4], [6, 6], [4, 6], [4, 4]],
  ],
};

describe('pointInGeometry', () => {
  test('inside, outside, and inside a hole', () => {
    assert.equal(pointInGeometry([2, 2], SQUARE_WITH_HOLE), true);
    assert.equal(pointInGeometry([5, 5], SQUARE_WITH_HOLE), false, 'the hole is outside');
    assert.equal(pointInGeometry([11, 5], SQUARE_WITH_HOLE), false);
    assert.equal(pointInGeometry([-1, -1], SQUARE_WITH_HOLE), false);
  });

  test('MultiPolygon: any part counts', () => {
    /** @type {import('../../../site/static/js/types.js').Geometry} */
    const multi = { type: 'MultiPolygon', coordinates: [[[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]], [[[5, 5], [6, 5], [6, 6], [5, 6], [5, 5]]]] };
    assert.equal(pointInGeometry([0.5, 0.5], multi), true);
    assert.equal(pointInGeometry([5.5, 5.5], multi), true);
    assert.equal(pointInGeometry([3, 3], multi), false);
  });

  test('GeometryCollection is searched; points and lines never contain', () => {
    /** @type {import('../../../site/static/js/types.js').Geometry} */
    const gc = { type: 'GeometryCollection', geometries: [{ type: 'Point', coordinates: [1, 1] }, SQUARE_WITH_HOLE] };
    assert.equal(pointInGeometry([2, 2], gc), true);
    assert.equal(pointInGeometry([1, 1], { type: 'Point', coordinates: [1, 1] }), false);
    assert.equal(pointInGeometry([1, 1], { type: 'LineString', coordinates: [[0, 0], [2, 2]] }), false);
  });

  test('a real case: Seattle is inside a box around Puget Sound and Boise is not', () => {
    /** @type {import('../../../site/static/js/types.js').Geometry} */
    const box = { type: 'Polygon', coordinates: [[[-123.5, 47], [-121.5, 47], [-121.5, 48.5], [-123.5, 48.5], [-123.5, 47]]] };
    assert.equal(pointInGeometry([-122.3321, 47.6062], box), true);
    assert.equal(pointInGeometry([-116.2023, 43.615], box), false);
  });

  test('an empty polygon contains nothing', () => {
    assert.equal(pointInGeometry([0, 0], { type: 'Polygon', coordinates: [] }), false);
  });
});

describe('bboxOf and bboxIntersects', () => {
  test('boxes of each geometry type', () => {
    assert.deepEqual(bboxOf(SQUARE_WITH_HOLE), [0, 0, 10, 10]);
    assert.deepEqual(bboxOf({ type: 'Point', coordinates: [-122.3, 47.6] }), [-122.3, 47.6, -122.3, 47.6]);
    assert.deepEqual(bboxOf({ type: 'LineString', coordinates: [[1, 2], [-3, 4]] }), [-3, 2, 1, 4]);
    assert.deepEqual(bboxOf({ type: 'MultiPolygon', coordinates: [[[[0, 0], [1, 0], [1, 1], [0, 0]]], [[[5, 5], [6, 5], [6, 7], [5, 5]]]] }), [0, 0, 6, 7]);
    assert.deepEqual(bboxOf({ type: 'GeometryCollection', geometries: [{ type: 'Point', coordinates: [9, 9] }, SQUARE_WITH_HOLE] }), [0, 0, 10, 10]);
  });

  test('an empty geometry throws', () => {
    assert.throws(() => bboxOf({ type: 'Polygon', coordinates: [] }), /no coordinates/);
  });

  test('intersection includes touching edges and excludes gaps', () => {
    assert.equal(bboxIntersects([0, 0, 1, 1], [1, 1, 2, 2]), true);
    assert.equal(bboxIntersects([0, 0, 1, 1], [0.5, 0.5, 2, 2]), true);
    assert.equal(bboxIntersects([0, 0, 1, 1], [1.1, 0, 2, 1]), false);
    assert.equal(bboxIntersects([0, 0, 1, 1], [0, 1.1, 1, 2]), false);
    assert.equal(bboxIntersects([0, 0, 10, 10], [4, 4, 5, 5]), true, 'containment');
  });
});

describe('nearest', () => {
  const CITIES = [
    { name: 'Portland', ll: /** @type {[number, number]} */ ([45.5152, -122.6784]) },
    { name: 'Vancouver', ll: /** @type {[number, number]} */ ([49.2827, -123.1207]) },
    { name: 'Boise', ll: /** @type {[number, number]} */ ([43.615, -116.2023]) },
    { name: 'Spokane', ll: /** @type {[number, number]} */ ([47.6588, -117.426]) },
  ];

  test('sorts by distance and limits to n', () => {
    const r = nearest([47.6062, -122.3321], CITIES, (c) => c.ll, 2);
    assert.deepEqual(r.map((x) => x.item.name), ['Vancouver', 'Portland']);
    assert.ok((r[0]?.distanceKm ?? 0) < (r[1]?.distanceKm ?? 0));
  });

  test('n larger than the list returns all; n of zero or below returns none', () => {
    assert.equal(nearest([47, -122], CITIES, (c) => c.ll, 99).length, 4);
    assert.equal(nearest([47, -122], CITIES, (c) => c.ll, 0).length, 0);
    assert.equal(nearest([47, -122], CITIES, (c) => c.ll, -2).length, 0);
  });

  test('ties keep input order, and an empty list is fine', () => {
    const twins = [{ id: 'a', ll: /** @type {[number, number]} */ ([1, 1]) }, { id: 'b', ll: /** @type {[number, number]} */ ([1, 1]) }];
    assert.deepEqual(nearest([0, 0], twins, (t) => t.ll, 2).map((x) => x.item.id), ['a', 'b']);
    assert.deepEqual(nearest([0, 0], [], () => [0, 0], 3), []);
  });
});
