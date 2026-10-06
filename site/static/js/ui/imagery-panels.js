// @ts-check
/**
 * Imagery panels of the forecasts page: WPC, GOES, RIDGE, the link-only panels, and the lazy map frame
 * (blueprint 7.3, 8.3). DOM module. Nothing here requests an image or a map until a tap, except the images the
 * viewer is allowed to load on its own (policy auto, 150 KB or less, low-data mode off). CW3E and MIMIC-TPW2
 * are link-only (decision Q11, 10/05/2026): no image request goes to either provider.
 */
import { clear, h } from '../core/dom.js';
import { onStateChange } from '../core/url-state.js';
import { createMediaViewer } from './media-viewer.js';
import { GOES_PRODUCTS, goesProduct, goesProductIds } from '../forecast/goes.js';
import { sizeLabel } from '../forecast/imagery.js';
import { RIDGE_MOSAIC, ridgeProductIds } from '../forecast/radar.js';
import { WPC_GROUP_TITLES, WPC_LABELS, wpcLabel, wpcProducts } from '../forecast/wpc.js';

/** @typedef {import('../types.js').ImageryProduct} ImageryProduct */
/** @typedef {{ catalog: Map<string, ImageryProduct>, stamps: Map<string, { lastModified: string | null }>, timeZone: string | undefined, lowData: boolean }} ImageryCtx */

/** Beyond this distance a single radar's reflectivity does not reach the headquarters. */
export const RADAR_USEFUL_KM = 250;

/**
 * @param {string} label
 * @param {boolean} pressed
 * @param {() => void} onClick
 * @returns {HTMLElement}
 */
function chip(label, pressed, onClick) {
  const b = h('button', { type: 'button', class: 'filter-chip', 'aria-pressed': String(pressed) }, label);
  b.addEventListener('click', onClick);
  return b;
}

/**
 * @param {HTMLElement} row
 * @param {HTMLElement} active
 */
function press(row, active) {
  for (const b of row.querySelectorAll('button')) b.setAttribute('aria-pressed', String(b === active));
}

/**
 * @param {ImageryCtx} ctx
 * @param {string} id
 * @returns {string | null}
 */
const stampOf = (ctx, id) => ctx.stamps.get(id)?.lastModified ?? null;

/**
 * @param {HTMLElement} body
 * @param {ImageryProduct[]} products
 * @param {ImageryCtx} ctx
 * @param {{ selected?: string, onSelect?: (id: string) => void, getSelected?: () => string }} [opts]
 * @returns {{ destroy(): void }}
 */
export function renderWpc(body, products, ctx, opts = {}) {
  clear(body);
  const ordered = wpcProducts(products);
  const viewerEl = h('div', { 'data-viewer': 'wpc' });
  const first = ordered.find((p) => p.id === opts.selected) ?? ordered[0];
  if (!first) { body.append(h('p', { class: 'panel-unavailable' }, 'No Weather Prediction Center images are listed.')); return { destroy() {} }; }
  const credit = 'Source: NOAA National Weather Service, Weather Prediction Center.';
  const viewer = createMediaViewer(viewerEl, { product: first, stamp: stampOf(ctx, first.id), timeZone: ctx.timeZone ?? '', lowData: ctx.lowData, label: wpcLabel(first.id) ?? first.id, credit, catalog: ctx.catalog, stamps: ctx.stamps });
  let selected = first.id;
  /** @type {Map<string, HTMLElement>} */
  const buttons = new Map();
  /** @param {string} id */
  function select(id) {
    const p = ordered.find((item) => item.id === id) ?? first;
    if (!p || selected === p.id) return;
    selected = p.id;
    for (const [key, button] of buttons) button.setAttribute('aria-pressed', String(key === selected));
    viewer.setProduct(p, stampOf(ctx, p.id), { label: wpcLabel(p.id) ?? p.id });
  }
  for (const group of /** @type {const} */ (['qpf', 'ero'])) {
    const row = h('div', { class: 'filter-chips', role: 'group', 'aria-label': WPC_GROUP_TITLES[group] });
    for (const spec of WPC_LABELS.filter((s) => s.group === group)) {
      const p = ordered.find((x) => x.id === spec.id);
      if (!p) continue;
      const b = chip(spec.label, p.id === first.id, () => { select(p.id); opts.onSelect?.(p.id); });
      buttons.set(p.id, b);
      row.append(b);
    }
    body.append(h('h3', {}, WPC_GROUP_TITLES[group]), row);
  }
  body.append(viewerEl);
  const stop = onStateChange(() => { if (opts.getSelected) select(opts.getSelected()); });
  return { destroy: () => { stop(); viewer.destroy(); } };
}

