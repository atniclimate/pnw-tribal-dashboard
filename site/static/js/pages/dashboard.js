// @ts-check
/** Dashboard: official alerts paint before forecast, river, contact, and map work. */
import { initChrome, setNationChip } from '../ui/chrome.js';
import { initEmbed } from '../core/embed.js';
import { mountPanel } from '../ui/panel.js';
import { h } from '../core/dom.js';
import { loadSources } from '../core/sources.js';
import { linkWithState } from '../core/url-state.js';
import { isExpired } from '../alerts/lifecycle.js';

/** @typedef {import('../types.js').NationRecord} NationRecord */
/** @typedef {import('../types.js').StatusSnapshot} StatusSnapshot */
/** @typedef {import('../types.js').LoadAllAlertsResult} AlertsResult */
/** @typedef {import('../types.js').PanelHandle} PanelHandle */
/** @typedef {import('../types.js').DashboardAlert} DashboardAlert */
const PAGE = 'dashboard';
const ALERT_IDS = ['nws-alerts-active', 'eccc-geomet-weather-alerts'];
/** @param {string} id */
const slot = (id) => /** @type {HTMLElement | null} */ (document.querySelector(`[data-panel="${id}"]`));
/** @param {string[]} ids @param {string} detail @returns {StatusSnapshot} */
const unavailable = (ids, detail) => ({ state: 'unavailable', asOf: null, asOfBasis: null, sourceIds: ids,
  origin: 'snapshot', completeness: 'partial', checkedAt: new Date().toISOString(), detail });

/**
 * All values originate in the shared alert model; expired/cancelled rows cannot inflate a dashboard count.
 * @param {DashboardAlert[]} alerts
 * @param {Date} now
 * @returns {DashboardAlert[]}
 */
export function activeAlerts(alerts, now) {
  return alerts.filter((alert) => alert.lifecycleState === 'active' && alert.messageType !== 'cancel'
    && alert.posture !== 'ended' && !isExpired(alert, now));
}

/**
 * Every asynchronous render belongs to this document. Selecting a Nation navigates to its shareable URL,
 * which cancels old requests and prevents data from the previous Nation appearing under the new heading.
 * @returns {Promise<void>}
 */
