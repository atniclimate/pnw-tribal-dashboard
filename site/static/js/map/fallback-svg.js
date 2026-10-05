// @ts-check
/**
 * No-WebGL outline mode: inline SVG paths from local TopoJSON, no tiles, no third party (blueprint 4.8). DOM module.
 *
 * Only numeric path data and class names are written to the SVG; colors come from classes in map.css,
 * never from `style` attributes or markup strings (the Content Security Policy forbids inline styles).
 *
 * Owner: lane L8.
 */

import { mercator } from './topo.js';

/** @typedef {import('../types.js').FeatureCollection} FeatureCollection */

const SVG_NS = 'http://www.w3.org/2000/svg';
const WIDTH = 800;
const MAX_HEIGHT = 1000;

const WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];
/** @param {number} n @returns {string} numbers up to ten are spelled out in prose */
const spell = (n) => (Number.isInteger(n) && n >= 0 && n <= 10 ? /** @type {string} */ (WORDS[n]) : String(n));

/**
 * @param {any} geometry
 * @param {(c: number[]) => void} visit
 * @returns {void}
 */
function eachCoordinate(geometry, visit) {
  if (!geometry) return;
  const walk = (/** @type {any} */ c) => {
    if (typeof c[0] === 'number') visit(c);
    else for (const x of c) walk(x);
  };
  if (geometry.type === 'GeometryCollection') for (const g of geometry.geometries ?? []) eachCoordinate(g, visit);
  else if (geometry.coordinates) walk(geometry.coordinates);
}

/**
 * @param {FeatureCollection | null | undefined} fc
 * @returns {[number, number, number, number] | null} west, south, east, north
 */
function bboxOfCollection(fc) {
  let w = Infinity; let s = Infinity; let e = -Infinity; let n = -Infinity;
  for (const f of fc?.features ?? []) {
    eachCoordinate(f.geometry, (c) => {
      const lon = /** @type {number} */ (c[0]); const lat = /** @type {number} */ (c[1]);
      if (lon < w) w = lon; if (lon > e) e = lon; if (lat < s) s = lat; if (lat > n) n = lat;
    });
  }
  return Number.isFinite(w) ? [w, s, e, n] : null;
}

/**
 * Builds an SVG path string for a line or polygon geometry, or null when nothing falls inside the view.
 * @param {any} geometry
 * @param {(lon: number, lat: number) => [number, number]} project
 * @returns {string | null}
 */
function pathOf(geometry, project) {
  /** @type {number[][][]} */
  const rings = [];
  /** @type {boolean[]} */
  const closed = [];
  if (!geometry) return null;
  switch (geometry.type) {
    case 'LineString': rings.push(geometry.coordinates); closed.push(false); break;
    case 'MultiLineString': for (const l of geometry.coordinates) { rings.push(l); closed.push(false); } break;
    case 'Polygon': for (const r of geometry.coordinates) { rings.push(r); closed.push(true); } break;
    case 'MultiPolygon': for (const p of geometry.coordinates) for (const r of p) { rings.push(r); closed.push(true); } break;
    case 'GeometryCollection': {
      const parts = (geometry.geometries ?? []).map((/** @type {any} */ g) => pathOf(g, project)).filter(Boolean);
      return parts.length ? parts.join(' ') : null;
    }
    default: return null;
  }
  /** @type {string[]} */
  const out = [];
  rings.forEach((ring, i) => {
    if (!Array.isArray(ring) || ring.length < 2) return;
    const pts = ring.map((c) => project(/** @type {number} */ (c[0]), /** @type {number} */ (c[1])));
    out.push(`M${pts.map(([x, y]) => `${x.toFixed(1)} ${y.toFixed(1)}`).join('L')}${closed[i] ? 'Z' : ''}`);
  });
  return out.length ? out.join(' ') : null;
}

/**
 * @param {string} tag
 * @param {Record<string, string>} attrs
 * @returns {SVGElement}
 */
function el(tag, attrs) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  return node;
}

/**
 * @param {FeatureCollection | null | undefined} alerts
 * @returns {number}
 */
function alertAreaCount(alerts) {
  return (alerts?.features ?? []).length;
}

/**
 * role="img" with a text summary; colors from map.css classes only.
 * Outlines features carry `properties.layer` ('states', 'counties', 'province'). Nation features are land
 * polygons plus an optional Point (the headquarters). Alert features are storm-based polygons with
 * `properties.band`.
 * @param {HTMLElement} frame
 * @param {{ outlines: FeatureCollection, nation?: FeatureCollection | null, alerts?: FeatureCollection | null, label: string }} opts
 * @returns {{ svg: SVGSVGElement, update(opts: { nation?: FeatureCollection | null, alerts?: FeatureCollection | null }): void, destroy(): void }}
 */