/**
 * @param {HTMLElement} body
 * @param {ImageryCtx} ctx
 * @param {{ selected: string, onSelect: (key: string) => void, getSelected?: () => string }} opts
 * @returns {{ destroy(): void }}
 */
export function renderGoes(body, ctx, opts) {
  clear(body);
  const viewerEl = h('div', { 'data-viewer': 'goes' });
  const note = h('p', { class: 'panel-note', 'data-goes-note': '' });
  /** @param {string} key */
  const productFor = (key) => {
    const ids = goesProductIds(key);
    return ctx.catalog.get(ids.still) ?? null;
  };
  const start = productFor(opts.selected) ?? productFor('geocolor');
  const startKey = productFor(opts.selected) ? opts.selected : 'geocolor';
  if (!start) { body.append(h('p', { class: 'panel-unavailable' }, 'No satellite images are listed.')); return { destroy() {} }; }
  const credit = 'Source: NOAA NESDIS Center for Satellite Applications and Research, GOES-18 (GOES-West), Pacific Northwest sector.';
  /** @param {string} key */
  const labelFor = (key) => `GOES-18 ${goesProduct(key).label}, Pacific Northwest`;
  /** @param {string} key */
  const setNote = (key) => {
    clear(note);
    if (!goesProduct(key).animated) note.append('This band offers still images only; NOAA publishes no animation for it.');
    for (const el of document.querySelectorAll('[data-airmass-note]')) /** @type {HTMLElement} */ (el).hidden = key !== 'airmass';
  };
  const viewer = createMediaViewer(viewerEl, { product: start, stamp: stampOf(ctx, start.id), timeZone: ctx.timeZone ?? '', lowData: ctx.lowData, label: labelFor(startKey), credit, catalog: ctx.catalog, stamps: ctx.stamps });
  setNote(startKey);
  const row = h('div', { class: 'filter-chips', role: 'group', 'aria-label': 'Satellite product' });
  let active = startKey;
  /** @type {Map<string, HTMLElement>} */
  const buttons = new Map();
  /** @param {string} key */
  function select(key) {
    const p = productFor(key); const button = buttons.get(key);
    if (!p || !button || active === key) return;
    active = key; press(row, button);
    viewer.setProduct(p, stampOf(ctx, p.id), { label: labelFor(key) }); setNote(key);
  }
  for (const g of GOES_PRODUCTS) {
    const p = productFor(g.key);
    if (!p) continue;
    const b = chip(g.label, g.key === startKey, () => {
      select(g.key);
      opts.onSelect(g.key);
    });
    buttons.set(g.key, b);
    row.append(b);
  }
  body.append(row, viewerEl, note);
  const stop = onStateChange(() => { if (opts.getSelected) select(opts.getSelected()); });
  return { destroy: () => { stop(); viewer.destroy(); } };
}

/**
 * @param {HTMLElement} body
 * @param {{ site: { id: string, distanceKm: number }, nationName: string }} d
 * @param {ImageryCtx} ctx
 * @returns {{ destroy(): void }}
 */
export function renderRidge(body, d, ctx) {
  clear(body);
  const ids = ridgeProductIds(d.site.id);
  const still = ctx.catalog.get(ids.still);
  const mosaic = ctx.catalog.get(ridgeProductIds(RIDGE_MOSAIC).still);
  /** @type {{ destroy(): void }[]} */
  const viewers = [];
  const credit = 'Source: National Weather Service RIDGE radar images.';
  body.append(h('p', { class: 'panel-note' }, `Nearest radar: ${d.site.id}, about ${Math.round(d.site.distanceKm)} km from ${d.nationName} headquarters.`));
  if (d.site.distanceKm > RADAR_USEFUL_KM) {
    body.append(h('p', { class: 'panel-note', 'data-radar-far': '' }, 'This is the nearest National Weather Service radar listed, and it is too far away to show weather at the headquarters. Use the radar map above, which includes Environment and Climate Change Canada radar where it covers British Columbia.'));
  }
  if (still) {
    const el = h('div', { 'data-viewer': 'ridge' });
    viewers.push(createMediaViewer(el, { product: still, stamp: stampOf(ctx, still.id), timeZone: ctx.timeZone ?? '', lowData: ctx.lowData, label: `${d.site.id} radar`, credit, catalog: ctx.catalog, stamps: ctx.stamps }));
    body.append(el);
  } else {
    body.append(h('p', { class: 'panel-unavailable' }, `No radar image is listed for ${d.site.id}.`));
  }
  if (mosaic) {
    const el = h('div', { 'data-viewer': 'ridge-mosaic' });
    viewers.push(createMediaViewer(el, { product: mosaic, stamp: stampOf(ctx, mosaic.id), timeZone: ctx.timeZone ?? '', lowData: ctx.lowData, label: 'Pacific Northwest regional mosaic', credit, forceTap: true, catalog: ctx.catalog, stamps: ctx.stamps }));
    body.append(h('h3', {}, 'Regional Mosaic'), el);
  }
  return { destroy: () => viewers.forEach((v) => v.destroy()) };
}

