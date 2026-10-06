// @ts-check
/** URL-backed hazard workspace. Async results belong to one location epoch. */
import { initChrome, setNationChip } from '../ui/chrome.js';
import { initEmbed } from '../core/embed.js';
import { mountPanel } from '../ui/panel.js';
import { h } from '../core/dom.js';
import { fetchLocal } from '../core/net.js';
import { loadSources } from '../core/sources.js';
import { linkWithState, onStateChange, writeState } from '../core/url-state.js';
import { isExpired } from '../alerts/lifecycle.js';
import { nationPatch, scopeKey, workspaceState } from './dashboard-state.js';

/** @typedef {import('../types.js').NationRecord} NationRecord */
/** @typedef {import('../types.js').StatusSnapshot} StatusSnapshot */
/** @typedef {import('../types.js').LoadAllAlertsResult} AlertsResult */
/** @typedef {import('../types.js').PanelHandle} PanelHandle */
/** @typedef {import('../types.js').DashboardAlert} DashboardAlert */
const PAGE = 'dashboard';
const ALERT_IDS = ['nws-alerts-active', 'eccc-geomet-weather-alerts'];
/** @param {string} id */
const slot = (id) => /** @type {HTMLElement | null} */ (document.querySelector('[data-panel="' + id + '"]'));
/** @param {string[]} ids @param {string} detail @returns {StatusSnapshot} */
const unavailable = (ids, detail) => ({ state: 'unavailable', asOf: null, asOfBasis: null, sourceIds: ids,
  origin: 'snapshot', completeness: 'partial', checkedAt: new Date().toISOString(), detail });
/** @param {DashboardAlert[]} alerts @param {Date} now @returns {DashboardAlert[]} */
export function activeAlerts(alerts, now) {
  return alerts.filter((alert) => alert.lifecycleState === 'active' && alert.messageType !== 'cancel'
    && alert.posture !== 'ended' && !isExpired(alert, now));
}

