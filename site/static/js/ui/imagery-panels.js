// @ts-check
/**
 * Imagery panels of the forecasts page: WPC, CW3E, MIMIC-TPW2, GOES, RIDGE, and the lazy map frame
 * (blueprint 7.3, 8.3). DOM module. Nothing here requests an image or a map until a tap, except the images the
 * viewer is allowed to load on its own (policy auto, 150 KB or less, low-data mode off).
 */
import { clear, h } from '../core/dom.js';
import { findSource, source } from '../core/sources.js';
import { formatAsOf } from '../core/time.js';
import { createMediaViewer } from './media-viewer.js';
import { cw3eUrl, cycleDate, manifestItem, modelRunLabel, probeCycleInBrowser, FORECAST_HOURS } from '../forecast/cw3e.js';
import { GOES_PRODUCTS, goesProduct, goesProductIds } from '../forecast/goes.js';
import { imageDims, sizeLabel } from '../forecast/imagery.js';
import { RIDGE_MOSAIC, ridgeProductIds } from '../forecast/radar.js';
import { WPC_GROUP_TITLES, WPC_LABELS, wpcLabel, wpcProducts } from '../forecast/wpc.js';

/** @typedef {import('../types.js').ImageryProduct} ImageryProduct */
/** @typedef {{ catalog: Map<string, ImageryProduct>, stamps: Map<string, { lastModified: string | null }>, timeZone: string | undefined, lowData: boolean }} ImageryCtx */

/** Beyond this distance a single radar's reflectivity does not reach the headquarters. */
export const RADAR_USEFUL_KM = 250;

/** Shown wherever a source's hotlinking terms are still under review (decision Q11). */
export const PENDING_TERMS_NOTE = 'Hotlinking terms for this source are under review (maintainer decision Q11), so its images load only when you tap, and each one links to its source.';

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
 * @returns {{ destroy(): void }}
 */
export function renderWpc(body, products, ctx) {
  clear(body);
  const ordered = wpcProducts(products);
  const viewerEl = h('div', { 'data-viewer': 'wpc' });
  const first = ordered[0];
  if (!first) { body.append(h('p', { class: 'panel-unavailable' }, 'No Weather Prediction Center images are listed.')); return { destroy() {} }; }
  const credit = 'Source: NOAA National Weather Service, Weather Prediction Center.';
  const viewer = createMediaViewer(viewerEl, { product: first, stamp: stampOf(ctx, first.id), timeZone: ctx.timeZone ?? '', lowData: ctx.lowData, label: wpcLabel(first.id) ?? first.id, credit, catalog: ctx.catalog, stamps: ctx.stamps });
  for (const group of /** @type {const} */ (['qpf', 'ero'])) {
    const row = h('div', { class: 'filter-chips', role: 'group', 'aria-label': WPC_GROUP_TITLES[group] });
    for (const spec of WPC_LABELS.filter((s) => s.group === group)) {
      const p = ordered.find((x) => x.id === spec.id);
      if (!p) continue;
      const b = chip(spec.label, p.id === first.id, () => { press(/** @type {HTMLElement} */ (b.parentElement), b); viewer.setProduct(p, stampOf(ctx, p.id), { label: wpcLabel(p.id) ?? p.id }); });
      row.append(b);
    }
    body.append(h('h3', {}, WPC_GROUP_TITLES[group]), row);
  }
  body.append(viewerEl);
  return { destroy: () => viewer.destroy() };
}

/**
 * @param {HTMLElement} body
 * @param {ImageryCtx} ctx
 * @param {{ selected: string, onSelect: (key: string) => void }} opts
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
  for (const g of GOES_PRODUCTS) {
    const p = productFor(g.key);
    if (!p) continue;
    const b = chip(g.label, g.key === startKey, () => {
      press(row, b);
      viewer.setProduct(p, stampOf(ctx, p.id), { label: labelFor(g.key) });
      setNote(g.key);
      opts.onSelect(g.key);
    });
    row.append(b);
  }
  body.append(row, viewerEl, note);
  return { destroy: () => viewer.destroy() };
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

/** Product families offered for CW3E, with their labels, models, and domains. */
export const CW3E_FAMILIES = Object.freeze([
  { product: 'ivt_map', label: 'Integrated Vapor Transport (IVT)', models: ['GFS_25', 'ECMWF_HRes'], stepped: true },
  { product: 'iwv_map', label: 'Integrated Water Vapor (IWV)', models: ['GFS_25', 'ECMWF_HRes'], stepped: true },
  { product: 'landfalltool_ivt250_probability', label: 'Landfall Tool: IVT 250 Probability', models: ['GEFS_50'], stepped: false },
  { product: 'arscale_map_mean', label: 'Atmospheric River Scale, Ensemble Mean', models: ['GEFS_50'], stepped: false },
]);
const MODEL_LABELS = Object.freeze(/** @type {Record<string, string>} */ ({ GFS_25: 'GFS', ECMWF_HRes: 'ECMWF', GEFS_50: 'GEFS' }));
const DOMAIN_LABELS = Object.freeze(/** @type {Record<string, string>} */ ({
  USWC: 'U.S. West Coast', NEPac: 'Northeast Pacific (covers British Columbia and Southeast Alaska)', IntWest: 'Interior West', NPac: 'North Pacific',
  coast: 'Coast', foothills: 'Foothills', inland: 'Inland',
}));