/**
 * A link-only panel for a source whose terms do not allow embedding (decision Q11, 10/05/2026): a note that
 * says why, and a plain text link to the provider's page. No image is requested.
 * @param {HTMLElement} body
 * @param {{ id: string, href: string, label: string, note: string }} d
 * @returns {{ destroy(): void }}
 */
export function renderLinkOut(body, d) {
  clear(body);
  body.append(h('p', { class: 'panel-note', 'data-link-out': d.id }, d.note, ' ',
    h('a', { class: 'btn btn--link', href: d.href, target: '_blank', rel: 'noopener noreferrer' }, d.label)));
  return { destroy: () => { clear(body); } };
}

/**
 * The lazy map frame: a labeled button first, the map module (a dynamic import) only after the tap. The
 * sovereignty statement is always on the panel, with or without the map.
 * @param {HTMLElement} body
 * @param {{ label: string, layers: string[], sourceIds: string[], hq: [number, number] | null, nationId: string | null, bytes: number, auto?: boolean, importMap?: () => Promise<any> }} opts
 * @returns {{ destroy(): void }}
 */
export function mountMapFrame(body, opts) {
  clear(body);
  const frame = h('div', { class: 'map-frame', 'data-map-frame': '' });
  const viewport = h('div', { class: 'map-frame__viewport' });
  const status = h('p', { class: 'map-frame__status', role: 'status' });
  const request = h('button', { type: 'button', class: 'btn btn--secondary map-frame__request', 'data-action': 'show-map' }, `Show Map (about ${sizeLabel(opts.bytes)})`);
  const note = h('p', { class: 'sovereignty-note', 'data-fallback-note': '' }, h('strong', {}, 'Representation, not jurisdiction.'), ' Boundary lines shown here come from public federal sources; they are not a Tribal Nation\'s own statement of its land or authority.');
  frame.append(viewport, request, status);
  body.append(frame, note);
  /** @type {{ destroy(): void } | null} */
  let map = null;
  let destroyed = false;
  async function start() {
    /** @type {HTMLButtonElement} */ (request).disabled = true;
    status.textContent = `Loading map (about ${sizeLabel(opts.bytes)})`;
    try {
      const mod = await (opts.importMap ? opts.importMap() : import('../map/create-map.js'));
      if (destroyed) return;
      map = await mod.createMap(viewport, {
        sovereignty: { sourceIds: opts.sourceIds }, label: opts.label, layers: opts.layers, mode: 'auto', controls: true,
        ...(opts.hq ? { view: { lat: opts.hq[0], lon: opts.hq[1], zoom: 7 } } : {}),
      });
      if (destroyed) { map?.destroy(); return; }
      /** @type {import('../types.js').CthdMap} */ (map).setLayer('radar', true);
      if (opts.nationId) /** @type {any} */ (map).focusNation?.(opts.nationId);
      request.hidden = true;
      status.textContent = '';
      // The map mounts its own sovereignty note below its frame; remove the placeholder so only one remains.
      if (body.querySelectorAll('.sovereignty-note').length > 1) note.remove();
    } catch {
      /** @type {HTMLButtonElement} */ (request).disabled = false;
      status.textContent = 'The map could not be loaded. Radar images for the nearest station are in the panel below.';
    }
  }
  request.addEventListener('click', () => { void start(); });
  if (opts.auto) void start();
  return { destroy() { destroyed = true; map?.destroy(); } };
}
