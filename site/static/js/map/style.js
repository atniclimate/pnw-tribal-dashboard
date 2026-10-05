// @ts-check
/**
 * Style built in code: version 8, background layer, no glyphs, no sprite, colors read from tokens (blueprint 4.1, 4.7). DOM-free.
 *
 * Also the shared vocabulary of the layers (blueprint 4.4): draw order, token-driven color expressions,
 * status snapshots, and the extended layer context. Layers never write a color value; every color is read
 * from tokens.css through `ctx.token`.
 *
 * Owner: lane L8.
 */

/** @typedef {import('../types.js').LayerContext} LayerContext */
/** @typedef {import('../types.js').MapLayer} MapLayer */
/** @typedef {import('../types.js').FeatureItem} FeatureItem */
/** @typedef {import('../types.js').FeatureCollection} FeatureCollection */
/** @typedef {import('../types.js').StatusSnapshot} StatusSnapshot */
/** @typedef {import('../types.js').DashboardAlert} DashboardAlert */

/**
 * What create-map hands to each layer: the contract context plus the shared decoder, the shared outlines,
 * a selection callback, and the sovereignty dataset hook.
 * @typedef {LayerContext & {
 *   topojson: typeof import('topojson-client'),
 *   outlines: FeatureCollection | null,
 *   select: (kind: string, id: string) => void,
 *   setDatasets: (datasets: { name: string, vintage: string }[], extra?: string) => void,
 *   zoomNow: () => number,
 *   onZoom: (fn: () => void) => () => void,
 * }} MapContext
 */

/**
 * A layer as create-map drives it: the contract plus optional extras.
 * @typedef {MapLayer & {
 *   highlight?: (id: string | null) => void,
 *   lookup?: (id: string) => { name: string, lngLat: [number, number], hasBoundary: boolean } | null,
 *   focus?: (record: any) => Promise<void> | void,
 *   prefetch?: (io: { fetchLocal: LayerContext['fetchLocal'], signal: AbortSignal }) => void,
 * }} MapLayerX
 */

/**
 * @param {{ token: (name: string) => string, lowData: boolean }} opts
 * @returns {import('maplibre-gl').StyleSpecification}
 */
export function buildStyle(opts) {
  const ground = opts.token('--ground');
  if (!ground) throw new Error('buildStyle needs the --ground token');
  return {
    version: 8,
    name: 'cthd-ground',
    // No `glyphs` and no `sprite` on purpose (blueprint 4.7): every visible label is HTML.
    sources: {},
    layers: [{ id: 'background', type: 'background', paint: { 'background-color': ground } }],
  };
}

/** Bottom to top (blueprint 4.4). Radar sits below every vector layer. */
export const ORDER = Object.freeze(['basemap', 'radar', 'outlines', 'boundaries', 'zones', 'alerts', 'bc', 'gauges', 'hq', 'selection']);

/**
 * Adds a style layer in draw order: the new layer goes below the first existing layer whose group ranks
 * higher. Layer ids are `<group>:<name>`.
 * @param {import('maplibre-gl').Map} map
 * @param {string} group one of ORDER
 * @param {Record<string, any>} spec a layer spec whose `id` is the name inside the group
 * @returns {string} the full layer id
 */
export function addOrdered(map, group, spec) {
  const rank = ORDER.indexOf(group);
  const id = `${group}:${spec.id}`;
  const order = map.getLayersOrder();
  const before = order.find((existing) => {
    const g = existing.split(':')[0] ?? '';
    return ORDER.indexOf(g) > rank;
  });
  map.addLayer(/** @type {any} */ ({ ...spec, id }), before);
  return id;
}

/**
 * Removes the layers of a group and the listed sources, ignoring ones that are already gone.
 * @param {import('maplibre-gl').Map | null} map
 * @param {string[]} layerIds
 * @param {string[]} sourceIds
 * @returns {void}
 */
export function removeAll(map, layerIds, sourceIds) {
  if (!map) return;
  try {
    for (const id of layerIds) if (map.getLayer(id)) map.removeLayer(id);
    for (const id of sourceIds) if (map.getSource(id)) map.removeSource(id);
  } catch { /* the map is already being torn down */ }
}

/**
 * Sets one visibility value on every listed layer that exists.
 * @param {import('maplibre-gl').Map | null} map
 * @param {string[]} layerIds
 * @param {boolean} on
 * @returns {void}
 */
export function setLayersVisible(map, layerIds, on) {
  if (!map) return;
  for (const id of layerIds) if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none');
}

/**
 * A `match` expression from the band property to the band's background token.
 * @param {(name: string) => string} token
 * @returns {any[]}
 */
export function bandColor(token) {
  return ['match', ['get', 'band'],
    'extreme', token('--band-extreme-bg'),
    'severe', token('--band-severe-bg'),
    'moderate', token('--band-moderate-bg'),
    'minor', token('--band-minor-bg'),
    token('--band-unstated-bg')];
}

/**
 * Status snapshot for a layer or sub-state the map itself reports (not a data panel).
 * @param {import('../types.js').StatusState} state
 * @param {string} detail
 * @param {string[]} sourceIds
 * @param {string | null} [asOf]
 * @returns {StatusSnapshot}
 */
export function layerStatus(state, detail, sourceIds, asOf = null) {
  return {
    state,
    asOf,
    detail,
    asOfBasis: asOf ? 'valid' : null,
    sourceIds,
    origin: 'direct',
    completeness: state === 'live' ? 'complete' : 'partial',
    checkedAt: new Date().toISOString(),
  };
}