/**
 * @param {string} id
 * @param {string} labelText
 * @param {{ value: string, label: string }[]} options
 * @param {string} selected
 * @param {(v: string) => void} onChange
 * @returns {HTMLElement}
 */
function selectField(id, labelText, options, selected, onChange) {
  const select = h('select', { id, class: 'nation-picker__input' }, options.map((o) => h('option', { value: o.value, selected: o.value === selected }, o.label)));
  select.addEventListener('change', () => onChange(/** @type {HTMLSelectElement} */ (select).value));
  return h('div', { class: 'nation-picker' }, h('label', { class: 'nation-picker__label', for: id }, labelText), select);
}

/**
 * @param {HTMLElement} body
 * @param {{ manifest: any, stale: boolean }} d
 * @param {ImageryCtx} ctx
 * @param {{ now?: () => Date }} [opts]
 * @returns {{ destroy(): void }}
 */
export function renderCw3e(body, d, ctx, opts = {}) {
  clear(body);
  const template = /** @type {string} */ (source('cw3e-images').urlTemplate);
  const sel = { family: 0, model: 'GFS_25', domain: 'USWC', fh: 0 };
  /** @type {string | null} */
  let probedCycle = null;
  const viewerEl = h('div', { 'data-viewer': 'cw3e' });
  const controls = h('div', { 'data-cw3e-controls': '' });
  const probeNote = h('p', { class: 'panel-note', 'data-cw3e-stale': '' });
  const family = () => /** @type {(typeof CW3E_FAMILIES)[number]} */ (CW3E_FAMILIES[sel.family]);

  /** @returns {{ cycle: string, url: string } | null} */
  function resolve() {
    const f = family();
    const item = manifestItem(d.manifest, f.product, sel.model, sel.domain);
    if (item && !d.stale) {
      const i = item.forecastHours.indexOf(f.stepped ? sel.fh : /** @type {number} */ (item.forecastHours[0]));
      const u = item.urls[i];
      return u ? { cycle: item.cycle, url: u } : null;
    }
    if (d.stale && probedCycle) {
      const fh = f.stepped ? sel.fh : (f.product === 'arscale_map_mean' ? 168 : 384);
      return { cycle: probedCycle, url: cw3eUrl(template, { product: f.product, model: sel.model, domain: sel.domain, cycle: probedCycle, fh }) };
    }
    return null;
  }

  const credit = 'Image credit: Center for Western Weather and Water Extremes, Scripps Institution of Oceanography, UC San Diego.';
  /** @type {ReturnType<typeof createMediaViewer> | null} */
  let viewer = null;

  function paintViewer() {
    const r = resolve();
    const f = family();
    if (!r) {
      viewer?.destroy(); viewer = null; clear(viewerEl);
      viewerEl.append(h('p', { class: 'panel-note', 'data-cw3e-none': '' }, d.stale
        ? 'The scheduled model-run list is out of date. Use the button above to look for the newest model run in this browser.'
        : 'No complete model run is listed for this combination.'));
      return;
    }
    /** @type {ImageryProduct} */
    const product = { id: `cw3e-${f.product}-${sel.model}-${sel.domain}`.toLowerCase().replace(/_/g, '-'), sourceId: 'cw3e-images', url: r.url, kind: 'still', typicalBytes: f.product === 'arscale_map_mean' ? 500_000 : 200_000, loadPolicy: 'tap', stamp: 'cycle' };
    const hourText = f.stepped ? `, forecast hour ${sel.fh}` : '';
    const patch = { label: `${f.label}, ${MODEL_LABELS[sel.model] ?? sel.model}, ${DOMAIN_LABELS[sel.domain] ?? sel.domain}`, stampText: `${modelRunLabel(r.cycle)}${hourText}`, credit, note: PENDING_TERMS_NOTE, forceTap: true };
    const stamp = cycleDate(r.cycle).toISOString();
    if (viewer) viewer.setProduct(product, stamp, patch);
    else viewer = createMediaViewer(viewerEl, { product, stamp, timeZone: ctx.timeZone ?? '', lowData: ctx.lowData, ...patch, catalog: ctx.catalog, stamps: ctx.stamps });
  }

  function paintControls() {
    clear(controls);
    const f = family();
    if (!f.models.includes(sel.model)) sel.model = /** @type {string} */ (f.models[0]);
    const domains = f.product === 'landfalltool_ivt250_probability' ? ['coast', 'foothills', 'inland'] : f.product === 'arscale_map_mean' ? ['coast'] : sel.model === 'GFS_25' ? ['USWC', 'NEPac', 'IntWest', 'NPac'] : ['USWC', 'NEPac', 'IntWest'];
    if (!domains.includes(sel.domain)) sel.domain = /** @type {string} */ (domains[0]);
    controls.append(selectField('cw3e-product', 'Product', CW3E_FAMILIES.map((x, i) => ({ value: String(i), label: x.label })), String(sel.family), (v) => { sel.family = Number(v); paintControls(); paintViewer(); }));
    if (f.models.length > 1) controls.append(selectField('cw3e-model', 'Model', f.models.map((m) => ({ value: m, label: MODEL_LABELS[m] ?? m })), sel.model, (v) => { sel.model = v; paintControls(); paintViewer(); }));
    controls.append(selectField('cw3e-domain', 'Area', domains.map((x) => ({ value: x, label: DOMAIN_LABELS[x] ?? x })), sel.domain, (v) => { sel.domain = v; paintViewer(); }));
    if (f.stepped) {
      const hours = FORECAST_HOURS.map((x) => ({ value: String(x), label: `Forecast hour ${x}` }));
      controls.append(selectField('cw3e-hour', 'Forecast Hour', hours, String(sel.fh), (v) => { sel.fh = Number(v); paintViewer(); }));
      const step = h('div', { class: 'media-viewer__controls' });
      const prev = h('button', { type: 'button', class: 'btn btn--secondary', 'data-action': 'hour-previous' }, 'Previous 12 Hours');
      const next = h('button', { type: 'button', class: 'btn btn--secondary', 'data-action': 'hour-next' }, 'Next 12 Hours');
      prev.addEventListener('click', () => { sel.fh = Math.max(0, sel.fh - 12); paintControls(); paintViewer(); });
      next.addEventListener('click', () => { sel.fh = Math.min(168, sel.fh + 12); paintControls(); paintViewer(); });
      step.append(prev, next);
      controls.append(step);
    }
    if (d.stale) {
      const find = h('button', { type: 'button', class: 'btn btn--secondary', 'data-action': 'find-newest-run' }, 'Find the Newest Model Run');
      find.addEventListener('click', async () => {
        clear(probeNote); probeNote.append('Looking for the newest model run. Each attempt loads one image.');
        const f2 = family();
        const probeHour = f2.stepped ? 0 : (f2.product === 'arscale_map_mean' ? 168 : 384);
        const found = await probeCycleInBrowser((cycle) => cw3eUrl(template, { product: f2.product, model: sel.model, domain: sel.domain, cycle, fh: probeHour }), (opts.now ?? (() => new Date()))());
        clear(probeNote);
        if (!found) { probeNote.append('No recent model run could be loaded. Open the images at the source instead.'); return; }
        probedCycle = /** @type {string} */ (/(\d{10})__1__F/.exec(found)?.[1]);
        probeNote.append(`Found the newest model run this browser could load: ${modelRunLabel(probedCycle)}.`);
        paintViewer();
      });
      controls.append(find, probeNote);
    }
  }

  const note = h('p', { class: 'panel-note' }, PENDING_TERMS_NOTE, ' ', h('a', { href: findSource('cw3e-images')?.humanUrl ?? '', rel: 'noopener' }, 'Open the forecasts at CW3E'), '.');
  body.append(controls, viewerEl, note);
  paintControls();
  paintViewer();
  return { destroy: () => viewer?.destroy() };
}

