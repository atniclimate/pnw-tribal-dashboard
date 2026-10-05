// @ts-check
/**
 * The only sanctioned way to put data on screen (blueprint 3.3). Writes the provenance footer after every
 * load, so a renderer cannot skip it; aborts superseded loads with a generation counter (the May 2026
 * forecastSelectionGen guard); drives refresh through core/poller.js; skips auto-refresh for heavy panels in
 * low-data mode; and, on a development host, asserts that the slot's data-sources match spec.sourceIds.
 * Skeletons never contain digits: a loading panel says "Loading" and names its source. DOM module.
 */
import { clear, h } from '../core/dom.js';
import { createPoller } from '../core/poller.js';
import { renderProvenance } from '../core/provenance.js';
import { findSource } from '../core/sources.js';
import { getItem } from '../core/storage.js';
import { createStatusRegistry, validateSnapshot } from '../core/status.js';

/** @typedef {import('../types.js').PanelHandle} PanelHandle */
/** @typedef {import('../types.js').PanelSpec} PanelSpec */
/** @typedef {import('../types.js').StatusSnapshot} StatusSnapshot */

/** Page-wide registry of panel statuses (the banner and tiles subscribe to it). */
export const panelStatuses = createStatusRegistry();

const DEV_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

const isDevHost = () => DEV_HOSTS.has(globalThis.location?.hostname ?? '');

function lowDataOn() {
  try {
    if (globalThis.document?.documentElement?.getAttribute('data-lowdata') === '1') return true;
  } catch { /* no document */ }
  return getItem('lowdata') === '1';
}

/**
 * @param {StatusSnapshot['sourceIds']} ids
 * @returns {import('../types.js').SourceRecord[]}
 */
function recordsFor(ids) {
  return ids.map((id) => findSource(id)).filter((r) => r !== null);
}

/**
 * @param {string[]} sourceIds
 * @returns {string}
 */
function sourceNames(sourceIds) {
  const names = sourceIds.map((id) => { const r = findSource(id); return r ? (r.attribution || r.owner) : id; });
  return names.join(', ');
}

/**
 * Asserts in development that slot.dataset.sources matches spec.sourceIds.
 * @param {HTMLElement} slot a [data-panel] section with data-sources
 * @param {PanelSpec} spec
 * @returns {PanelHandle}
 */
export function mountPanel(slot, spec) {
  const declared = (slot.dataset.sources ?? '').split(/\s+/).filter(Boolean).sort().join(' ');
  const wanted = [...spec.sourceIds].sort().join(' ');
  if (declared !== wanted) {
    const message = `mountPanel: data-sources "${declared}" does not match sourceIds "${wanted}"`;
    if (isDevHost()) throw new Error(message);
    console.warn(message);
  }

  const body = slot.querySelector('[data-panel-body]') ?? slot.appendChild(h('div', { class: 'panel__body', 'data-panel-body': '' }));
  if (!slot.querySelector('.panel__title') && spec.title) slot.insertBefore(h('h2', { class: 'panel__title' }, spec.title), slot.firstChild);
  const footer = /** @type {HTMLElement} */ (slot.querySelector('[data-provenance]') ?? slot.appendChild(h('footer', { class: 'provenance', 'data-provenance': '' })));

  if (!panelStatuses.has(spec.statusId)) panelStatuses.register(spec.statusId);

  let generation = 0;
  let disposed = false;
  /** @type {AbortController | null} */
  let controller = null;
  /** @type {ReturnType<typeof createPoller> | null} */
  let poller = null;

  function paintLoading() {
    clear(body);
    body.append(h('p', { class: 'panel__loading' }, `Loading ${sourceNames(spec.sourceIds)}`));
    slot.setAttribute('aria-busy', 'true');
    clear(footer);
    footer.setAttribute('data-provenance', '');
    footer.setAttribute('data-status', 'loading');
    footer.setAttribute('data-source-ids', spec.sourceIds.join(' '));
    footer.append(
      h('span', { class: 'provenance__src' }, 'Source: ', ...spec.sourceIds.flatMap((id, i) => {
        const r = findSource(id);
        return [i ? ', ' : '', r ? h('a', { href: r.humanUrl, target: '_blank', rel: 'noopener noreferrer' }, r.attribution || r.owner) : id];
      })),
      h('span', { class: 'provenance__asof' }, 'Loading'),
    );
  }

  /**
   * @param {string} detail
   * @returns {StatusSnapshot}
   */
  const unavailableStatus = (detail) => ({
    state: 'unavailable', asOf: null, asOfBasis: null, detail, sourceIds: [...spec.sourceIds], origin: 'direct',
    completeness: 'partial', checkedAt: new Date().toISOString(),
  });

  /**
   * @param {StatusSnapshot} status
   * @param {unknown} data
   * @returns {StatusSnapshot} the status finally shown (a render failure downgrades it honestly)
   */
  function paint(status, data) {
    let shown = status;
    clear(body);
    try {
      if (shown.state === 'unavailable' || data === null || data === undefined) {
        if (spec.renderUnavailable) spec.renderUnavailable(/** @type {HTMLElement} */ (body), shown);
        else body.append(h('p', { class: 'panel__unavailable' }, shown.detail ?? 'No data is available right now.'));
      } else {
        spec.render(/** @type {HTMLElement} */ (body), data, shown);
      }
    } catch {
      clear(body);
      body.append(h('p', { class: 'panel__unavailable' }, 'This panel could not be displayed. Use the source link below for the original information.'));
      shown = shown.state === 'unavailable'
        ? shown
        : { ...shown, state: 'degraded', completeness: 'partial', detail: 'This panel could not be displayed' };
    }
    return shown;
  }

  /** @returns {Promise<boolean>} true when the panel now shows data */
  async function load() {
    if (disposed) return false;
    const mine = ++generation;
    controller?.abort();
    const ctl = new AbortController();
    controller = ctl;
    /** @type {StatusSnapshot} */
    let status;
    /** @type {unknown} */
    let data = null;
    try {
      const result = await spec.load(ctl.signal);
      status = result.status;
      data = result.data;
      const problems = validateSnapshot(status);
      if (problems.length > 0) {
        status = unavailableStatus('This panel received an invalid status and shows no data.');
        data = null;
      }
    } catch (e) {
      status = unavailableStatus(ctl.signal.aborted ? 'The request was canceled.' : 'The data could not be loaded.');
      if (ctl.signal.aborted) return false;
    }
    // A newer load, or a dispose, supersedes this one: discard without touching the DOM.
    if (mine !== generation || disposed) return false;

    slot.removeAttribute('aria-busy');
    const shown = paint(status, data);
    renderProvenance(footer, shown, recordsFor(spec.sourceIds));
    try { panelStatuses.report(spec.statusId, shown); } catch { /* an invalid snapshot was already replaced above */ }
    return shown.state !== 'unavailable';
  }

  paintLoading();
  void load();

  if (spec.poll && !(spec.heavy && lowDataOn())) {
    poller = createPoller({ statusId: spec.statusId, visibleMs: spec.poll.visibleMs, minMs: spec.poll.minMs, run: () => load() });
    poller.start();
  }

  return {
    async refresh() { await load(); },
    dispose() {
      disposed = true;
      generation += 1;
      controller?.abort();
      poller?.stop();
    },
  };
}
