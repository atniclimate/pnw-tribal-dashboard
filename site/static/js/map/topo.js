// @ts-check
/**
 * Map data shaping: TopoJSON decoding with the vendored topojson-client (blueprint 4.2), Web Mercator and
 * map extents (4.1), geometry centers, and the storm-polygon and band helpers both modes share. DOM-free.
 *
 * Owner: lane L8. The decoder is passed in (loader.loadTopojson in the browser, the npm package in Node
 * tests), so this module imports nothing. Nothing is cached here: the adapter keeps no second copy of
 * decoded data.
 */

/** @typedef {import('../types.js').FeatureCollection} FeatureCollection */
/** @typedef {import('../types.js').DashboardAlert} DashboardAlert */

/** The tile-free fallback geometry both modes draw (blueprint 4.2). */
export const OUTLINES_FILE = 'data/geo/outlines.topo.json';

/** Geographic extent, ignoring malformed coordinate pairs.
 * @param {unknown} geometry
 * @returns {[number, number, number, number] | null}
 */
export function geometryBounds(geometry) {
  let west = Infinity; let south = Infinity; let east = -Infinity; let north = -Infinity;
  const walk = (/** @type {unknown} */ value) => {
    if (!Array.isArray(value)) return;
    if (typeof value[0] === 'number') {
      const [lon, lat] = value;
      if (typeof lat !== 'number' || !Number.isFinite(lon) || !Number.isFinite(lat) || Math.abs(lon) > 180 || Math.abs(lat) > 90) return;
      west = Math.min(west, lon); east = Math.max(east, lon);
      south = Math.min(south, lat); north = Math.max(north, lat);
    } else for (const child of value) walk(child);
  };
  if (!geometry || typeof geometry !== 'object') return null;
  const g = /** @type {{type?: string, coordinates?: unknown, geometries?: unknown[]}} */ (geometry);
  if (g.type === 'GeometryCollection') {
    for (const child of g.geometries ?? []) {
      const box = geometryBounds(child);
      if (box) { walk([box[0], box[1]]); walk([box[2], box[3]]); }
    }
  } else walk(g.coordinates);
  return Number.isFinite(west) ? [west, south, east, north] : null;
}

/**
 * Decodes one named object of a topology into a GeoJSON FeatureCollection. A geometry `id` that the file
 * carries is copied into `properties.id` when the properties lack one, so `promoteId` and the feature list
 * can use it.
 * @param {unknown} topology
 * @param {string} objectName
 * @param {typeof import('topojson-client')} topojson
 * @returns {FeatureCollection}
 */
export function decodeTopo(topology, objectName, topojson) {
  const topo = /** @type {{ objects?: Record<string, unknown> } | null} */ (topology);
  if (!topo || typeof topo !== 'object' || !topo.objects || !(objectName in topo.objects)) {
    throw new Error(`TopoJSON object "${objectName}" is missing`);
  }
  const decoded = /** @type {any} */ (topojson.feature(/** @type {any} */ (topology), /** @type {any} */ (topo.objects[objectName])));
  /** @type {any[]} */
  const features = decoded.type === 'FeatureCollection' ? decoded.features : [decoded];
  for (const f of features) {
    f.properties ??= {};
    if (f.id !== undefined && f.id !== null && f.properties.id === undefined) f.properties.id = f.id;
  }
  return { type: 'FeatureCollection', features };
}

/**
 * Every object of outlines.topo.json (states, counties, province) as one collection; each feature's
 * `properties.layer` names its object, which is how both modes style them.
 * @param {unknown} topology
 * @param {typeof import('topojson-client')} topojson
 * @returns {FeatureCollection}
 */
export function decodeOutlines(topology, topojson) {
  const topo = /** @type {{ objects?: Record<string, unknown> } | null} */ (topology);
  if (!topo || typeof topo !== 'object' || !topo.objects) throw new Error('Outlines file has no objects');
  /** @type {any[]} */
  const features = [];
  for (const name of Object.keys(topo.objects)) {
    for (const f of decodeTopo(topology, name, topojson).features) {
      /** @type {any} */ (f).properties.layer = name;
      features.push(f);
    }
  }
  return { type: 'FeatureCollection', features };
}

// ---- Extents (blueprint 4.1 maxBounds) ----------------------------------------------------------------
// MapLibre's `maxBounds` keeps the view inside the box in both directions, which would stop a wide frame
// from ever showing the footprint's full north-south extent. `boundsForViewport` widens the box, around the
// same center, until its shape matches the frame, so the limit is still "footprint plus ten percent of
// content" and the whole footprint always fits.

const MAX_LAT = 85.05112878;

/**
 * Web Mercator in the unit square (x east, y south), latitude clamped to the projection's limit.
 * @param {number} lon
 * @param {number} lat
 * @returns {[number, number]}
 */
export function mercator(lon, lat) {
  const phi = (Math.max(-MAX_LAT, Math.min(MAX_LAT, lat)) * Math.PI) / 180;
  return [(lon + 180) / 360, 0.5 - Math.log(Math.tan(Math.PI / 4 + phi / 2)) / (2 * Math.PI)];
}