/**
 * The MIMIC-TPW2 animation: a GIF that plays as soon as it loads, so it loads only on a labeled tap and stops
 * on a visible button. With reduced motion it is offered only as a link to the source.
 * @param {HTMLElement} body
 * @param {{ product: ImageryProduct, stamp: string | null }} d
 * @param {ImageryCtx} ctx
 * @param {{ reducedMotion?: boolean }} [opts]
 * @returns {{ destroy(): void }}
 */
export function renderMtpw(body, d, ctx, opts = {}) {
  clear(body);
  const reduced = opts.reducedMotion ?? Boolean(globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches);
  const size = sizeLabel(d.product.typicalBytes);
  const stage = h('div', { class: 'media-viewer__stage', 'data-viewer': 'mtpw' });
  const controls = h('div', { class: 'media-viewer__controls' });
  const dims = imageDims(d.product);
  const stampText = d.stamp ? `Animation time ${formatAsOf(d.stamp, ctx.timeZone)}` : null;
  function idle() {
    clear(stage); clear(controls);
    stage.append(h('p', { class: 'media-viewer__notice' }, 'This animation loads when you tap.'));
    if (reduced) controls.append(h('a', { class: 'btn btn--link', href: d.product.url, rel: 'noopener' }, `Open Animation at the Source (${size})`));
    else {
      const play = h('button', { type: 'button', class: 'btn btn--secondary', 'data-action': 'load-animation' }, `Load Animation (${size})`);
      play.addEventListener('click', playing);
      controls.append(play);
    }
  }
  function playing() {
    clear(stage); clear(controls);
    stage.append(h('img', { src: d.product.url, alt: `Total precipitable water over the Eastern Pacific, animation. ${stampText ?? ''}`.trim(), width: dims.width, height: dims.height, decoding: 'async', 'data-image-id': d.product.id }));
    const stop = h('button', { type: 'button', class: 'btn btn--secondary', 'data-action': 'stop-animation' }, 'Stop Animation');
    stop.addEventListener('click', idle);
    controls.append(stop);
  }
  if (!d.stamp) {
    stage.append(h('p', { class: 'media-viewer__notice' }, 'This animation has no published time, so it is not shown.'));
  } else idle();
  body.append(h('figure', { class: 'media-viewer' }, stage, controls,
    h('figcaption', { class: 'media-viewer__caption' }, 'Total precipitable water, Eastern Pacific, last 72 hours. ',
      d.stamp ? h('span', { class: 'stamp' }, 'Animation time ', h('time', { datetime: d.stamp }, formatAsOf(d.stamp, ctx.timeZone))) : null,
      ' Credit: CIMSS, University of Wisconsin-Madison. ', PENDING_TERMS_NOTE)));
  return { destroy: () => { clear(body); } };
}