export function renderOutlineMap(frame, opts) {
  /** @type {FeatureCollection | null} */
  let nation = opts.nation ?? null;
  /** @type {FeatureCollection | null} */
  let alerts = opts.alerts ?? null;
  const footprint = bboxOfCollection(opts.outlines) ?? [-125, 41, -110, 54];

  const svg = /** @type {SVGSVGElement} */ (el('svg', { class: 'map-outline', role: 'img', focusable: 'false', preserveAspectRatio: 'xMidYMid meet' }));
  const title = el('title', {});
  svg.append(title);
  const layerGround = el('rect', { class: 'map-outline__ground', x: '0', y: '0', width: String(WIDTH), height: '100' });
  svg.append(layerGround);
  const gStates = el('g', { class: 'map-outline__states' });
  const gCounties = el('g', { class: 'map-outline__counties' });
  const gProvince = el('g', { class: 'map-outline__province' });
  const gNation = el('g', { class: 'map-outline__nation-layer' });
  const gAlerts = el('g', { class: 'map-outline__alerts' });
  svg.append(gStates, gCounties, gProvince, gNation, gAlerts);
  frame.replaceChildren(svg);

  /** @returns {[number, number, number, number]} */
  function fitBox() {
    const polygons = { type: 'FeatureCollection', features: (nation?.features ?? []).filter((f) => f.geometry && f.geometry.type !== 'Point') };
    const box = bboxOfCollection(/** @type {FeatureCollection} */ (polygons));
    if (!box) return footprint;
    const padX = Math.max((box[2] - box[0]) * 0.4, 0.05);
    const padY = Math.max((box[3] - box[1]) * 0.4, 0.05);
    return [box[0] - padX, box[1] - padY, box[2] + padX, box[3] + padY];
  }

  function draw() {
    const [w, s, e, n] = fitBox();
    const [x0, y1] = mercator(w, s);
    const [x1, y0] = mercator(e, n);
    const spanX = Math.max(x1 - x0, 1e-6);
    const spanY = Math.max(y1 - y0, 1e-6);
    const scale = WIDTH / spanX;
    const height = Math.min(MAX_HEIGHT, Math.max(120, Math.round(spanY * scale)));
    const k = Math.min(scale, height / spanY);
    const offX = (WIDTH - spanX * k) / 2;
    const offY = (height - spanY * k) / 2;
    /** @type {(lon: number, lat: number) => [number, number]} */
    const project = (lon, lat) => { const [mx, my] = mercator(lon, lat); return [offX + (mx - x0) * k, offY + (my - y0) * k]; };
    svg.setAttribute('viewBox', `0 0 ${WIDTH} ${height}`);
    layerGround.setAttribute('height', String(height));
    for (const g of [gStates, gCounties, gProvince, gNation, gAlerts]) g.replaceChildren();
    for (const f of opts.outlines.features) {
      const layer = String(/** @type {any} */ (f.properties)?.layer ?? 'states');
      const d = pathOf(f.geometry, project);
      if (!d) continue;
      const target = layer === 'counties' ? gCounties : layer === 'province' ? gProvince : gStates;
      target.append(el('path', { class: `map-outline__${layer === 'counties' ? 'county' : layer === 'province' ? 'province-edge' : 'state'}`, d }));
    }
    for (const f of nation?.features ?? []) {
      if (f.geometry?.type === 'Point') {
        const [x, y] = project(/** @type {number} */ (f.geometry.coordinates[0]), /** @type {number} */ (f.geometry.coordinates[1]));
        gNation.append(el('circle', { class: 'map-outline__hq', cx: x.toFixed(1), cy: y.toFixed(1), r: '6' }));
        continue;
      }
      const d = pathOf(f.geometry, project);
      if (d) gNation.append(el('path', { class: 'map-outline__land-area', d }));
    }
    for (const f of alerts?.features ?? []) {
      const d = pathOf(f.geometry, project);
      if (!d) continue;
      const props = /** @type {any} */ (f.properties) ?? {};
      const band = ['extreme', 'severe', 'moderate', 'minor', 'unstated'].includes(props.band) ? props.band : 'unstated';
      const designation = ['emergency', 'warning', 'watch', 'advisory', 'statement', 'other'].includes(props.designation) ? props.designation : 'other';
      if (band === 'extreme') gAlerts.append(el('path', { class: 'map-outline__alert-keyline', d }));
      gAlerts.append(el('path', { class: `map-outline__alert map-outline__alert--${band} map-outline__alert--${designation}`, d }));
    }
    const count = alertAreaCount(alerts);
    const text = `${opts.label}. Outline map of Cascadia with ${spell(count)} alert ${count === 1 ? 'area' : 'areas'}; details are in the alert list.`;
    svg.setAttribute('aria-label', text);
    title.textContent = text;
  }
  draw();

  return {
    svg,
    update(next) {
      if ('nation' in next) nation = next.nation ?? null;
      if ('alerts' in next) alerts = next.alerts ?? null;
      draw();
    },
    destroy() {
      svg.remove();
    },
  };
}