/**
 * @param {number} x
 * @param {number} y
 * @returns {[number, number]} lon, lat
 */
export function unmercator(x, y) {
  return [x * 360 - 180, (Math.atan(Math.sinh(Math.PI * (1 - 2 * y))) * 180) / Math.PI];
}

/**
 * The bounding box plus ten percent on each side.
 * @param {[number, number, number, number]} b west, south, east, north
 * @returns {[number, number, number, number]}
 */
export function paddedBounds(b) {
  const dx = (b[2] - b[0]) * 0.1;
  const dy = (b[3] - b[1]) * 0.1;
  return [Math.max(-180, b[0] - dx), Math.max(-MAX_LAT, b[1] - dy), Math.min(180, b[2] + dx), Math.min(MAX_LAT, b[3] + dy)];
}

/**
 * Widens `box` (same center, in Mercator space) to the frame's aspect ratio, never shrinking it.
 * @param {[number, number, number, number]} box west, south, east, north
 * @param {number} width frame width in pixels
 * @param {number} height frame height in pixels
 * @returns {[number, number, number, number]}
 */
export function boundsForViewport(box, width, height) {
  if (!(width > 0) || !(height > 0)) return box;
  const [x0, y1] = mercator(box[0], box[1]);
  const [x1, y0] = mercator(box[2], box[3]);
  let bw = x1 - x0;
  let bh = y1 - y0;
  if (!(bw > 0) || !(bh > 0)) return box;
  const aspect = width / height;
  if (bw / bh < aspect) bw = bh * aspect; else bh = bw / aspect;
  const cx = (x0 + x1) / 2;
  const cy = (y0 + y1) / 2;
  const [west, north] = unmercator(Math.max(0, cx - bw / 2), Math.max(0, cy - bh / 2));
  const [east, south] = unmercator(Math.min(1, cx + bw / 2), Math.min(1, cy + bh / 2));
  return [Math.max(-180, west), Math.max(-MAX_LAT, south), Math.min(180, east), Math.min(MAX_LAT, north)];
}

// ---- Shapes both modes share ------------------------------------------------------------------------------

/** Severity bands, most severe first. */
export const BANDS = Object.freeze(['extreme', 'severe', 'moderate', 'minor', 'unstated']);

/**
 * Rank of a band, lower is more severe.
 * @param {string} band
 * @returns {number}
 */
export function bandRank(band) {
  const i = BANDS.indexOf(band);
  return i < 0 ? BANDS.length - 1 : i;
}

/** @returns {FeatureCollection} */
export function emptyCollection() {
  return { type: 'FeatureCollection', features: [] };
}

/**
 * Center of a geometry's bounding box as [lng, lat], or null when it has no coordinates.
 * @param {any} geometry
 * @returns {[number, number] | null}
 */
export function centerOf(geometry) {
  let w = Infinity; let s = Infinity; let e = -Infinity; let n = -Infinity;
  const walk = (/** @type {any} */ c) => {
    if (typeof c?.[0] === 'number') {
      if (c[0] < w) w = c[0]; if (c[0] > e) e = c[0]; if (c[1] < s) s = c[1]; if (c[1] > n) n = c[1];
    } else if (Array.isArray(c)) for (const x of c) walk(x);
  };
  if (geometry?.type === 'GeometryCollection') for (const g of geometry.geometries ?? []) walk(g.coordinates);
  else walk(geometry?.coordinates);
  return Number.isFinite(w) ? [(w + e) / 2, (s + n) / 2] : null;
}

/**
 * The accessible name of an alert feature; the same text the alert list shows for it.
 * @param {DashboardAlert} alert
 * @param {boolean} zoneBasis
 * @returns {string}
 */
export function alertName(alert, zoneBasis) {
  const area = alert.areaDesc ? `, ${alert.areaDesc.length > 120 ? `${alert.areaDesc.slice(0, 117)}...` : alert.areaDesc}` : '';
  return `${alert.event}${area}${zoneBasis ? ' (whole forecast zone)' : ''}`;
}

const POLYGONS = new Set(['Polygon', 'MultiPolygon']);

/**
 * @param {DashboardAlert} a
 * @returns {boolean} true when the alert carries its own storm-based polygon
 */
export function hasOwnPolygon(a) {
  return Boolean(a.geometry && POLYGONS.has(a.geometry.type) && a.provenance?.coverage?.geometryBasis !== 'zone');
}

/**
 * Storm-based alert polygons as GeoJSON, for the alerts layer and outline mode. Zone-basis alerts are not
 * included; layers/zones.js draws those dashed.
 * @param {DashboardAlert[]} alerts
 * @returns {FeatureCollection}
 */
export function alertPolygons(alerts) {
  /** @type {any[]} */
  const features = [];
  for (const a of alerts) {
    if (!hasOwnPolygon(a)) continue;
    features.push({
      type: 'Feature',
      geometry: a.geometry,
      properties: { alertId: a.alertId, band: a.band, designation: a.designation, event: a.event, name: alertName(a, false) },
    });
  }
  return { type: 'FeatureCollection', features };
}