/**
 * The lazy map frame: a labeled button first, the map module (a dynamic import) only after the tap. The
 * sovereignty statement is always on the panel, with or without the map.
 * @param {HTMLElement} body
 * @param {{ label: string, layers: string[], sourceIds: string[], hq: [number, number] | null, nationId: string | null, bytes: number, importMap?: () => Promise<any> }} opts
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
  request.addEventListener('click', async () => {
    /** @type {HTMLButtonElement} */ (request).disabled = true;
    status.textContent = `Loading map (about ${sizeLabel(opts.bytes)})`;
    try {
      const mod = await (opts.importMap ? opts.importMap() : import('../map/create-map.js'));
      map = await mod.createMap(frame, {
        sovereignty: { sourceIds: opts.sourceIds }, label: opts.label, layers: opts.layers, mode: 'auto',
        ...(opts.hq ? { view: { lat: opts.hq[0], lon: opts.hq[1], zoom: 7 } } : {}),
      });
      if (destroyed) { map?.destroy(); return; }
      if (opts.nationId) /** @type {any} */ (map).focusNation?.(opts.nationId);
      request.hidden = true;
      status.textContent = '';
      // The map mounts its own sovereignty note below its frame; remove the placeholder so only one remains.
      if (body.querySelectorAll('.sovereignty-note').length > 1) note.remove();
    } catch {
      /** @type {HTMLButtonElement} */ (request).disabled = false;
      status.textContent = 'The map could not be loaded. Radar images for the nearest station are in the panel below.';
    }
  });
  return { destroy() { destroyed = true; map?.destroy(); } };
}