export async function main() {
  const chromeCleanup = initChrome({ page: PAGE });
  initEmbed({ page: PAGE });
  const lifetime = new AbortController();
  let scopeAbort = new AbortController();
  let detailAbort = new AbortController();
  let generation = 0;
  let state = workspaceState(location.search);
  let currentKey = '';
  /** @type {NationRecord | null} */
  let nation = null;
  /** @type {Map<string, PanelHandle>} */
  const handles = new Map();
  /** @type {Map<string, () => void>} */
  const renderCleanups = new Map();
  /** @type {import('../types.js').CthdMap | null} */
  let map = null;
  /** @type {Promise<void> | null} */
  let mapLoad = null;
  let applyingLayers = false;
  /** @type {Map<string, import('../types.js').Geometry> | null} */
  let geometry = null;
  /** @type {Awaited<ReturnType<typeof import('../hydro/gauges-service.js').loadGauges>> | null} */
  let gaugeData = null;
  /** @type {string[] | null} */
  let gaugeScope = null;
  /** @type {AlertsResult} */
  let latest = emptyAlerts();
  let mapAlertSources = ALERT_IDS;
  /** @type {(() => void) | null} */
  let stopPoller = null;
  /** @type {() => Promise<boolean>} */
  let refreshAlerts = async () => false;
  /** @type {() => Promise<void>} */
  let refreshAlertPanels = async () => {};
  /** @type {() => DashboardAlert[]} */
  let visibleAlerts = () => [];
  /** @type {Promise<Map<string, Record<string, import('../types.js').AlertLanguageBlock>> | null> | null} */
  let textLoad = null;
  const viewerZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  const onlyPanel = document.documentElement.getAttribute('data-panel-only');
  /** @param {string} id */
  const wanted = (id) => !onlyPanel || slot(id)?.dataset.embedPanel === onlyPanel;
  const zone = () => nation?.timeZone ?? viewerZone;
  const workspace = document.querySelector('main');
  const detail = /** @type {HTMLElement | null} */ (document.querySelector('[data-dashboard-detail]'));
  const feedback = document.querySelector('[data-dashboard-status]');
  /** @param {string} message */
  const announce = (message) => { if (feedback) feedback.textContent = message; };
  /** @type {Element | null} */
  let returnFocus = null;

  /** @returns {AlertsResult} */
  function emptyAlerts() { return { alerts: [], statuses: new Map(), diagnostics: { testOrExerciseExcluded: 0, itemsFailed: 0, unknownZoneKeys: 0, truncated: false } }; }
  /** @param {string} id @param {Omit<import('../types.js').PanelSpec, 'sourceIds' | 'statusId' | 'title'>} spec */
  function panel(id, spec) {
    const element = slot(id);
    if (!element || !wanted(id)) return null;
    handles.get(id)?.dispose();
    const handle = mountPanel(element, { title: element.querySelector('h2')?.textContent ?? '',
      sourceIds: (element.dataset.sources ?? '').split(/\s+/).filter(Boolean), statusId: 'dashboard-' + id, ...spec });
    handles.set(id, handle);
    return handle;
  }
  /** @param {string} href @param {string} label */
  const link = (href, label) => h('a', { class: 'btn btn--secondary', href: linkWithState(href, ['n', 'j', 'embed', 'units', 'lowdata', ...(href.startsWith('./alerts/') ? ['hz', 'des', 'band', 'src'] : [])]) }, label);
  /** @param {string[]} ids */
  function failedModule(ids) {
    for (const id of ids) panel(id, { load: async () => ({ data: null, status: unavailable((slot(id)?.dataset.sources ?? 'cthd-registry').split(/\s+/), 'This view could not download. Reload to retry; the page address keeps your selected context.') }),
      render() {}, renderUnavailable(body, status) {
        const retry = h('button', { type: 'button', class: 'btn btn--secondary' }, 'Reload to Retry');
        retry.addEventListener('click', () => location.reload()); body.append(h('p', {}, status.detail ?? ''), retry);
      } });
  }
  // Early snapshot requests for the first alerts load only (paths mirror LIVE_FILES; unit-tested).
  /** @type {{ gen: number, index: Promise<import('../types.js').NetResult>, tsunami: Promise<import('../types.js').NetResult> } | null} */
  let early = { gen: 1, index: fetchLocal('data/live/alerts.json', { priority: 0, signal: lifetime.signal }), tsunami: fetchLocal('data/live/tsunami.json', { priority: 0, signal: lifetime.signal }) };
  const [svc, banner, bannerUi, lists, cards, nationData, pickerUi] = await Promise.all([
    import('../alerts/service.js'), import('../alerts/banner.js'), import('../ui/alert-banner.js'),
    import('../ui/alert-list.js'), import('../ui/alert-card.js'), import('../data/nations.js'),
    import('../ui/nation-picker.js'), loadSources(),
  ]);

  const trigger = document.querySelector('[data-dashboard-picker]');
  if (trigger instanceof HTMLElement) {
    const picker = pickerUi.createNationPicker(trigger, { onSelect: (id) => writeState(nationPatch(id), { push: true }) });
    if (trigger instanceof HTMLButtonElement) { trigger.disabled = false; trigger.removeAttribute('title'); }
    for (const chip of document.querySelectorAll('[data-action="open-nation-picker"]')) chip.addEventListener('click', (event) => { event.preventDefault(); picker.open(); });
    lifetime.signal.addEventListener('abort', () => picker.destroy(), { once: true });
    if (location.hash === '#choose-nation') picker.open();
  }
  const filters = document.querySelector('[data-dashboard-filter]');
  if (filters) {
    for (const [key, label, options] of /** @type {[string, string, readonly {value:string,label:string}[]][]} */ ([
      ['hz', 'Hazard', lists.HAZARD_OPTIONS], ['des', 'Designation', lists.DESIGNATION_OPTIONS],
      ['band', 'Severity', lists.BAND_OPTIONS], ['j', 'Area', lists.REGION_OPTIONS], ['src', 'Source', lists.SOURCE_OPTIONS],
    ])) {
      const select = /** @type {HTMLSelectElement} */ (h('select', { id: 'dashboard-filter-' + key, 'data-dashboard-filter-key': key },
        h('option', { value: '' }, 'All'), ...options.map((option) => h('option', { value: option.value }, option.label))));
      select.addEventListener('change', () => writeState({ [key]: select.value ? [select.value] : undefined, ...(key === 'j' ? { n: undefined, g: undefined } : {}), a: undefined }, { push: true }));
      (key === 'hz' ? filters : document.querySelector('[data-dashboard-more-filters]') ?? filters).append(h('label', { for: select.id }, h('span', {}, label), select));
    }
  }
  for (const tab of document.querySelectorAll('[data-dashboard-tab]')) tab.addEventListener('click', () => {
    writeState({ view: tab.getAttribute('data-dashboard-tab') ?? 'overview', a: undefined, g: undefined }, { push: true });
  });
  document.querySelector('[data-dashboard-clear]')?.addEventListener('click', () => writeState(nationPatch(null), { push: true }));
  document.querySelector('[data-dashboard-share]')?.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(location.href); announce('Link copied with the selected Nation, view, and filters.'); }
    catch { announce('Copy this page address to share the current view.'); }
  });
  document.querySelector('[data-dashboard-refresh]')?.addEventListener('click', async (event) => {
    const button = /** @type {HTMLButtonElement} */ (event.currentTarget);
    button.disabled = true; announce('Refreshing official sources.');
    const epoch = generation;
    try {
      await Promise.all([refreshAlerts(), ...[...handles.entries()].filter(([id]) => !['map', 'alert-banner', 'nation-alerts', 'jurisdictions'].includes(id)).map(([, handle]) => handle.refresh())]);
      if (epoch === generation) announce('Refresh finished. Each panel shows its source status and data time.');
    } finally { button.disabled = false; }
  });
  for (const item of document.querySelectorAll('.bottom-bar a')) {
    if (item.textContent?.trim() === 'Near Me') { item.textContent = 'Choose Nation'; item.addEventListener('click', (event) => { event.preventDefault(); if (trigger instanceof HTMLElement) trigger.click(); }); }
    if (item.textContent?.trim() === 'Rivers') item.addEventListener('click', (event) => { event.preventDefault(); writeState({ view: 'rivers', a: undefined, g: undefined }, { push: true }); slot('rivers')?.scrollIntoView({ block: 'nearest' }); });
  }
  function syncControls() {
    if (workspace) workspace.dataset.dashboardView = String(state.view);
    for (const tab of document.querySelectorAll('[data-dashboard-tab]')) tab.setAttribute('aria-pressed', String(tab.getAttribute('data-dashboard-tab') === state.view));
    for (const select of document.querySelectorAll('select[data-dashboard-filter-key]')) {
      const key = select.getAttribute('data-dashboard-filter-key') ?? '';
      const value = state[key]; /** @type {HTMLSelectElement} */ (select).value = Array.isArray(value) ? String(value[0] ?? '') : '';
    }
    map?.resize?.();
  }

  async function ensureMap() {
    if (map || mapLoad || !wanted('map') || !slot('map')) return mapLoad;
    mapLoad = (async () => {
      const { mountDashboardMap } = await import('../map/dashboard-map.js');
      const loaded = await mountDashboardMap(panel, ({ kind, id }) => {
        if (kind === 'nation') writeState(nationPatch(id), { push: true });
        else if (kind === 'gauge') selectFeature('g', id);
        else if (kind === 'alert') selectFeature('a', id);
      }, lifetime.signal);
      if (!loaded) return;
      map = loaded; map.focusNation(nation?.id ?? null); updateMapGauges(); updateMapAlerts(); applyLayers();
      map.onLayerChange?.(() => {
        if (applyingLayers) return;
        const ids = map?.layerStates?.().filter((layer) => layer.on).map((layer) => layer.id) ?? [];
        writeState({ layers: ids }, { push: true });
      });
      geometry = await svc.loadAlertGeometry({ signal: lifetime.signal }); updateMapAlerts();
      if (typeof state.a === 'string') void map.focusAlert?.(state.a);
      if (typeof state.g === 'string') map.focusGauge?.(state.g);
    })().catch(() => { if (!lifetime.signal.aborted) failedModule(['map']); });
    return mapLoad;
  }

  function updateMapAlerts() { map?.setAlerts(visibleAlerts().map((alert) => ({ ...alert, geometry: alert.geometry ?? geometry?.get(alert.alertId) ?? null })),
    lists.combineStatuses(latest.statuses, mapAlertSources, ALERT_IDS, new Date())); }
  function updateMapGauges() {
    map?.setGaugeScope?.(gaugeScope);
    if (!gaugeData) { map?.setGauges([]); return; }
    const ids = new Set(gaugeData.gauges.map((gauge) => gauge.id));
    map?.setGauges([...gaugeData.statuses.values()].filter((status) => ids.has(status.id)));
  }
  function applyLayers() {
    if (!map) return;
    const enabled = Array.isArray(state.layers) ? state.layers.map(String) : ['hq', 'boundaries', 'alerts', 'zones', 'gauges'];
    applyingLayers = true;
    try { for (const id of ['boundaries', 'hq', 'alerts', 'zones', 'gauges', 'radar']) map.setLayer(id, enabled.includes(id)); }
    finally { applyingLayers = false; }
  }
  /** @param {'a' | 'g'} key @param {string} id */
  function selectFeature(key, id) {
    returnFocus = document.activeElement;
    writeState({ [key]: id, [key === 'a' ? 'g' : 'a']: undefined }, { push: true });
    if (key === 'a') void map?.focusAlert?.(id); else map?.focusGauge?.(id);
    detail?.scrollIntoView({ block: 'nearest' });
  }
  async function showDetail() {
    detailAbort.abort(); detailAbort = new AbortController();
    renderCleanups.get('detail')?.(); renderCleanups.delete('detail');
    if (!detail) return;
    detail.replaceChildren();
    const id = typeof state.g === 'string' ? state.g : typeof state.a === 'string' ? state.a : null;
    detail.hidden = !id;
    if (!id) { map?.clearSelection?.(); if (returnFocus instanceof HTMLElement && returnFocus.isConnected) returnFocus.focus({ preventScroll: true }); returnFocus = null; map?.resize?.(); return; }
    const close = h('button', { class: 'btn btn--secondary', type: 'button' }, 'Close Details');
    close.addEventListener('click', () => writeState({ a: undefined, g: undefined }, { push: true }));
    detail.append(close);
    if (state.g) {
      const gauge = gaugeData?.gauges.find((g) => g.id === id);
      if (!gauge) { detail.append(h('p', { role: 'status' }, gaugeData ? 'This gauge is not available in the current source copy. Choose another gauge or refresh sources.' : 'Loading gauge details.')); return; }
      const body = h('div', {}); detail.append(body);
      const { renderGaugeDetail } = await import('../ui/gauge-detail.js');
      if (!body.isConnected || detailAbort.signal.aborted) return;
      renderCleanups.get('detail')?.();
      const cleanup = renderGaugeDetail(body, gauge, gaugeData?.statuses.get(id) ?? null, { timeZone: zone(), signal: detailAbort.signal,
        system: state.units === 'metric' ? 'metric' : state.units === 'us' ? 'us' : 'native',
        state: () => state, onChange: (patch) => writeState(patch, { push: true }) });
      if (cleanup) renderCleanups.set('detail', cleanup);
    } else {
      const alert = visibleAlerts().find((a) => a.alertId === id);
      if (!alert) { detail.append(h('p', {}, 'This alert is not in the current filtered source copy. Clear the filters or refresh sources.')); return; }
      const card = cards.alertCard(alert, { timeZone: zone(), selected: true,
        loadText: async (alertId) => { textLoad ??= svc.loadAlertText({ signal: scopeAbort.signal }); return (await textLoad)?.get(alertId) ?? null; },
        onShowOnMap: (alertId) => { void map?.focusAlert?.(alertId); slot('map')?.scrollIntoView({ block: 'nearest' }); } });
      const safety = /** @type {Record<string, string>} */ ({ 'rain-landslide': 'atmospheric-rivers', 'smoke-air': 'smoke', fire: 'wildfire', evacuation: 'wildfire', avalanche: 'winter', cold: 'winter', coastal: 'tsunami', marine: 'tsunami', geologic: 'earthquake' });
      const category = alert.categories.includes('flood') ? 'flood' : alert.categories[0] ?? 'kit';
      detail.append(card, link('./contacts/', 'Emergency Contacts for This Area'), link('./safety/#' + (safety[category] ?? category), 'Safety Resources'));
      cards.expandCard(card);
    }
    close.focus({ preventScroll: true }); map?.resize?.();
  }

  async function selectScope() {
    const mine = ++generation;
    scopeAbort.abort(); scopeAbort = new AbortController(); detailAbort.abort(); stopPoller?.();
    for (const [id, handle] of handles) if (id !== 'map') { handle.dispose(); handles.delete(id); }
    for (const cleanup of renderCleanups.values()) cleanup(); renderCleanups.clear();
    nation = null; latest = emptyAlerts(); gaugeData = null; gaugeScope = []; textLoad = null;
    map?.setAlerts([]); map?.setGauges([]); map?.setGaugeScope?.([]); map?.focusNation(null);
    if (detail) { detail.hidden = true; detail.replaceChildren(); }
    for (const el of document.querySelectorAll('[data-panel]:not([data-panel="map"])')) {
      el.querySelector('[data-panel-body]')?.replaceChildren(h('p', { role: 'status' }, 'Loading this location.'));
      el.querySelector('[data-provenance]')?.remove();
    }
    const requested = typeof state.n === 'string' ? state.n : null;
    const heading = document.querySelector('[data-scope-heading]');
    if (heading) heading.textContent = requested ? 'Loading Nation' : 'All of Cascadia';
    setNationChip(null); announce(requested ? 'Loading the selected Nation and its official sources.' : 'Loading regional context.');
    const signal = scopeAbort.signal;
    if (requested) {
      const result = await nationData.loadNation(requested, { signal });
      if (mine !== generation) return;
      if (result.ok) { nation = result.data; const note = document.querySelector('[data-scope-notice]'); if (note instanceof HTMLElement) note.hidden = true; }
      else {
        const note = document.querySelector('[data-scope-notice]');
        if (note instanceof HTMLElement) { note.hidden = false; note.textContent = 'The requested Nation could not be loaded. Showing all of Cascadia. Choose a Nation to try again.'; }
        writeState(nationPatch(null)); return;
      }
    }
    if (mine !== generation) return;
    const selected = nation;
    const regions = Array.isArray(state.j) ? state.j.map(String) : [];
    const scopeName = selected?.name ?? (regions.length ? regions.map((j) => lists.REGION_OPTIONS.find((o) => o.value === j)?.label ?? j).join(', ') : 'All of Cascadia');
    if (heading) heading.textContent = scopeName; setNationChip(selected?.name ?? null);
    const selection = document.querySelector('[data-dashboard-selection]');
    if (selection) selection.textContent = selected ? "Local forecasts use the Nation's headquarters." : 'Choose a Nation for local forecasts, rivers, and verified contacts.';
    if (slot('jurisdictions')) /** @type {HTMLElement} */ (slot('jurisdictions')).hidden = Boolean(selected);
    map?.focusNation(selected?.id ?? null);
    /** @type {import('../types.js').AlertScope} */
    const scope = selected ? { kind: 'nation', nation: selected } : { kind: 'footprint' };
    const required = selected ? banner.requiredSourcesFor(scope) : regions.length ? [...(regions.some((j) => j !== 'bc') ? [ALERT_IDS[0] ?? ''] : []), ...(regions.includes('bc') ? [ALERT_IDS[1] ?? ''] : [])] : ALERT_IDS;
    mapAlertSources = required;
    const scopedAlerts = () => lists.filterAlerts(activeAlerts(latest.alerts, new Date()), { j: regions, only: Boolean(selected) }, { nationId: selected?.id ?? null });
    visibleAlerts = () => lists.filterAlerts(scopedAlerts(), {
      hz: Array.isArray(state.hz) ? state.hz.map(String) : [], des: Array.isArray(state.des) ? state.des.map(String) : [],
      band: Array.isArray(state.band) ? state.band.map(String) : [], src: Array.isArray(state.src) ? state.src.map(String) : [],
    }, {});
    const alertStatus = () => lists.combineStatuses(latest.statuses, required, ALERT_IDS, new Date());
    const drawBanner = (/** @type {HTMLElement} */ body) => bannerUi.renderAlertBanner(body, banner.summarizeForBanner(scopedAlerts(), latest.statuses, required, new Date()), { scopeName, timeZone: zone(), requiredSourceIds: required });
    panel('alert-banner', { load: async () => ({ data: true, status: alertStatus() }), render: drawBanner, renderUnavailable: drawBanner });
    panel('nation-alerts', { load: async () => ({ data: true, status: alertStatus() }), render(body) {
      const alerts = visibleAlerts();
      body.append(h('p', { role: 'status', 'data-dashboard-alert-count': '' }, alerts.length + ' active alerts match this location and these filters.'));
      if (!alerts.length) body.append(h('p', {}, 'No matching alerts in this copy. The overall Alert Status includes all hazards and explains source gaps.'));
      const list = h('ul', { class: 'alert-list' });
      for (const alert of alerts.slice(0, 12)) list.append(h('li', {}, cards.alertCard(alert, { timeZone: zone(),
        lastConfirmedAt: latest.statuses.get(alert.sourceId)?.state === 'live' ? null : alert.provenance.fetchedAt,
        onShowOnMap: (id) => selectFeature('a', id),
        loadText: async (id) => { textLoad ??= svc.loadAlertText({ signal }); return (await textLoad)?.get(id) ?? null; },
      })));
      body.append(list, link('./alerts/', alerts.length > 12 ? 'View All Matching Alerts' : 'View All Alerts'));
    }, renderUnavailable(body) { body.append(h('p', {}, 'Alerts could not be confirmed. This is not an all-clear.'), link('./alerts/', 'Check Official Alert Sources')); } });
    panel('jurisdictions', { load: async () => ({ data: true, status: alertStatus() }), render(body) {
      body.append(h('p', { class: 'caption' }, 'Regional counts reflect the available source copy, not an all-clear.'));
      const table = h('table', { class: 'dashboard-regions' }, h('caption', {}, 'Alerts by Area'), h('thead', {}, h('tr', {}, h('th', {}, 'Area'), h('th', {}, 'Active Alerts'))));
      const rows = h('tbody', {});
      for (const region of lists.REGION_OPTIONS) {
        const confirmed = latest.statuses.get(region.value === 'bc' ? ALERT_IDS[1] ?? '' : ALERT_IDS[0] ?? '');
        const button = h('button', { type: 'button', class: 'btn btn--link' }, region.label);
        button.addEventListener('click', () => writeState({ ...nationPatch(null), j: [region.value] }, { push: true }));
        rows.append(h('tr', {}, h('th', { scope: 'row' }, button), h('td', {}, confirmed && confirmed.state !== 'unavailable' ? lists.filterAlerts(activeAlerts(latest.alerts, new Date()), { j: [region.value] }, {}).length : 'Unknown')));
      }
      table.append(rows); body.append(table);
    } });
    refreshAlertPanels = async () => { await Promise.all(['alert-banner', 'nation-alerts', 'jurisdictions'].map((id) => handles.get(id)?.refresh())); updateMapAlerts(); };
    let secondaryStarted = false;
    /** @param {AlertsResult} result */
    async function accept(result) {
      if (mine !== generation || signal.aborted) return;
      latest = result; await refreshAlertPanels();
      if (mine !== generation) return;
      if (!performance.getEntriesByName('alerts-painted').length) { performance.mark('alerts-painted'); document.dispatchEvent(new Event('cthd:alerts-painted')); }
      void ensureMap();
      if (!secondaryStarted) { secondaryStarted = true; void secondaryPanels(selected, scope, mine).catch(() => { if (mine === generation) failedModule(['nation', 'call', 'rivers', 'forecast', 'rain', 'declarations', 'official-news']); }); }
      if (state.a) void showDetail();
      announce(scopeName + ' selected. Source status and data times are shown in each panel.');
    }
    refreshAlerts = async () => {
      const prefetch = early && early.gen === mine ? early : null; early = null;
      try { await accept(await svc.loadAllAlerts({ scope, registry: { index: null }, page: PAGE, signal, prefetch, onSnapshot: (result) => { void accept(result); } })); }
      catch {
        if (mine !== generation || signal.aborted) return false;
        const statuses = new Map(latest.statuses);
        for (const id of required) { const old = statuses.get(id); statuses.set(id, old?.asOf ? { ...old, state: 'degraded', completeness: 'partial', detail: 'Refresh failed. Showing the last confirmed copy.' } : unavailable([id], 'Alerts could not be confirmed.')); }
        await accept({ ...latest, statuses });
      }
      return required.every((id) => latest.statuses.get(id)?.state === 'live');
    };
    void refreshAlerts();
    const { createPoller } = await import('../core/poller.js');
    if (mine !== generation) return;
    const poller = createPoller({ statusId: 'dashboard-alerts', visibleMs: 300_000, minMs: 300_000, run: refreshAlerts });
    poller.start(); stopPoller = () => poller.stop();
  }

  /** @param {NationRecord | null} selected @param {import('../types.js').AlertScope} scope @param {number} mine */
  async function secondaryPanels(selected, scope, mine) {
    const { mountSecondaryPanels } = await import('../ui/dashboard-secondary.js');
    if (mine !== generation) return;
    await mountSecondaryPanels({ selected, scope, isCurrent: () => mine === generation, state: () => state,
      panel, link, unavailable, zone, selectFeature, renderCleanups,
      onGauges(data, selectedScope) { gaugeData = data; gaugeScope = selectedScope; updateMapGauges(); if (state.g) void showDetail(); } });
  }

  const unsubscribe = onStateChange(() => {
    const before = state; state = workspaceState(location.search); syncControls();
    const nextKey = scopeKey(state);
    if (currentKey !== nextKey) { currentKey = nextKey; void selectScope(); return; }
    if (['hz', 'des', 'band', 'src'].some((key) => JSON.stringify(before[key]) !== JSON.stringify(state[key]))) void refreshAlertPanels();
    if (JSON.stringify(before.layers) !== JSON.stringify(state.layers)) applyLayers();
    if (before.a !== state.a || before.g !== state.g) void showDetail();
  });
  lifetime.signal.addEventListener('abort', () => { unsubscribe(); chromeCleanup(); scopeAbort.abort(); detailAbort.abort(); stopPoller?.(); for (const handle of handles.values()) handle.dispose(); for (const cleanup of renderCleanups.values()) cleanup(); map?.destroy(); });
  addEventListener('pagehide', (event) => { if (!(/** @type {PageTransitionEvent} */ (event)).persisted) lifetime.abort(); });
  addEventListener('pageshow', (event) => { if ((/** @type {PageTransitionEvent} */ (event)).persisted) { map?.resize?.(); void refreshAlerts(); } });
  currentKey = scopeKey(state); syncControls(); await selectScope();
}

if (typeof document !== 'undefined' && document.body?.dataset.page === PAGE) void main().catch(() => {
  slot('alert-banner')?.querySelector('[data-panel-body]')?.replaceChildren(h('p', {}, 'Alert status unknown. The dashboard could not load. This is not an all-clear.'),
    h('a', { href: 'https://www.weather.gov/', target: '_blank', rel: 'noopener' }, 'National Weather Service'), ' or ',
    h('a', { href: 'https://weather.gc.ca/warnings/index_e.html?prov=bc', target: '_blank', rel: 'noopener' }, 'Environment and Climate Change Canada'));
});
