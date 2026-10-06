// @ts-check
/**
 * Entry module for the alerts page (blueprint 7.2). Loaded by <script type="module">.
 *
 * Three views share one load of the alert engine (`alerts/service.js`): the list, the map (list twin, legend,
 * and the map module behind a request), and declarations (OpenFEMA grouped per disaster plus the reviewed
 * list). Everything past the chrome and the panel runtime loads by dynamic import, so the page's static
 * import graph stays inside its budget (blueprint 8.1) and the alert list can paint from the scheduled copy
 * before the live top-ups finish.
 *
 * Honesty rules held here: "no alerts" is shown only when `summarizeForBanner` proves every required source
 * is live and complete, otherwise the page says the status is unknown and that this is not an all-clear;
 * alert text is rendered as the agency wrote it; a declaration is never called "active" on inference;
 * candidate sources (British Columbia evacuations and River Forecast Centre) stay hidden and unrequested
 * while the candidate flag is off; the map is requested only after `alerts-painted` and a map request.
 *
 * Owner: lane L11.
 */
import { initChrome } from '../ui/chrome.js';
import { clear, h, telHref } from '../core/dom.js';
import { fetchLocal } from '../core/net.js';
import { loadSources } from '../core/sources.js';
import { mountPanel } from '../ui/panel.js';
import { renderProvenance } from '../core/provenance.js';
import { formatAsOf } from '../core/time.js';

/** @typedef {import('../types.js').DashboardAlert} DashboardAlert */
/** @typedef {import('../types.js').NationRecord} NationRecord */
/** @typedef {import('../types.js').NationIndexEntry} NationIndexEntry */
/** @typedef {import('../types.js').StatusSnapshot} StatusSnapshot */
/** @typedef {import('../types.js').FemaDeclaration} FemaDeclaration */
/** @typedef {import('../types.js').CuratedDeclaration} CuratedDeclaration */
/** @typedef {import('../types.js').LoadAllAlertsResult} LoadAllAlertsResult */
/** @typedef {import('../types.js').UrlStateSchema} UrlStateSchema */
/** @typedef {import('../types.js').CthdMap} CthdMap */

const PAGE = 'alerts';
const NWS = 'nws-alerts-active';
const ECCC = 'eccc-geomet-weather-alerts';
const NTWC = 'ntwc-atom';
const ALERT_SOURCES = [NWS, ECCC, NTWC];
const EMCR = 'bc-emcr-evacuations';
const RFC = 'bc-rfc-flood-advisories';
const MAP_SOURCES = [NWS, ECCC, 'nws-zones-api', 'bia-lar', 'census-aiannh-2025', 'nrcan-aboriginal-lands-bc', 'carto-dark-matter'];
const FEMA = 'openfema-declarations';
const CURATED = 'cthd-curated-declarations';
const BC_HAZARDS_FILE = 'data/live/bc-hazards.json';

/** @param {string} id @returns {HTMLElement | null} */
const panelSlot = (id) => /** @type {HTMLElement | null} */ (document.querySelector(`[data-panel="${id}"]`));

/**
 * Page start-up.
 * @returns {Promise<void>}
 */