export async function main() {
  initChrome({ page: PAGE });
  initEmbed({ page: PAGE });
  const abort = new AbortController();
  /** @type {PanelHandle[]} */
  const handles = [];
  /** @type {import('../types.js').CthdMap | null} */
  let map = null;
  /** @type {Map<string, import('../types.js').Geometry> | null} */
  let mapGeometry = null;
  /** @type {PanelHandle | null} */
  let mapHandle = null;
  const viewerZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  const params = new URLSearchParams(location.search);
  const requestedNation = params.get('n');
  const onlyPanel = document.documentElement.getAttribute('data-panel-only');
  /** @param {string} id */
  const wanted = (id) => !onlyPanel || slot(id)?.dataset.embedPanel === onlyPanel;
  const [svc, banner, bannerUi, lists, cards, nationData] = await Promise.all([
    import('../alerts/service.js'), import('../alerts/banner.js'), import('../ui/alert-banner.js'),
    import('../ui/alert-list.js'), import('../ui/alert-card.js'), import('../data/nations.js'),
    loadSources().catch(() => null),
  ]);
  /** @type {NationRecord | null} */
  let nation = null;
  if (requestedNation) {
    const loaded = await nationData.loadNation(requestedNation, { signal: abort.signal });
    if (loaded.ok) nation = loaded.data;
    else {
      const note = document.querySelector('[data-scope-notice]');
      if (note instanceof HTMLElement) { note.hidden = false; note.textContent = 'The requested Nation could not be loaded. Showing all of Cascadia. Choose a Nation to try again.'; }
      params.delete('n'); history.replaceState(null, '', `${location.pathname}${params.size ? `?${params}` : ''}${location.hash}`);
    }
  }
  if (nation && nation.id !== requestedNation) { params.set('n', nation.id); history.replaceState(null, '', `${location.pathname}?${params}${location.hash}`); }
  const selectedNation = nation;
  const zone = selectedNation?.timeZone ?? viewerZone;
  const regions = (params.get('j') ?? '').split(',').filter((j) => lists.REGION_OPTIONS.some((option) => option.value === j));
  const scopeName = selectedNation?.name ?? (regions.length ? regions.map((j) => lists.REGION_OPTIONS.find((o) => o.value === j)?.label ?? j).join(', ') : 'All of Cascadia');
  setNationChip(selectedNation?.name ?? null);
  const heading = document.querySelector('[data-scope-heading]');
  if (heading) heading.textContent = scopeName;
  for (const anchor of document.querySelectorAll('.site-nav a, .bottom-bar a, .site-header__brand')) {
    const href = anchor.getAttribute('href');
    if (href) anchor.setAttribute('href', linkWithState(href));
  }
  /** @type {import('../types.js').AlertScope} */
  const scope = selectedNation ? { kind: 'nation', nation: selectedNation } : { kind: 'footprint' };
  const required = selectedNation ? banner.requiredSourcesFor(scope) : regions.length
    ? [...(regions.some((j) => j !== 'bc') ? ['nws-alerts-active'] : []), ...(regions.includes('bc') ? ['eccc-geomet-weather-alerts'] : [])]
    : ALERT_IDS;
  /** @type {AlertsResult} */
  let latest = { alerts: [], statuses: new Map(), diagnostics: { testOrExerciseExcluded: 0, itemsFailed: 0, unknownZoneKeys: 0, truncated: false } };
  /** @type {Promise<Map<string, Record<string, import('../types.js').AlertLanguageBlock>> | null> | null} */
  let textLoad = null;
  const visibleAlerts = () => lists.filterAlerts(activeAlerts(latest.alerts, new Date()), { j: regions }, { nationId: selectedNation?.id ?? null });
  const bannerModel = () => banner.summarizeForBanner(visibleAlerts(), latest.statuses, required, new Date());
  const alertStatus = () => lists.combineStatuses(latest.statuses, required, ALERT_IDS, new Date());

  /** @param {string} id @param {Omit<import('../types.js').PanelSpec, 'sourceIds' | 'statusId' | 'title'>} spec */
  function panel(id, spec) {
    const element = slot(id);
    if (!element || !wanted(id)) return null;
    const handle = mountPanel(element, { title: element.querySelector('h2')?.textContent ?? '',
      sourceIds: (element.dataset.sources ?? '').split(/\s+/).filter(Boolean), statusId: `dashboard-${id}`, ...spec });
    handles.push(handle);
    return handle;
  }
  /** @param {string} href @param {string} label */
  const link = (href, label) => h('a', { class: 'btn btn--secondary', href: linkWithState(href, ['n', 'j', 'embed', 'units', 'lowdata']) }, label);
  /** @param {HTMLElement} body */
  const drawBanner = (body) => bannerUi.renderAlertBanner(body, bannerModel(), { scopeName, timeZone: zone, requiredSourceIds: required });
  const bannerHandle = panel('alert-banner', { load: async () => ({ data: true, status: alertStatus() }), render: drawBanner, renderUnavailable: drawBanner });
  const alertsHandle = panel('nation-alerts', {
    load: async () => ({ data: true, status: alertStatus() }),
    render(body) {
      const ordered = visibleAlerts();
      const shown = selectedNation ? ordered.slice(0, 8) : ordered.filter((a) => a.posture === 'act-now').slice(0, 5);
      if (!shown.length) body.append(h('p', {}, selectedNation ? banner.bannerCopy(bannerModel(), { scopeName, timeZone: zone, requiredSourceIds: required }).headline
        : 'No act-now alerts are listed in this copy. Check Alert Status above and All Alerts for watches, advisories, and source gaps.'));
      const list = h('ul', { class: 'alert-list' });
      for (const alert of shown) list.append(h('li', {}, cards.alertCard(alert, { timeZone: zone,
        lastConfirmedAt: latest.statuses.get(alert.sourceId)?.state === 'live' ? null : alert.provenance.fetchedAt,
        loadText: async (id) => { textLoad ??= svc.loadAlertText({ signal: abort.signal }); return (await textLoad)?.get(id) ?? null; },
      })));
      body.append(list, link('./alerts/', 'View All Alerts'));
    },
    renderUnavailable(body) { body.append(h('p', {}, 'Alerts could not be confirmed. This is not an all-clear.'), link('./alerts/', 'Check Official Alert Sources')); },
  });
  if (selectedNation && slot('jurisdictions')) /** @type {HTMLElement} */ (slot('jurisdictions')).hidden = true;
  const regionHandle = !selectedNation ? panel('jurisdictions', {
    load: async () => ({ data: true, status: alertStatus() }),
    render(body) {
      body.append(h('p', { class: 'caption' }, 'Counts reflect the available copy, not an all-clear. The source status below applies to this table.'));
      body.append(h('div', { class: 'dashboard-regions-wrap' }, h('table', { class: 'dashboard-regions' },
        h('caption', {}, 'Alerts by Area and Action'), h('thead', {}, h('tr', {}, ...['Area', 'Act Now', 'Prepare', 'Monitor'].map((label) => h('th', { scope: 'col' }, label)))),
        h('tbody', {}, lists.REGION_OPTIONS.map((region) => {
          const alerts = lists.filterAlerts(activeAlerts(latest.alerts, new Date()), { j: [region.value] }, {});
          const confirmed = latest.statuses.get(region.value === 'bc' ? ALERT_IDS[1] ?? '' : ALERT_IDS[0] ?? '');
          const hasCopy = confirmed && confirmed.state !== 'unavailable';
          return h('tr', {}, h('th', { scope: 'row' }, h('a', { href: linkWithState(`./alerts/?j=${encodeURIComponent(region.value)}`) }, region.label)),
            ...['act-now', 'prepare', 'monitor'].map((posture) => h('td', {}, hasCopy ? alerts.filter((a) => a.posture === posture).length : 'Unknown')));
        })))));
    },
  }) : null;

  async function initPicker() {
    const trigger = document.querySelector('[data-dashboard-picker]');
    if (!(trigger instanceof HTMLElement)) return;
    try {
      const pickerModule = await import('../ui/nation-picker.js');
      if (abort.signal.aborted) return;
      const picker = pickerModule.createNationPicker(trigger, { onSelect(id) {
        const url = new URL(location.href); if (id) url.searchParams.set('n', id); else url.searchParams.delete('n');
        url.searchParams.delete('j'); url.hash = ''; location.assign(url.href);
      } });
      for (const chip of document.querySelectorAll('[data-action="open-nation-picker"]')) chip.addEventListener('click', (event) => { event.preventDefault(); picker.open(); });
      if (location.hash === '#choose-nation') picker.open();
      addEventListener('pagehide', () => picker.destroy(), { once: true });
    } catch { trigger.textContent = 'Nation Search Unavailable'; }
  }

  let secondaryStarted = false;
  /** @param {AlertsResult} result */
  async function accept(result) {
    if (abort.signal.aborted) return;
    latest = result;
    await Promise.all([bannerHandle?.refresh(), alertsHandle?.refresh(), regionHandle?.refresh()]);
    if (map) map.setAlerts(visibleAlerts().map((alert) => ({ ...alert, geometry: alert.geometry ?? mapGeometry?.get(alert.alertId) ?? null })));
    if (mapHandle) void mapHandle.refresh();
    if (!performance.getEntriesByName('alerts-painted').length) { performance.mark('alerts-painted'); document.dispatchEvent(new Event('cthd:alerts-painted')); }
    if (!secondaryStarted) { secondaryStarted = true; void initPicker(); void secondaryPanels().catch(() => {
      for (const element of document.querySelectorAll('[data-panel]')) {
        const body = element.querySelector('[data-panel-body]');
        if (body && !body.textContent?.trim()) body.append(h('p', {}, 'This section could not be loaded. Use the page navigation for official sources and further information.'));
      }
    }); }
  }
  async function refreshAlerts() {
    try { await accept(await svc.loadAllAlerts({ scope, registry: { index: null }, page: PAGE, signal: abort.signal, onSnapshot: (result) => { void accept(result); } })); }
    catch {
      const statuses = new Map(latest.statuses);
      for (const id of required) {
        const prior = statuses.get(id);
        statuses.set(id, prior?.asOf ? { ...prior, state: 'degraded', completeness: 'partial', detail: 'The refresh failed. Showing the last confirmed copy.' }
          : unavailable([id], 'Alerts could not be confirmed.'));
      }
      await accept({ ...latest, statuses });
    }
    return required.every((id) => latest.statuses.get(id)?.state === 'live');
  }
  void refreshAlerts();
  const { createPoller } = await import('../core/poller.js');
  const poller = createPoller({ statusId: 'dashboard-alerts', visibleMs: 300_000, minMs: 300_000, run: refreshAlerts });
  poller.start();
  addEventListener('pagehide', () => { abort.abort(); poller.stop(); handles.forEach((handle) => handle.dispose()); map?.destroy(); }, { once: true });

  async function secondaryPanels() {
    const [contacts, contactUi, contextMod] = await Promise.all([import('../data/contacts.js'), import('../ui/contact-card.js'), import('../forecast/nation-context.js')]);
    contactUi.markOutwardLinks(document.querySelector('main') ?? document);
    const context = selectedNation ? contextMod.nationContextFrom(selectedNation) : null;
    panel('nation', {
      load: async () => ({ data: selectedNation, status: selectedNation?.review.reviewedAt
        ? { state: 'cached', asOf: selectedNation.review.reviewedAt, asOfBasis: 'retrieved', sourceIds: ['cthd-registry'], origin: 'snapshot', completeness: 'complete', checkedAt: new Date().toISOString(), detail: 'Reviewed public Nation registry. Boundary representation is not jurisdiction.' }
        : unavailable(['cthd-registry'], 'Choose a Nation to show its reviewed public information.') }),
      render(body) { if (!selectedNation) return; body.append(h('h3', {}, selectedNation.name),
        h('p', {}, selectedNation.jurisdictions.join(', ')), h('p', { class: 'caption' }, `Times are shown in ${selectedNation.timeZone}.`),
        link('./contacts/', 'Nation Contacts'), link('./forecasts/', 'Local Forecast'));
        if (selectedNation.website) body.append(h('p', {}, h('a', { href: selectedNation.website.url }, 'Official Nation Website')));
      },
    });
    panel('call', {
      load: async (signal) => { const data = await contacts.loadContactsDoc({ signal }); return { data,
        status: data.ok ? contacts.curatedStatus(data, new Date(), ['cthd-contacts']) : unavailable(['cthd-contacts'], 'Verified contacts could not be loaded.') }; },
      render(body, data) {
        body.append(h('p', {}, h('a', { class: 'btn btn--primary', href: 'tel:911' }, 'Emergency: Call 911')));
        const loaded = /** @type {import('../data/contacts.js').ContactsLoad} */ (data);
        if (loaded.ok && selectedNation) {
          const lines = contacts.contactsFor(selectedNation, loaded.doc.items, new Date());
          if (!contacts.nationLines(selectedNation.id, loaded.doc.items, new Date()).length) body.append(h('p', {}, contacts.NO_VERIFIED_NOTICE));
          body.append(...lines.slice(0, 4).map((contact) => contactUi.contactCard(contact, { now: new Date(), emergency: true })));
        } else body.append(h('p', {}, 'Choose a Nation for verified local emergency lines.'));
        body.append(link('./contacts/', 'All Emergency Contacts'));
      },
      renderUnavailable(body) { body.append(h('p', {}, h('a', { class: 'btn btn--primary', href: 'tel:911' }, 'Emergency: Call 911')), h('p', {}, 'Local contacts could not be loaded.'), link('./contacts/', 'Contact Directory')); },
    });
    if (wanted('rivers')) {
      const [gauges, gaugeUi] = await Promise.all([import('../hydro/gauges-service.js'), import('../ui/gauge-list.js')]);
      panel('rivers', {
        load: async (signal) => { const data = await gauges.loadGauges({ nation: selectedNation, signal }); return { data, status: data.status }; },
        render(body, data) {
          const loaded = /** @type {Awaited<ReturnType<typeof gauges.loadGauges>>} */ (data);
          const shown = selectedNation ? gauges.nearbyGauges(selectedNation, loaded.gauges) : loaded.gauges;
          body.append(h('p', { class: 'caption' }, selectedNation ? 'Nearby gauges are not an assessment of flooding on Nation lands.' : 'Gauges with current observations at or above the agency’s action stage. British Columbia gauges have no published flood categories here.'));
          const target = h('div', {}); body.append(target);
          gaugeUi.renderGaugeList(target, shown, loaded.statuses, { timeZone: zone, atOrAboveAction: !selectedNation,
            onSelect: (id) => location.assign(linkWithState(`./forecasts/?view=rivers&g=${encodeURIComponent(id)}`)) });
          body.append(link('./forecasts/?view=rivers', 'All River Gauges'));
        },
      });
    }
    if (wanted('forecast') || wanted('rain')) {
      const views = await import('../ui/forecast-view-local.js');
      /** @type {import('../ui/forecast-views.js').ViewContext} */
      const ctx = { nation: () => context, nationReady: async () => context, system: () => contextMod.systemFor(context, params.get('units') === 'metric' ? 'metric' : params.get('units') === 'us' ? 'us' : null),
        timeZone: () => zone, lowData: () => document.documentElement.dataset.lowdata === '1', isOpened: () => true,
        state: () => ({}), writeState: () => {} };
      for (const [id, key] of [['forecast', 'forecast-local'], ['rain', 'forecast-qpf']]) {
        const definition = views.panels[key ?? '']; if (!definition || !id) continue;
        panel(id, { load: async (signal) => {
          const result = await definition.load(ctx, signal);
          if (id === 'rain' && result.data && typeof result.data === 'object' && 'days' in result.data && Array.isArray(result.data.days)) {
            return { ...result, data: { ...result.data, days: result.data.days.slice(0, 3) } };
          }
          return result;
        }, render: (body, data, status) => { definition.render(body, data, status, ctx); body.append(link('./forecasts/', 'More Forecasts')); } });
      }
    }
    panel('declarations', {
      load: async (signal) => {
        const declarations = await import('../declarations/service.js');
        const result = await declarations.loadDeclarations({ scope, signal });
        return { data: result, status: lists.combineStatuses(result.statuses, ['openfema-declarations', 'cthd-curated-declarations'], ['openfema-declarations', 'cthd-curated-declarations'], new Date()) };
      },
      render(body, data) {
        const result = /** @type {Awaited<ReturnType<typeof import('../declarations/service.js').loadDeclarations>>} */ (data);
        const federal = result.statuses.get('openfema-declarations')?.state === 'unavailable'
          ? 'Federal declaration records could not be confirmed.' : `${result.fema.length} federal declaration records in this copy.`;
        const curated = result.statuses.get('cthd-curated-declarations')?.state === 'unavailable'
          ? 'The reviewed government declaration list could not be loaded.' : `${result.curated.length} records in the reviewed Tribal, state, and provincial list.`;
        body.append(h('p', {}, federal), h('p', {}, curated), h('p', { class: 'caption' }, 'Declaration dates do not indicate a current weather warning. Review each record for its incident and closure dates.'),
          link('./alerts/?view=declarations', 'Review Declarations'));
      },
    });
    panel('official-news', {
      load: async (signal) => { const sources = await import('../core/sources.js'); return sources.getData('cthd-news', {}, { signal }); },
      renderUnavailable(body) { body.append(h('p', {}, 'Official news could not be loaded. Check the News page for official sources and their update status.'), link('./news/?kind=official', 'Official News and Source Status')); },
      render(body, data) {
        const env = /** @type {{ items?: import('./news.js').NewsItem[] }} */ (data);
        const items = (env.items ?? []).filter((item) => item.kind === 'official').sort((a, b) => b.published.localeCompare(a.published)).slice(0, 3);
        body.append(items.length ? h('ul', {}, items.map((item) => h('li', {}, h('a', { href: item.url }, item.title)))) : h('p', {}, 'No official news items are listed in this copy.'), link('./news/?kind=official', 'Official News and Source Status'));
      },
    });
    if (wanted('map')) {
      const mapSlot = slot('map');
      if (mapSlot) {
        const target = h('div', { class: 'dashboard-map', hidden: true });
        const show = /** @type {HTMLButtonElement} */ (h('button', { type: 'button', class: 'btn btn--secondary' }, 'Show Map'));
        const note = h('p', { class: 'caption' }, 'The outline map loads on request. Representation, not jurisdiction. Public boundaries do not establish a Nation’s land or authority.');
        mapHandle = panel('map', { load: async () => ({ data: true, status: { ...alertStatus(), sourceIds: (mapSlot.dataset.sources ?? '').split(/\s+/) } }),
          render: (body) => body.append(note, show, target), renderUnavailable: (body) => body.append(note, show, target) });
        show.addEventListener('click', async () => {
          if (map) return;
          show.disabled = true; show.textContent = 'Loading Map'; target.hidden = false;
          try {
            const adapter = await import('../map/adapter.js');
            map = await adapter.requestMap(target, { sovereignty: { sourceIds: ['bia-lar', 'census-aiannh-2025', 'nrcan-aboriginal-lands-bc'] }, label: `Hazard map for ${scopeName}`,
              layers: ['outlines', 'boundaries', 'alerts', 'zones'], mode: 'auto',
              ...(selectedNation ? { view: { lat: selectedNation.hq.lat, lon: selectedNation.hq.lon, zoom: 8 } } : {}) });
            mapGeometry = await svc.loadAlertGeometry({ signal: abort.signal });
            map.setAlerts(visibleAlerts().map((alert) => ({ ...alert, geometry: alert.geometry ?? mapGeometry?.get(alert.alertId) ?? null })));
            show.hidden = true;
          } catch { show.disabled = false; show.textContent = 'Try Loading the Map Again'; note.textContent = 'The map could not be loaded. The alert list remains available above. Representation, not jurisdiction.'; }
        });
      }
    }
  }
}

if (typeof document !== 'undefined' && document.body?.dataset.page === PAGE) {
  void main().catch(() => {
    const banner = slot('alert-banner')?.querySelector('[data-panel-body]');
    if (banner) banner.replaceChildren(h('p', {}, 'Alert status unknown. The dashboard could not load. This is not an all-clear.'),
      h('a', { href: 'https://www.weather.gov/', target: '_blank', rel: 'noopener' }, 'National Weather Service'), ' or ',
      h('a', { href: 'https://weather.gc.ca/warnings/index_e.html?prov=bc', target: '_blank', rel: 'noopener' }, 'Environment and Climate Change Canada'));
  });
}
