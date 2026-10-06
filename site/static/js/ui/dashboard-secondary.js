// @ts-check
/** Non-alert Dashboard panels, loaded after the first alert paint. */
import { h } from '../core/dom.js';
import { writeState } from '../core/url-state.js';
/** @typedef {Awaited<ReturnType<typeof import('../hydro/gauges-service.js').loadGauges>>} GaugeData */
/**
 * @param {{
 * selected: import('../types.js').NationRecord | null,
 * scope: import('../types.js').AlertScope,
 * isCurrent: () => boolean,
 * state: () => import('../types.js').UrlState,
 * panel: (id: string, spec: Omit<import('../types.js').PanelSpec, 'sourceIds' | 'statusId' | 'title'>) => import('../types.js').PanelHandle | null,
 * link: (href: string, label: string) => HTMLElement,
 * unavailable: (ids: string[], detail: string) => import('../types.js').StatusSnapshot,
 * zone: () => string,
 * selectFeature: (key: 'a' | 'g', id: string) => void,
 * onGauges: (data: GaugeData, scope: string[] | null) => void,
 * renderCleanups: Map<string, () => void>
 * }} options
 */
export async function mountSecondaryPanels(options) {
  const landscape = document.querySelector('.dashboard-landscape');
  const flags = document.documentElement.dataset;
  if (landscape && !landscape.childElementCount && flags.lowdata !== '1' && flags.embed !== '1' && !flags.panelOnly && navigator.onLine && !matchMedia('(forced-colors: active)').matches) {
    const image = new Image(); image.alt = ''; image.width = 1000; image.height = 750;
    image.decoding = 'async'; image.fetchPriority = 'low';
    image.addEventListener('load', () => { landscape.removeAttribute('hidden'); document.querySelector('[data-landscape-credit]')?.removeAttribute('hidden'); }, { once: true });
    landscape.append(image);
    image.src = new URL('../../img/lake-chelan-nps.jpg', import.meta.url).href;
  }
  const { selected, scope, isCurrent, state, panel, link, unavailable, zone, selectFeature, onGauges, renderCleanups } = options;
  /** @type {GaugeData | null} */
  let gaugeData = null;
  const [contacts, contactUi, contextMod, gauges, gaugeUi, views, lists] = await Promise.all([
    import('../data/contacts.js'), import('../ui/contact-card.js'), import('../forecast/nation-context.js'),
    import('../hydro/gauges-service.js'), import('../ui/gauge-list.js'), import('../ui/forecast-view-local.js'), import('../ui/alert-list.js'),
  ]);
  if (!isCurrent()) return;
  const context = selected ? contextMod.nationContextFrom(selected) : null;
  panel('nation', { load: async () => ({ data: selected, status: selected?.review.reviewedAt ? { state: 'cached', asOf: selected.review.reviewedAt, asOfBasis: 'retrieved', sourceIds: ['cthd-registry'], origin: 'snapshot', completeness: 'complete', checkedAt: new Date().toISOString() } : unavailable(['cthd-registry'], 'Choose a Nation for local information.') }),
    render(body) { if (!selected) return; body.append(h('h3', {}, selected.name), h('p', {}, selected.jurisdictions.join(', ')), link('./contacts/', 'Nation Contacts'));
      const forecast = h('button', { type: 'button', class: 'btn btn--secondary' }, 'Local Forecast'); forecast.addEventListener('click', () => writeState({ view: 'forecast' }, { push: true })); body.append(forecast);
      if (selected.website) body.append(h('p', {}, h('a', { href: selected.website.url }, 'Official Nation Website')));
    } });
  panel('call', { load: async (signal) => { const data = await contacts.loadContactsDoc({ signal }); return { data, status: data.ok ? contacts.curatedStatus(data, new Date(), ['cthd-contacts']) : unavailable(['cthd-contacts'], 'Verified contacts could not be loaded.') }; },
    render(body, data) {
      body.append(h('a', { class: 'btn btn--primary', href: 'tel:911' }, 'Emergency: Call 911'));
      const loaded = /** @type {import('../data/contacts.js').ContactsLoad} */ (data);
      if (loaded.ok && selected) {
        if (!contacts.nationLines(selected.id, loaded.doc.items, new Date()).length) body.append(h('p', {}, contacts.NO_VERIFIED_NOTICE));
        body.append(...contacts.contactsFor(selected, loaded.doc.items, new Date()).slice(0, 4).map((c) => contactUi.contactCard(c, { now: new Date(), emergency: true })));
      } else body.append(h('p', {}, 'Choose a Nation for verified local emergency lines.'));
      body.append(link('./contacts/', 'All Emergency Contacts'));
    }, renderUnavailable(body) { body.append(h('a', { href: 'tel:911' }, 'Emergency: Call 911'), link('./contacts/', 'Contact Directory')); } });
  panel('rivers', { load: async (signal) => { const data = await gauges.loadGauges({ nation: selected, signal }); if (isCurrent() && !signal.aborted) { gaugeData = data; onGauges(data, selected ? gauges.nearbyGauges(selected, data.gauges).map((gauge) => gauge.id) : null); } return { data, status: data.status }; },
    render(body, data) {
      const loaded = /** @type {Awaited<ReturnType<typeof gauges.loadGauges>>} */ (data);
      const shown = selected ? gauges.nearbyGauges(selected, loaded.gauges) : loaded.gauges;
      body.append(h('p', { class: 'caption' }, selected ? 'Gauges near headquarters. Proximity does not establish flooding on Nation lands.' : 'Choose a gauge to inspect observations and available river forecasts.'));
      const target = h('div', {}); body.append(target); gaugeUi.renderGaugeList(target, shown, loaded.statuses, { timeZone: zone(), atOrAboveAction: false, onSelect: (id) => selectFeature('g', id) });
      body.append(link('./forecasts/?view=rivers', 'All River Gauges'));
    }, renderUnavailable(body, status) {
      body.append(h('p', { role: 'status' }, status.detail ?? 'Current gauge readings are unavailable.'));
      if (gaugeData?.gauges.length) {
        body.append(h('p', {}, 'Station locations remain available. Select a station to request its observation history.'));
        const shown = selected ? gauges.nearbyGauges(selected, gaugeData.gauges) : gaugeData.gauges;
        gaugeUi.renderGaugeList(body.appendChild(h('div', {})), shown, gaugeData.statuses,
          { timeZone: zone(), atOrAboveAction: false, onSelect: (id) => selectFeature('g', id) });
      }
    } });
  /** @type {import('../ui/forecast-views.js').ViewContext} */
  const ctx = { nation: () => context, nationReady: async () => context,
    system: () => contextMod.systemFor(context, state().units === 'metric' ? 'metric' : state().units === 'us' ? 'us' : null),
    timeZone: zone, lowData: () => document.documentElement.dataset.lowdata === '1', isOpened: () => true,
    state, writeState: (patch, opts) => writeState(patch, opts ?? { push: true }) };
  for (const [id, key] of [['forecast', 'forecast-local'], ['rain', 'forecast-qpf']]) {
    const definition = views.panels[key ?? '']; if (!id || !definition) continue;
    panel(id, { load: (signal) => definition.load(ctx, signal), render: (body, data, status) => { renderCleanups.get(id)?.(); const cleanup = definition.render(body, data, status, ctx); if (cleanup) renderCleanups.set(id, cleanup); body.append(link('./forecasts/', 'More Forecasts')); },
      renderUnavailable: (body, status) => { if (definition.unavailable) definition.unavailable(body, status, ctx); else body.append(h('p', {}, status.detail ?? 'Local forecast unavailable.'), link('./forecasts/', 'Forecast Sources')); } });
  }
  panel('declarations', { load: async (signal) => { const mod = await import('../declarations/service.js'); const data = await mod.loadDeclarations({ scope, signal }); return { data, status: lists.combineStatuses(data.statuses, ['openfema-declarations', 'cthd-curated-declarations'], ['openfema-declarations', 'cthd-curated-declarations'], new Date()) }; }, render(body) { body.append(h('p', {}, 'Declarations describe government actions and incident dates. They do not replace current weather warnings.'), link('./alerts/?view=declarations', 'Review Declarations')); } });
  panel('official-news', { load: async (signal) => { const mod = await import('../core/sources.js'); return mod.getData('cthd-news', {}, { signal }); }, render(body, data) {
    const doc = /** @type {{items?: import('../pages/news.js').NewsItem[]}} */ (data);
    const items = (doc.items ?? []).filter((item) => item.kind === 'official').sort((a, b) => b.published.localeCompare(a.published)).slice(0, 3);
    body.append(items.length ? h('ul', {}, ...items.map((item) => h('li', {}, h('a', { href: item.url }, item.title)))) : h('p', {}, 'No official news in this copy.'), link('./news/?kind=official', 'Official News and Source Status'));
  } });
}