export async function main() {
  initChrome({ page: PAGE });
  const embedReady = import('../core/embed.js').then(({ initEmbed }) => initEmbed({ page: PAGE }));
  // Links to other sites open in a new tab with rel="noopener" (blueprint 1.4). Panels write their source links
  // after load, so the page marks them as they appear.
  const markOutward = () => {
    for (const a of document.querySelectorAll('main a[href^="http"]')) {
      const link = /** @type {HTMLAnchorElement} */ (a);
      if (link.origin !== location.origin && link.target !== '_blank') { link.target = '_blank'; link.rel = 'noopener'; }
    }
  };
  const mainEl = document.querySelector('main');
  if (mainEl) new MutationObserver(markOutward).observe(mainEl, { childList: true, subtree: true });
  markOutward();
  const viewerZone = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { return 'UTC'; } })();

  // Everything the page needs beyond the panel runtime loads together, so one round trip covers the lot.
  const [sourcesLoaded, svc, listMod, chipsMod, bannerMod, urlState, tabsMod, liveMod, cardMod, sourcesMod, pollerMod, appMod, toastMod] = await Promise.all([
    loadSources().then(() => true, () => false),
    import('../alerts/service.js'),
    import('../ui/alert-list.js'),
    import('../ui/filter-chips.js'),
    import('../alerts/banner.js'),
    import('../core/url-state.js'),
    import('../ui/tabs.js'),
    import('../ui/live-region.js'),
    import('../ui/alert-card.js'),
    import('../core/sources.js'),
    import('../core/poller.js'),
    import('../config/app.js'),
    import('../ui/toast.js'),
    embedReady,
  ]);
  const APP = appMod.APP;

  // One polite announcement per change: the banner sentence and the result count are joined, so the second
  // does not replace the first before it is read. The live region itself ignores an unchanged message.
  /** @type {string[]} */
  const spoken = ['', ''];
  /** @type {ReturnType<typeof setTimeout> | null} */
  let speakTimer = null;
  /** @param {number} slot @param {string} text */
  const announce = (slot, text) => {
    spoken[slot] = text;
    if (speakTimer !== null) clearTimeout(speakTimer);
    speakTimer = setTimeout(() => { speakTimer = null; liveMod.announce(spoken.filter(Boolean).join(' ')); }, 200);
  };
  /** @param {string} text */
  const announceNow = (text) => liveMod.announce(text);

  // ------------------------------------------------------------------------------------------------
  // URL state, Nation, filters
  // ------------------------------------------------------------------------------------------------
  const readUrl = () => urlState.readState(listMod.ALERT_URL_SCHEMA);
  let url = readUrl();
  const rawNation = new URLSearchParams(location.search).get('n');

  /** @type {NationIndexEntry[]} */
  let nationsIndex = [];
  /** @type {NationRecord | null} */
  let nation = null;
  const nationsReady = (async () => {
    // The registry files are same-origin data (blueprint 5.2). Renamed Nation ids are rewritten through
    // id-redirects before n= is read, so an old link still lands on the right Nation.
    const [idx, redirects] = await Promise.all([
      fetchLocal('data/registry/nations-index.json', { priority: 0 }),
      fetchLocal('data/registry/id-redirects.json', { priority: 0 }),
    ]);
    if (idx.ok && Array.isArray(/** @type {any} */ (idx.data)?.nations)) nationsIndex = /** @type {any} */ (idx.data).nations;
    if (redirects.ok) urlState.setIdRedirects(/** @type {any} */ (redirects.data));
    url = readUrl();
    if (url.n) {
      const rec = await fetchLocal(`data/registry/nations/${url.n}.json`, { priority: 0 });
      if (rec.ok) nation = /** @type {NationRecord} */ (rec.data);
    }
    if (rawNation && !nation) toastMod.showToast('The requested Nation was not recognized; showing all of Cascadia.');
    if (nation) {
      for (const el of document.querySelectorAll('[data-nation-chip-name]')) el.textContent = nation.name;
    }
  })();
  const footprintReady = (async () => {
    const res = await fetchLocal('data/geo/footprint-ugc.json', { priority: 1 });
    return res.ok && res.data && typeof res.data === 'object' ? /** @type {Record<string, string>} */ ((/** @type {any} */ (res.data)).marineToRegion ?? {}) : {};
  })();

  /** @returns {import('../ui/alert-list.js').AlertFilters} */
  const alertFilters = () => ({
    j: /** @type {string[] | undefined} */ (url.j), hz: /** @type {string[] | undefined} */ (url.hz), des: /** @type {string[] | undefined} */ (url.des),
    band: /** @type {string[] | undefined} */ (url.band), posture: /** @type {string[] | undefined} */ (url.posture),
    src: /** @type {string[] | undefined} */ (url.src), only: url.only === true,
  });
  const langOf = () => (url.lang === 'fr' ? 'fr' : 'en');
  const zoneOf = () => nation?.timeZone ?? viewerZone;

  // ------------------------------------------------------------------------------------------------
  // Shared alert load: snapshot paints first, live top-ups follow
  // ------------------------------------------------------------------------------------------------
  /** @type {LoadAllAlertsResult | null} */
  let latest = null;
  /** @type {'loading' | 'snapshot' | 'final' | 'failed'} */
  let phase = 'loading';
  /** @type {Map<string, Record<string, import('../types.js').AlertLanguageBlock>> | null} */
  let textMap = null;
  /** @type {Promise<void> | null} */
  let textLoad = null;
  /** @type {Set<string>} */
  const announcedWarnings = new Set();
  let firstPaintDone = false;
  let lastEcccAt = 0;
  /** @type {(() => void)[]} */
  const waiters = [];
  const abort = new AbortController();
  /** @type {{ refresh: () => Promise<void> }[]} */
  const alertPanels = [];

  /** @param {LoadAllAlertsResult} r */
  const setLatest = (r) => {
    latest = r;
    for (const w of waiters.splice(0)) w();
  };
  const whenData = () => (latest ? Promise.resolve() : new Promise((resolve) => { waiters.push(() => resolve(undefined)); }));

  const marineToRegionP = footprintReady;
  /** @type {Record<string, string>} */
  let marineToRegion = {};

  async function ensureText() {
    textLoad ??= svc.loadAlertText({ signal: abort.signal }).then((m) => { textMap = m; }, () => { textMap = null; });
    await textLoad;
  }
  /** @param {string} alertId */
  const loadText = async (alertId) => {
    await ensureText();
    return textMap?.get(alertId) ?? null;
  };

  /**
   * Nation relevance for alerts the direct top-up could not score in footprint scope.
   * @param {DashboardAlert[]} alerts
   * @param {NationRecord | null} n
   * @returns {Promise<DashboardAlert[]>}
   */
  async function withNationRelevance(alerts, n) {
    if (!n) return alerts;
    const rel = await import('../alerts/relevance.js');
    return alerts.map((a) => (a.nationIds.includes(n.id) || !rel.nationIdsForAlert(a, [n]).includes(n.id) ? a : { ...a, nationIds: [...a.nationIds, n.id] }));
  }

  /** @param {LoadAllAlertsResult} r @returns {Promise<LoadAllAlertsResult>} */
  async function prepared(r) {
    await nationsReady;
    return { ...r, alerts: await withNationRelevance(r.alerts, nation) };
  }

  async function startLoading() {
    await nationsReady;
    marineToRegion = await marineToRegionP;
    /** @type {LoadAllAlertsResult | null} */
    let final = null;
    try {
      final = await svc.loadAllAlerts({
        scope: { kind: 'footprint' },
        registry: { index: nationsIndex.length > 0 ? { schema: 'cthd.nations-index/1', generatedAt: '', nations: nationsIndex } : null },
        page: PAGE,
        signal: abort.signal,
        onSnapshot: (r) => { void prepared(r).then((p) => { if (phase === 'loading') { phase = 'snapshot'; setLatest(p); void refreshAlertPanels(); } }); },
      });
    } catch {
      final = null;
    }
    if (final === null) {
      if (latest === null) {
        phase = 'failed';
        setLatest({ alerts: [], statuses: new Map(), diagnostics: { testOrExerciseExcluded: 0, itemsFailed: 0, unknownZoneKeys: 0, truncated: false } });
      }
    } else {
      phase = 'final';
      lastEcccAt = Date.now();
      setLatest(await prepared(final));
    }
    await refreshAlertPanels();
    void ensureText();
    startPolling();
  }

  function startPolling() {
    const poller = pollerMod.createPoller({
      statusId: 'alerts-page',
      visibleMs: APP.poll.nwsTopUp,
      minMs: APP.poll.nwsMin,
      run: async (signal) => {
        const previous = latest;
        const ecccDue = Date.now() - lastEcccAt >= APP.poll.eccc;
        try {
          const r = await svc.loadAllAlerts({
            scope: { kind: 'footprint' },
            registry: { index: null },
            page: PAGE,
            signal,
            // Environment and Climate Change Canada is asked at most every 300 seconds (blueprint 3.7.4).
            deps: ecccDue ? {} : { isEnabled: (id) => id !== ECCC && sourcesMod.isEnabled(id) },
          });
          let next = r;
          if (!ecccDue && previous) {
            const statuses = new Map(r.statuses);
            const prevEccc = previous.statuses.get(ECCC);
            if (prevEccc) statuses.set(ECCC, prevEccc);
            next = { ...r, statuses, alerts: [...r.alerts.filter((a) => a.agency !== 'eccc'), ...previous.alerts.filter((a) => a.agency === 'eccc')] };
          } else {
            lastEcccAt = Date.now();
          }
          const prev = latest;
          setLatest(await prepared(next));
          announceNewWarnings(prev);
          await refreshAlertPanels();
          return ![...next.statuses.values()].every((s) => s.state === 'unavailable');
        } catch {
          return false;
        }
      },
    });
    poller.start();
  }

  /** @param {LoadAllAlertsResult | null} before */
  function announceNewWarnings(before) {
    if (!nation || !latest) return;
    const known = new Set((before?.alerts ?? []).map((a) => a.alertId));
    for (const a of latest.alerts) {
      if (!a.nationIds.includes(nation.id)) continue;
      if (a.posture !== 'act-now' || !(a.designation === 'warning' || a.designation === 'emergency')) continue;
      if (known.has(a.alertId) || announcedWarnings.has(a.alertId)) continue;
      announcedWarnings.add(a.alertId);
      announceNow(`New ${a.event} for ${nation.name}.`);
    }
  }

  /** Seeds the once-per-alert set from the first full paint, so existing warnings are not announced as new. */
  function seedAnnouncements() {
    if (!latest || !nation || firstPaintDone) return;
    for (const a of latest.alerts) if (a.nationIds.includes(nation.id) && a.posture === 'act-now') announcedWarnings.add(a.alertId);
  }

  async function refreshAlertPanels() {
    await Promise.all(alertPanels.map((p) => p.refresh()));
  }

  // ------------------------------------------------------------------------------------------------
  // Derived view data
  // ------------------------------------------------------------------------------------------------
  /** @returns {import('../types.js').AlertScope} */
  function bannerScope() {
    if (nation) return { kind: 'nation', nation };
    const js = /** @type {string[] | undefined} */ (url.j) ?? [];
    const jurisdictions = js.map((j) => /** @type {import('../types.js').Jurisdiction} */ (j.toUpperCase()));
    return jurisdictions.length > 0 ? { kind: 'footprint', jurisdictions } : { kind: 'footprint' };
  }
  function scopeName() {
    if (nation) return nation.name;
    const js = /** @type {string[] | undefined} */ (url.j) ?? [];
    if (js.length === 0) return 'Cascadia';
    return js.map((j) => listMod.REGION_OPTIONS.find((r) => r.value === j)?.label ?? j).join(', ');
  }
  /** Alerts for the banner and tiles: the selected Nation or jurisdictions, never the hazard or band filters. */
  function scopedAlerts() {
    const all = latest?.alerts ?? [];
    const scope = bannerScope();
    return svc.scopeFilter(all, scope);
  }
  function currentBanner(now = new Date()) {
    const scoped = scopedAlerts();
    const scope = bannerScope();
    const required = bannerMod.requiredSourcesFor(scope, { bcRfcActive: sourcesMod.isEnabled(RFC) });
    return { banner: bannerMod.summarizeForBanner(scoped, latest?.statuses ?? new Map(), required, now), required, scoped };
  }

  /** @param {string} message @param {string} [detail] */
  const noticeBlock = (message, detail) => h('div', { class: 'alert-banner alert-banner--unknown', role: 'group', 'data-alert-banner': '' },
    h('p', { class: 'alert-banner__headline' }, message),
    detail ? h('p', { class: 'alert-banner__detail' }, detail) : null,
    h('p', { class: 'alert-banner__actions' },
      h('a', { href: 'https://www.weather.gov/', target: '_blank', rel: 'noopener' }, 'weather.gov'), ' ',
      h('a', { href: 'https://weather.gc.ca/warnings/index_e.html?prov=bc', target: '_blank', rel: 'noopener' }, 'weather.gc.ca'), ' ', h('a', { href: telHref('911') }, 'Call Emergency Services'), '.'));

  /** @param {HTMLElement} body */
  function renderAlertsUnavailable(body) {
    const { banner, required } = currentBanner();
    // The body states no clock time as plain text (the footer carries the check time); a last-confirmed time,
    // when there is one, is a <time> element.
    const last = banner.kind === 'unknown' ? banner.lastConfirmedAt : null;
    const copy = bannerMod.bannerCopy({ kind: 'unknown', reason: banner.kind === 'unknown' ? banner.reason : 'unavailable', lastConfirmedAt: null }, { scopeName: scopeName(), timeZone: zoneOf(), requiredSourceIds: required });
    const block = noticeBlock(copy.headline, copy.detail ?? undefined);
    if (last) block.querySelector('.alert-banner__detail')?.append(' Last confirmed ', h('time', { datetime: last }, formatAsOf(last, zoneOf())), '.');
    body.append(block);
  }

  // ------------------------------------------------------------------------------------------------
  // Summary panel
  // ------------------------------------------------------------------------------------------------
  /** @param {HTMLElement} body */
  function renderSummary(body) {
    const now = new Date();
    const { banner, required, scoped } = currentBanner(now);
    const copy = bannerMod.bannerCopy(banner, { scopeName: scopeName(), timeZone: zoneOf(), requiredSourceIds: required, now });
    const kind = banner.kind;
    const wrap = h('div', { class: `alert-banner alert-banner--${kind}`, 'data-alert-banner': '', ...(banner.kind === 'act-now' || banner.kind === 'prepare' || banner.kind === 'monitor' ? { 'data-band': banner.top.band } : {}) },
      h('p', { class: 'alert-banner__headline' }, copy.headline),
      copy.detail ? h('p', { class: 'alert-banner__detail' }, copy.detail) : null);
    body.append(wrap);
    announce(0, [copy.headline, copy.detail].filter(Boolean).join(' '));

    const sums = listMod.summarizeByDesignation(scoped);
    const selected = new Set(/** @type {string[] | undefined} */ (url.des) ?? []);
    const unknown = kind === 'unknown';
    const tiles = listMod.DESIGNATION_OPTIONS.filter((d) => d.value !== 'other' || (sums.other?.count ?? 0) > 0).map((d) => {
      const row = sums[d.value] ?? { count: 0, bands: {} };
      const bands = listMod.BAND_OPTIONS.filter((b) => (row.bands[b.value] ?? 0) > 0).map((b) => `${row.bands[b.value]} ${b.label}`).join(', ');
      const button = /** @type {HTMLButtonElement} */ (h('button', {
        type: 'button',
        class: `summary-tile${unknown ? ' summary-tile--unknown' : row.count === 0 ? ' summary-tile--zero' : ''}`,
        'aria-pressed': String(selected.has(d.value)),
        'data-designation': d.value,
      },
      h('span', { class: 'summary-tile__value' }, unknown ? 'Unknown' : String(row.count)),
      h('span', { class: 'summary-tile__label' }, listMod.tileLabel(d.value, row.count)),
      !unknown && bands ? h('span', { class: 'caption' }, bands) : null));
      button.addEventListener('click', () => {
        const next = new Set(/** @type {string[] | undefined} */ (url.des) ?? []);
        if (next.has(d.value)) next.delete(d.value); else next.add(d.value);
        urlState.writeState({ des: listMod.DESIGNATION_OPTIONS.map((o) => o.value).filter((v) => next.has(v)) });
      });
      return h('li', {}, button);
    });
    body.append(h('ul', { class: 'summary-tiles', 'aria-label': 'Alert Counts by Designation' }, tiles));
  }

  // ------------------------------------------------------------------------------------------------
  // List panel and filter chips
  // ------------------------------------------------------------------------------------------------
  /** @type {Record<string, { set(values: string[]): void, setCounts(counts: Record<string, number> | null): void }>} */
  const chips = {};
  /** @type {HTMLElement | null} */
  let filtersHost = null;
  /** @type {HTMLElement | null} */
  let resultCount = null;
  let painted = false;

  function markPainted() {
    if (painted) return;
    painted = true;
    try { performance.mark('alerts-painted'); } catch { /* marks unavailable */ }
    resolvePainted();
  }
  /** @type {() => void} */
  let resolvePainted = () => {};
  const paintedPromise = new Promise((resolve) => { resolvePainted = () => resolve(undefined); });

  function buildFilters() {
    filtersHost = document.querySelector('[data-alert-filters]');
    if (!filtersHost) return;
    const host = filtersHost;
    clear(host);
    resultCount = h('p', { class: 'caption', 'data-result-count': '', role: 'status' });
    /** @type {{ key: string, label: string, options: readonly { value: string, label: string }[] }[]} */
    const groups = [
      { key: 'j', label: 'Jurisdiction', options: listMod.REGION_OPTIONS },
      { key: 'hz', label: 'Hazard', options: listMod.HAZARD_OPTIONS },
      { key: 'des', label: 'Designation', options: listMod.DESIGNATION_OPTIONS },
      { key: 'band', label: 'Band', options: listMod.BAND_OPTIONS },
      { key: 'posture', label: 'Posture', options: listMod.POSTURE_OPTIONS },
      { key: 'src', label: 'Source', options: listMod.SOURCE_OPTIONS },
    ];
    filterSummary = h('summary', {}, 'Filters');
    const panelEl = h('div', {});
    const details = h('details', { class: 'disclosure', 'data-filters-details': '' }, filterSummary, panelEl);
    if (activeFilterCount() > 0) details.setAttribute('open', '');
    for (const g of groups) {
      const el = h('div', {});
      panelEl.append(el);
      chips[g.key] = chipsMod.createFilterChips(el, {
        key: g.key, label: g.label, options: [...g.options], selected: /** @type {string[]} */ (url[g.key] ?? []),
        onChange: (values) => urlState.writeState({ [g.key]: values }),
      });
    }
    const nationEl = h('div', { 'data-nation-filter': '' });
    panelEl.append(nationEl);
    host.append(details, resultCount);
    chips.nationOnly = chipsMod.createFilterChips(nationEl, {
      key: 'only', label: 'Nation', options: [{ value: 'only', label: 'Only Alerts for the Selected Nation' }], selected: url.only === true ? ['only'] : [],
      onChange: (values) => urlState.writeState({ only: values.includes('only') }),
    });
    nationEl.hidden = true;
  }

  /** @type {HTMLElement | null} */
  let filterSummary = null;
  function activeFilterCount() {
    return listMod.ALERT_FILTER_KEYS.reduce((n, k) => n + (/** @type {string[] | undefined} */ (url[k])?.length ?? 0), 0) + (url.only === true ? 1 : 0);
  }

  function syncFilters() {
    const active = activeFilterCount();
    if (filterSummary) filterSummary.textContent = active > 0 ? `Filters (${active} active)` : 'Filters';
    for (const key of listMod.ALERT_FILTER_KEYS) chips[key]?.set(/** @type {string[]} */ (url[key] ?? []));
    chips.nationOnly?.set(url.only === true ? ['only'] : []);
    const nationEl = filtersHost?.querySelector('[data-nation-filter]');
    if (nationEl) /** @type {HTMLElement} */ (nationEl).hidden = !nation;
  }

  /**
   * @param {HTMLElement} body
   * @param {{ alerts: DashboardAlert[], statuses: Map<string, StatusSnapshot> }} data
   * @param {string | null} selectedId
   */
  function renderAlertCards(body, data, selectedId) {
    const ctx = { marineToRegion, nationId: nation?.id ?? null };
    const f = alertFilters();
    const scoped = data.alerts;
    let shown = listMod.filterAlerts(scoped, f, ctx);
    if (selectedId && !shown.some((a) => a.alertId === selectedId)) {
      const sel = data.alerts.find((a) => a.alertId === selectedId);
      if (sel) shown = [sel, ...shown];
    }
    for (const key of listMod.ALERT_FILTER_KEYS) chips[key]?.setCounts(listMod.countsFor(scoped, f, key, ctx));
    syncFilters();
    const { banner } = currentBanner();
    const filteredAway = scoped.length - shown.length;
    let empty = 'No alerts match these filters.';
    if (data.alerts.length === 0) {
      empty = banner.kind === 'none' ? bannerMod.bannerCopy(banner, { scopeName: scopeName(), timeZone: zoneOf() }).headline : 'No alerts could be listed. Alert status is unknown, and this is not an all-clear.';
    } else if (filteredAway > 0) {
      empty = `No alerts match these filters. ${filteredAway} ${filteredAway === 1 ? 'alert is' : 'alerts are'} hidden by them.`;
    }
    const countText = shown.length === scoped.length
      ? `${shown.length} ${shown.length === 1 ? 'alert' : 'alerts'} shown.`
      : `${shown.length} of ${scoped.length} alerts shown.`;
    if (resultCount) resultCount.textContent = countText;
    announce(1, countText);
    listMod.renderAlertList(body, shown, {
      timeZone: zoneOf(), groupBy: nation ? 'nation' : 'jurisdiction', nation, lang: langOf(), selectedId, statuses: data.statuses,
      emptyMessage: empty, onShowOnMap: showOnMap, loadText,
    });
    return shown;
  }

  /** @param {HTMLElement} body @param {{ alerts: DashboardAlert[], statuses: Map<string, StatusSnapshot> }} data */
  function renderList(body, data) {
    renderAlertCards(body, data, null);
    if (!firstPaintDone) { seedAnnouncements(); firstPaintDone = true; }
    markPainted();
  }

  /**
   * @param {string} id
   * @param {string[]} sourceIds
   * @param {string[]} relevant
   * @param {(body: HTMLElement, data: { alerts: DashboardAlert[], statuses: Map<string, StatusSnapshot> }) => void} render
   */
  function alertPanel(id, sourceIds, relevant, render) {
    const slot = panelSlot(id);
    if (!slot) return null;
    const panel = mountPanel(slot, {
      title: slot.querySelector('.panel__title')?.textContent ?? id,
      sourceIds,
      statusId: id,
      load: async () => {
        await whenData();
        const r = /** @type {LoadAllAlertsResult} */ (latest);
        return { data: { alerts: r.alerts, statuses: r.statuses }, status: listMod.combineStatuses(r.statuses, relevant, sourceIds, new Date()) };
      },
      render: (body, data) => render(body, /** @type {any} */ (data)),
      renderUnavailable: (body) => {
        if (id === 'alerts-summary') renderAlertsUnavailable(body);
        else body.append(h('p', { class: 'panel-note' }, 'The alert list is not available right now. Use the official sources linked below. In an emergency: ', h('a', { href: telHref('911') }, 'Call Emergency Services'), '.'));
        if (id === 'alerts-list') { if (resultCount) resultCount.textContent = 'The alert list is not available.'; markPainted(); }
      },
    });
    alertPanels.push(panel);
    return panel;
  }

  // ------------------------------------------------------------------------------------------------
  // British Columbia sections (candidate sources: hidden and unrequested while the flag is off)
  // ------------------------------------------------------------------------------------------------
  /** @param {string} panelId @param {string} sourceId */
  function mountBcPanel(panelId, sourceId) {
    const slot = panelSlot(panelId);
    if (!slot) return;
    // A candidate source (blueprint 3.7.2) with the flag off: its section is removed, nothing is requested.
    if (!sourcesMod.isEnabled(sourceId)) {
      slot.remove();
      return;
    }
    slot.hidden = false;
    const net = import('../core/net.js');
    const statusMod = import('../core/status.js');
    mountPanel(slot, {
      title: slot.querySelector('.panel__title')?.textContent ?? panelId,
      sourceIds: [sourceId],
      statusId: panelId,
      load: async (signal) => {
        const { fetchLocal } = await net;
        const { deriveStatus } = await statusMod;
        const res = await fetchLocal(BC_HAZARDS_FILE, { priority: 2, signal });
        const env = res.ok && res.data && typeof res.data === 'object' && Array.isArray((/** @type {any} */ (res.data)).items) ? /** @type {any} */ (res.data) : null;
        const facts = env?.perSource?.[sourceId];
        const usable = env && env.completeness !== 'rejected' && facts && typeof facts.asOf === 'string';
        const status = deriveStatus({
          sourceIds: [sourceId], policy: APP.freshness.alerts, now: new Date(),
          snapshot: usable ? { asOf: facts.asOf, asOfBasis: env.asOfBasis ?? 'retrieved', carriedForward: Boolean(env.carriedForward) } : null,
          unavailableReason: 'The scheduled copy of these notices is not available.',
        });
        const items = usable ? /** @type {import('../types.js').BcHazardItem[]} */ (env.items).filter((i) => i.sourceId === sourceId) : [];
        return { data: items, status };
      },
      render: (body, data) => {
        const items = /** @type {import('../types.js').BcHazardItem[]} */ (data);
        if (items.length === 0) { body.append(h('p', { class: 'panel-note' }, 'No notices are listed by this source right now. This is not a guarantee that none are in effect.')); return; }
        body.append(h('ul', { class: 'alert-list' }, items.map((i) => h('li', {}, cardMod.bcHazardCard(i, { timeZone: zoneOf() })))));
      },
    });
  }

  // ------------------------------------------------------------------------------------------------
  // Map view
  // ------------------------------------------------------------------------------------------------
  /** @type {Promise<CthdMap | null> | null} */
  let mapPromise = null;
  /** @type {HTMLElement | null} */
  let twin = null;
  /** @type {HTMLElement | null} */
  let mapNote = null;
  /** @type {{ refresh: () => Promise<void> } | null} */
  let mapPanelHandle = null;
  /** @type {CthdMap | null} */
  let mapInstance = null;
  /** @type {HTMLElement | null} */
  let isolationNote = null;
  /** @type {HTMLElement | null} */
  let pageLegend = null;
  /** @type {DashboardAlert[]} */
  let shownOnMap = [];
  let selectedAlertId = /** @type {string | null} */ (typeof url.alert === 'string' ? url.alert : null);

  function mountMapView() {
    if (mapPanelHandle) return;
    const slot = panelSlot('alerts-map');
    if (!slot) return;
    const frame = h('div', { class: 'map-frame', 'data-map-frame': '' },
      h('div', { class: 'map-frame__viewport', 'data-map-viewport': '' }),
      h('p', { class: 'sovereignty-note', 'data-premap-note': '' }, h('strong', {}, listMod.SOVEREIGNTY_HEADLINE), ' ', listMod.SOVEREIGNTY_BODY));
    const skip = h('a', { class: 'caption', href: '#alerts-map-twin' }, 'Skip the Map and Go to the Alert List');
    mapNote = h('p', { class: 'panel-note', 'data-map-note': '', role: 'status' }, 'Loading the map.');
    isolationNote = h('p', { class: 'panel-note', 'data-isolation-note': '', role: 'status' });
    isolationNote.hidden = true;
    const holder = h('div', { 'data-map-holder': '' }, skip, frame, mapNote, isolationNote);
    const body = slot.querySelector('[data-panel-body]');
    slot.insertBefore(holder, body);
    const sourceIds = MAP_SOURCES;
    mapPanelHandle = mountPanel(slot, {
      title: 'Alert Map',
      sourceIds,
      statusId: 'alerts-map',
      load: async () => {
        await whenData();
        const r = /** @type {LoadAllAlertsResult} */ (latest);
        return { data: { alerts: r.alerts, statuses: r.statuses }, status: listMod.combineStatuses(r.statuses, [NWS, ECCC], sourceIds, new Date()) };
      },
      render: (bodyEl, data) => {
        const d = /** @type {{ alerts: DashboardAlert[], statuses: Map<string, StatusSnapshot> }} */ (data);
        pageLegend = legend();
        pageLegend.hidden = mapHasOwnLegend();
        bodyEl.append(h('p', { class: 'caption', 'data-coverage-legend': '' }, listMod.COVERAGE_LEGEND), pageLegend);
        twin = h('div', { id: 'alerts-map-twin', tabindex: '-1', 'data-twin': '' });
        bodyEl.append(h('h3', {}, 'Alerts on This Map'), twin);
        const shown = renderAlertCards(twin, d, selectedAlertId);
        shownOnMap = shown;
        if (mapInstance) void pushToMap(mapInstance, shown);
        if (selectedAlertId) focusSelected();
      },
    });
    alertPanels.push(mapPanelHandle);
    void requestMapNow();
  }

  /** The map module draws its own legend inside the frame once it is up; the page legend then steps aside. */
  const mapHasOwnLegend = () => document.querySelector('[data-map-frame] .map-legend li') !== null;

  function legend() {
    /** @param {string} band @param {string} label */
    const bandItem = (band, label) => h('li', { class: 'legend__item', 'data-band': band }, h('span', { class: 'legend__swatch' }), label);
    return h('ul', { class: 'legend', 'aria-label': 'Map Legend' },
      h('li', { class: 'legend__item' }, h('span', { class: 'legend__swatch legend__swatch--zone' }), 'Forecast zone named in an alert (dashed)'),
      h('li', { class: 'legend__item' }, h('span', { class: 'legend__swatch', 'data-band': 'unstated' }), 'Area drawn by the forecaster (solid)'),
      bandItem('extreme', 'Extreme'), bandItem('severe', 'Severe'), bandItem('moderate', 'Moderate'), bandItem('minor', 'Minor'), bandItem('unstated', 'Unstated'),
      h('li', { class: 'legend__item' }, h('span', { class: 'legend__swatch legend__swatch--boundary' }), 'Tribal land area representation'));
  }

  /**
   * Sends alerts to the map with their polygons joined from `alerts-geometry.json`. The map is asked to focus
   * the selected alert when it can (`focusAlert`); otherwise the map shows that alert alone, says so, and
   * offers the whole set back.
   * @param {CthdMap} map
   * @param {DashboardAlert[]} alerts
   */
  async function pushToMap(map, alerts) {
    const geometry = await svc.loadAlertGeometry({ signal: abort.signal });
    const focusable = /** @type {any} */ (map);
    const canFocus = typeof focusable.focusAlert === 'function';
    const only = selectedAlertId && !canFocus ? alerts.filter((a) => a.alertId === selectedAlertId) : [];
    const drawn = only.length > 0 ? only : alerts;
    map.setAlerts(drawn.map((a) => (a.geometry === null && geometry?.has(a.alertId) ? { ...a, geometry: /** @type {any} */ (geometry.get(a.alertId)) } : a)));
    if (selectedAlertId && canFocus) focusable.focusAlert(selectedAlertId);
    if (isolationNote) {
      isolationNote.hidden = only.length === 0;
      if (only.length > 0) {
        const all = h('button', { type: 'button', class: 'btn btn--secondary' }, 'Show All Alerts on the Map');
        all.addEventListener('click', () => { selectedAlertId = null; urlState.writeState({ alert: undefined }); void pushToMap(map, shownOnMap); });
        isolationNote.replaceChildren(`The map shows only ${only[0]?.event ?? 'the selected alert'}. `, all);
      }
    }
    if (pageLegend) pageLegend.hidden = mapHasOwnLegend();
  }

  async function requestMapNow() {
    if (mapPromise) return mapPromise;
    mapPromise = (async () => {
      await paintedPromise;
      const viewport = document.querySelector('[data-map-viewport]');
      if (!(viewport instanceof HTMLElement)) return null;
      try {
        const adapter = await import('../map/adapter.js');
        const map = await Promise.race([
          adapter.requestMap(viewport, {
            sovereignty: { sourceIds: ['bia-lar', 'census-aiannh-2025', 'nrcan-aboriginal-lands-bc'] },
            label: 'Map of current alerts in Cascadia',
            layers: ['outlines', 'boundaries', 'zones', 'alerts'],
            mode: 'auto',
            onSelect: (sel) => { if (sel.kind === 'alert') { selectedAlertId = sel.id; urlState.writeState({ alert: sel.id }); focusSelected(); } },
          }),
          new Promise((_, reject) => { setTimeout(() => reject(new Error('The map did not answer in time')), APP.map.loadTimeoutMs + 10_000); }),
        ]);
        mapInstance = /** @type {CthdMap} */ (map);
        document.querySelector('[data-premap-note]')?.remove();
        if (mapNote) mapNote.hidden = true;
        await pushToMap(mapInstance, shownOnMap.length > 0 ? shownOnMap : listMod.filterAlerts(latest?.alerts ?? [], alertFilters(), { marineToRegion, nationId: nation?.id ?? null }));
        return mapInstance;
      } catch {
        if (mapNote) {
          mapNote.hidden = false;
          mapNote.replaceChildren('The map could not be loaded here right now. The list below shows the same alerts, and each alert names its area in text. ', retryButton());
        }
        mapPromise = null;
        return null;
      }
    })();
    return mapPromise;
  }

  function retryButton() {
    const b = h('button', { type: 'button', class: 'btn btn--secondary' }, 'Try Loading the Map Again');
    b.addEventListener('click', () => { if (mapNote) mapNote.textContent = 'Loading the map.'; void requestMapNow(); });
    return b;
  }

  function focusSelected() {
    if (!twin || !selectedAlertId) return;
    const card = listMod.focusAlertCard(twin, selectedAlertId);
    if (mapInstance && typeof (/** @type {any} */ (mapInstance)).focusAlert === 'function') (/** @type {any} */ (mapInstance)).focusAlert(selectedAlertId);
    if (card) announceNow(`Showing ${card.querySelector('.alert-card__title')?.textContent ?? 'the alert'} on the map.`);
  }

  /** @param {string} alertId */
  function showOnMap(alertId) {
    selectedAlertId = alertId;
    urlState.writeState({ view: 'map', alert: alertId }, { push: true });
    tabs?.select('map');
    activateView('map');
    void mapPanelHandle?.refresh().then(focusSelected);
  }

  // ------------------------------------------------------------------------------------------------
  // Declarations view
  // ------------------------------------------------------------------------------------------------
  /** @type {Promise<{ fema: FemaDeclaration[], curated: CuratedDeclaration[], statuses: Map<string, StatusSnapshot> }> | null} */
  let declLoad = null;
  /** @type {{ refresh: () => Promise<void> }[]} */
  const declPanels = [];
  /** @type {Record<string, { set(values: string[]): void }>} */
  const declChips = {};

  function loadDecls() {
    declLoad ??= (async () => {
      await nationsReady;
      const mod = await import('../declarations/service.js');
      return mod.loadDeclarations({ scope: nation ? { kind: 'nation', nation } : { kind: 'footprint' }, signal: abort.signal });
    })();
    return declLoad;
  }

  /** @returns {Map<string, string>} */
  const regionByNation = () => new Map(nationsIndex.map((n) => [n.id, n.region]));
  const nationName = (/** @type {string} */ id) => {
    const n = nationsIndex.find((x) => x.id === id);
    return n ? n.name : id;
  };

  /**
   * @param {FemaDeclaration} d
   * @returns {boolean}
   */
  function femaPasses(d) {
    const levels = /** @type {string[] | undefined} */ (url.level);
    if (levels && levels.length > 0 && !levels.includes('federal')) return false;
    const js = /** @type {string[] | undefined} */ (url.j);
    if (js && js.length > 0 && !(d.region && js.includes(d.region))) return false;
    const types = /** @type {string[] | undefined} */ (url.type);
    if (types && types.length > 0 && !types.includes(listMod.declarationTypeOf({ fema: d }))) return false;
    if (url.tribal === true && !d.tribalRequest) return false;
    return true;
  }
  /** @param {CuratedDeclaration} d @returns {boolean} */
  function curatedPasses(d) {
    const levels = /** @type {string[] | undefined} */ (url.level);
    if (levels && levels.length > 0 && !levels.includes(d.issuer.type)) return false;
    const js = /** @type {string[] | undefined} */ (url.j);
    if (js && js.length > 0) {
      const region = listMod.curatedRegion(d, regionByNation());
      if (region !== null && !js.includes(region)) return false;
    }
    const types = /** @type {string[] | undefined} */ (url.type);
    if (types && types.length > 0 && !types.includes(listMod.declarationTypeOf({ curated: d }))) return false;
    if (url.tribal === true && !(d.issuer.type === 'tribal' || d.issuer.type === 'first-nation')) return false;
    return true;
  }

  function buildDeclFilters() {
    const host = document.querySelector('[data-declaration-filters]');
    if (!(host instanceof HTMLElement) || host.childElementCount > 0) return;
    /** @type {{ key: string, label: string, options: { value: string, label: string }[] }[]} */
    const groups = [
      { key: 'j', label: 'Jurisdiction', options: [...listMod.REGION_OPTIONS.filter((r) => r.value !== 'marine')] },
      { key: 'level', label: 'Level', options: [{ value: 'federal', label: 'Federal' }, { value: 'tribal', label: 'Tribal Nation' }, { value: 'first-nation', label: 'First Nation' }, { value: 'state', label: 'State' }, { value: 'provincial', label: 'Province' }, { value: 'county', label: 'County' }, { value: 'regional-district', label: 'Regional District' }] },
      { key: 'type', label: 'Type', options: [{ value: 'dr', label: 'Major Disaster' }, { value: 'em', label: 'Emergency' }, { value: 'fm', label: 'Fire Management' }, { value: 'proclamation', label: 'Emergency Proclamation' }, { value: 'local', label: 'State of Local Emergency' }] },
      { key: 'tribal', label: 'Tribal', options: [{ value: 'tribal', label: 'Tribal Requests and Declarations' }] },
    ];
    for (const g of groups) {
      const el = h('div', {});
      host.append(el);
      declChips[g.key] = chipsMod.createFilterChips(el, {
        key: g.key, label: g.label, options: g.options,
        selected: g.key === 'tribal' ? (url.tribal === true ? ['tribal'] : []) : /** @type {string[]} */ (url[g.key] ?? []),
        onChange: (values) => urlState.writeState(g.key === 'tribal' ? { tribal: values.includes('tribal') } : { [g.key]: values }),
      });
    }
  }

  function mountDeclarations() {
    if (declPanels.length > 0) return;
    buildDeclFilters();
    const femaSlot = panelSlot('declarations-fema');
    const curatedSlot = panelSlot('declarations-curated');
    if (femaSlot) {
      declPanels.push(mountPanel(femaSlot, {
        title: 'Federal Declarations', sourceIds: [FEMA], statusId: 'declarations-fema',
        load: async () => { const r = await loadDecls(); return { data: r.fema, status: /** @type {StatusSnapshot} */ (r.statuses.get(FEMA)) }; },
        render: (body, data) => {
          const all = /** @type {FemaDeclaration[]} */ (data);
          const shown = all.filter(femaPasses);
          body.append(h('p', { class: 'caption' }, 'Declared by the President under the Stafford Act and listed by FEMA. A declaration is a record of an order, not a statement that an event is still under way.'));
          if (shown.length === 0) {
            body.append(h('p', { class: 'panel-note' }, all.length === 0
              ? 'FEMA lists no declarations for the footprint states in the last two years.'
              : `No federal declarations match these filters. ${all.length} ${all.length === 1 ? 'is' : 'are'} hidden by them.`));
            return;
          }
          const forNation = nation ? shown.filter((d) => d.nationIds.includes(/** @type {NationRecord} */ (nation).id)) : [];
          const rest = nation ? shown.filter((d) => !d.nationIds.includes(/** @type {NationRecord} */ (nation).id)) : shown;
          if (forNation.length > 0) body.append(h('h3', {}, 'For This Nation'), h('ul', { class: 'alert-list' }, forNation.map((d) => h('li', {}, cardMod.femaDeclarationCard(d, { nationNames: d.nationIds.map(nationName) })))));
          if (rest.length > 0) body.append(...(nation ? [h('h3', {}, 'Elsewhere in Cascadia')] : []), h('ul', { class: 'alert-list' }, rest.map((d) => h('li', {}, cardMod.femaDeclarationCard(d, { nationNames: d.nationIds.map(nationName) })))));
        },
      }));
    }
    if (curatedSlot) {
      declPanels.push(mountPanel(curatedSlot, {
        title: 'Tribal, State, and Provincial Declarations', sourceIds: [CURATED], statusId: 'declarations-curated',
        load: async () => { const r = await loadDecls(); return { data: r.curated, status: /** @type {StatusSnapshot} */ (r.statuses.get(CURATED)) }; },
        render: (body, data) => {
          const all = /** @type {CuratedDeclaration[]} */ (data);
          const shown = all.filter(curatedPasses).sort((a, b) => b.issuedOn.localeCompare(a.issuedOn));
          body.append(h('p', { class: 'caption' }, 'Each row was read from the issuing government or a report of the issuance. Status is worked out from the row\'s own dates when the page loads: a row counts as in effect only until its review date.'));
          if (shown.length === 0) {
            body.append(h('p', { class: 'panel-note' }, all.length === 0
              ? 'No Tribal, state, or provincial declarations are listed. This list is curated by hand and may not include every declaration.'
              : `No listed declarations match these filters. ${all.length} ${all.length === 1 ? 'is' : 'are'} hidden by them.`));
            return;
          }
          const mine = nation ? shown.filter((d) => d.issuer.nationId === /** @type {NationRecord} */ (nation).id) : [];
          const rest = nation ? shown.filter((d) => d.issuer.nationId !== /** @type {NationRecord} */ (nation).id) : shown;
          if (mine.length > 0) body.append(h('h3', {}, 'For This Nation'), h('ul', { class: 'alert-list' }, mine.map((d) => h('li', {}, cardMod.curatedDeclarationCard(d, { now: new Date() })))));
          if (rest.length > 0) body.append(...(nation ? [h('h3', {}, 'Elsewhere in Cascadia')] : []), h('ul', { class: 'alert-list' }, rest.map((d) => h('li', {}, cardMod.curatedDeclarationCard(d, { now: new Date() })))));
        },
      }));
    }
  }

  // ------------------------------------------------------------------------------------------------
  // Views and tabs
  // ------------------------------------------------------------------------------------------------
  /** @type {{ select(id: string): void } | null} */
  let tabs = null;
  /** @param {string} view */
  function activateView(view) {
    if (filtersHost) filtersHost.hidden = view === 'declarations';
    if (view === 'map') mountMapView();
    else if (view === 'declarations') mountDeclarations();
  }

  // ------------------------------------------------------------------------------------------------
  // Start
  // ------------------------------------------------------------------------------------------------
  void sourcesLoaded;
  // Panels of views that are not open yet carry their provenance footer from first paint (blueprint 3.3: every
  // panel names its source and states why no data time is shown); mountPanel reuses the footer when the view opens.
  for (const id of ['alerts-map', 'declarations-fema', 'declarations-curated']) {
    const slot = panelSlot(id);
    if (!slot || slot.querySelector('[data-provenance]')) continue;
    const ids = (slot.getAttribute('data-sources') ?? '').split(/\s+/).filter(Boolean);
    const footer = slot.appendChild(h('footer', { class: 'provenance', 'data-provenance': '' }));
    renderProvenance(footer, { state: 'unavailable', asOf: null, asOfBasis: null, detail: 'Not loaded yet. This view loads when it is opened.', sourceIds: ids, origin: 'direct', completeness: 'partial', checkedAt: new Date().toISOString() },
      ids.map((s) => sourcesMod.findSource(s)).filter((r) => r !== null && r !== undefined));
  }
  buildFilters();
  await nationsReady;
  marineToRegion = await marineToRegionP;
  alertPanel('alerts-summary', ALERT_SOURCES, ALERT_SOURCES, (body) => renderSummary(body));
  alertPanel('alerts-list', ALERT_SOURCES, ALERT_SOURCES, (body, data) => renderList(body, data));
  mountBcPanel('bc-evacuations', EMCR);
  mountBcPanel('bc-rfc', RFC);

  const tabRoot = document.querySelector('[data-tabs]');
  if (tabRoot instanceof HTMLElement) {
    for (const a of tabRoot.querySelectorAll('[data-view-link]')) {
      const link = /** @type {HTMLAnchorElement} */ (a);
      link.setAttribute('href', urlState.linkWithState(link.getAttribute('href') ?? './', ['n', 'embed', 'units', 'lowdata', 'lang', 'j']));
    }
    tabs = tabsMod.initTabs(tabRoot, { onChange: (id) => { urlState.writeState({ view: id }, { push: true }); activateView(id); } });
  }
  activateView(/** @type {string} */ (url.view ?? 'list'));

  urlState.onStateChange(() => {
    const prev = url;
    url = readUrl();
    if (url.view !== prev.view) { tabs?.select(/** @type {string} */ (url.view ?? 'list')); activateView(/** @type {string} */ (url.view ?? 'list')); }
    if (typeof url.alert === 'string' && url.alert !== selectedAlertId) { selectedAlertId = url.alert; }
    syncFilters();
    for (const [key, chip] of Object.entries(declChips)) chip.set(key === 'tribal' ? (url.tribal === true ? ['tribal'] : []) : /** @type {string[]} */ (url[key] ?? []));
    void refreshAlertPanels();
    void Promise.all(declPanels.map((p) => p.refresh()));
  });

  void startLoading();
  addEventListener('pagehide', () => abort.abort(), { once: true });
}

if (typeof document !== 'undefined' && document.body?.dataset.page === PAGE) {
  void main();
}
