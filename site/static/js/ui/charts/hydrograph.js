// @ts-check
import { h, clear } from '../../core/dom.js';
import { formatAsOf } from '../../core/time.js';
import { onStateChange } from '../../core/url-state.js';
import { loadRiverHistory, riverValue } from '../../hydro/nwps-series.js';
import { loadWscHistory } from '../../hydro/wsc-series.js';
import { renderTimeSeries } from './time-series.js';

/** @typedef {{ timeZone: string, system?: 'us' | 'metric' | 'native', signal?: AbortSignal, state?: () => import('../../types.js').UrlState, onChange?: (patch: import('../../types.js').UrlState) => void }} HydrographOptions */

/** @param {HTMLElement} host @param {import('../../types.js').Gauge} gauge @param {HydrographOptions} opts @returns {() => void} */
export function mountHydrograph(host, gauge, opts) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  opts.signal?.addEventListener('abort', abort, { once: true });
  let disposed = false;
  const isWsc = gauge.agency === 'WSC';
  /** @type {import('../../hydro/nwps-series.js').RiverHistory | null} */
  let history = null;
  /** @type {import('../../types.js').StatusSnapshot | null} */
  let status = null;
  const initial = opts.state?.() ?? {};
  let range = typeof initial.grange === 'string' ? initial.grange : '72';
  let metric = initial.gmetric === 'secondary' ? 'secondary' : 'primary';
  let system = opts.system === 'native' ? isWsc ? 'metric' : 'us' : opts.system ?? (isWsc ? 'metric' : 'us');
  let writing = false;
  /** @param {import('../../types.js').UrlState} patch */
  const write = (patch) => { writing = true; opts.onChange?.(patch); writing = false; };
  const draw = () => {
    clear(host);
    host.append(h('h4', {}, isWsc ? 'Observed Water Level and Discharge' : 'Observed and Forecast River Levels'));
    if (!history || !status) return;
    host.append(h('p', { class: 'stamp', 'data-river-status': status.state }, `${isWsc ? 'Environment and Climate Change Canada, Water Survey of Canada' : 'NOAA National Water Prediction Service'}. ${status.state.charAt(0).toUpperCase() + status.state.slice(1)}${status.asOf ? `; as of ${formatAsOf(status.asOf, opts.timeZone)}` : ''}.`));
    if (status.detail) host.append(h('p', { class: 'panel-note' }, status.detail));
    const observations = history.observed; const forecast = history.forecast;
    if (!observations.samples.length && !forecast.samples.length) {
      host.append(h('p', { class: 'panel-unavailable' }, status.detail ?? 'The source supplies no usable observed or forecast time series for this gauge. The latest snapshot and official gauge page remain available.'), retryButton()); return;
    }
    const controls = h('div', { class: 'chart-controls' });
    /** @param {string} label @param {[string,string][]} items @param {string} value @param {(value:string)=>void} change */
    const select = (label, items, value, change) => {
      const input = /** @type {HTMLSelectElement} */ (h('select', { 'aria-label': label }, items.map(([v, name]) => h('option', { value: v, selected: v === value }, name))));
      input.addEventListener('change', () => { change(input.value); draw(); /** @type {HTMLElement | null} */ (host.querySelector(`select[aria-label="${CSS.escape(label)}"]`))?.focus(); }); controls.append(h('label', {}, label, input));
    };
    if (isWsc && range === '168') range = '72';
    select('Observed History', isWsc ? [['24', 'Past Day'], ['72', 'Past Three Days']] : [['24', 'Past Day'], ['72', 'Past Three Days'], ['168', 'Past Week'], ['all', 'All Available']], isWsc && range === 'all' ? '72' : range, (value) => { range = value; write({ grange: value }); });
    const source = observations.samples.length ? observations : forecast;
    if ((source.secondaryName && source.secondaryUnit) && [...observations.samples, ...forecast.samples].some((p) => p.secondary !== null)) {
      select('Measurement', [['primary', source.primaryName || 'Primary Reading'], ['secondary', source.secondaryName]], metric, (value) => { metric = value; write({ gmetric: value }); });
    } else metric = 'primary';
    select('River Units', [['us', 'US Units'], ['metric', 'Metric']], system === 'metric' ? 'metric' : 'us', (value) => { system = value === 'metric' ? 'metric' : 'us'; write({ units: system }); });
    controls.append(retryButton()); host.append(controls);
    const unitKey = metric === 'primary' ? 'primaryUnit' : 'secondaryUnit';
    const nameKey = metric === 'primary' ? 'primaryName' : 'secondaryName';
    const field = metric === 'primary' ? 'primary' : 'secondary';
    const unit = riverValue(0, source[unitKey], system).unit;
    const latest = observations.samples.at(-1);
    const anchor = latest ? Date.parse(latest.time) : Date.now();
    const start = range === 'all' ? -Infinity : anchor - Number(range) * 3_600_000;
    /** @type {import('./time-series.js').ChartLine[]} */
    const lines = [observations, forecast].map((series) => ({
      name: series.kind === 'observed' ? 'Observed' : 'Forecast', kind: series.kind,
      points: series.samples.filter((p) => series.kind === 'forecast' || Date.parse(p.time) >= start).map((p) => {
        const raw = p[field]; const converted = raw === null ? null : riverValue(raw, series[unitKey], system);
        return { time: p.time, value: converted?.unit === unit ? converted.value : null };
      }),
    }));
    /** @type {import('./time-series.js').ChartThreshold[]} */
    const thresholds = [];
    if (source[nameKey].toLowerCase() === 'stage' && gauge.stages) {
      for (const key of /** @type {const} */ (['action', 'minor', 'moderate', 'major'])) {
        const raw = gauge.stages[key];
        if (raw === null || raw === undefined) continue;
        const converted = riverValue(raw, gauge.stages.unit, system);
        if (converted.unit === unit) thresholds.push({ label: `${key[0]?.toUpperCase()}${key.slice(1)}`, value: converted.value, flood: key });
      }
    }
    host.append(h('p', { class: 'chart-legend' }, h('span', { class: 'chart-legend__observed' }, 'Solid: Observed'), forecast.samples.length ? h('span', { class: 'chart-legend__forecast' }, 'Dashed: Forecast') : null));
    const chart = h('div'); host.append(chart);
    renderTimeSeries(chart, { title: `${gauge.name}: ${source[nameKey] || 'River Reading'}`, unit, timeZone: opts.timeZone, lines, thresholds, maxGapMs: 12 * 3_600_000, ...(latest ? { selectedTime: latest.time } : {}) });
    if (!observations.samples.length) host.append(h('p', { class: 'panel-note' }, 'Observation history is unavailable. Only published forecast values are shown.'));
    if (!forecast.samples.length) host.append(h('p', { class: 'panel-note' }, 'No forecast time series is published for this gauge. Only observed readings are shown.'));
    if (forecast.issuedTime) host.append(h('p', { class: 'stamp' }, `Forecast issued ${formatAsOf(forecast.issuedTime, opts.timeZone)}.`));
    host.append(h('p', { class: 'panel-note' }, isWsc ? 'Provisional, unreviewed Water Survey of Canada readings from the past three days. No official flood thresholds or river forecasts are supplied by this collection. No flood category is inferred. Contains information licensed under the Open Government Licence, Canada.' : 'Only the history returned by NWPS is available. Flood lines use this gauge’s published thresholds; the graph does not determine an official flood category.'));
  };
  const retryButton = () => { const button = h('button', { type: 'button', class: 'btn btn--secondary' }, 'Refresh River Data'); button.addEventListener('click', () => { void load(true); }); return button; };
  /** @param {boolean} retry */
  async function load(retry) {
    clear(host); host.append(h('p', { role: 'status' }, 'Loading observed and forecast river readings…'));
    try {
      const result = isWsc ? await loadWscHistory(gauge.wscId ?? '', { signal: controller.signal, retry }) : await loadRiverHistory(gauge.lid ?? '', { signal: controller.signal, retry });
      if (disposed || controller.signal.aborted) return;
      history = result.history; status = result.status;
      if (history) draw(); else { clear(host); host.append(h('p', { class: 'panel-unavailable' }, status.detail ?? 'River history is unavailable. The latest snapshot and official gauge page remain available.'), retryButton()); }
    } catch (error) {
      if (disposed || controller.signal.aborted) return;
      clear(host); host.append(h('p', { class: 'panel-unavailable' }, `River history is unavailable: ${error instanceof Error ? error.message : 'The source could not be read'}.`), retryButton());
    }
  }
  const unsubscribe = onStateChange(() => {
    if (writing || !opts.state) return;
    const state = opts.state();
    const nextRange = typeof state.grange === 'string' ? state.grange : '72';
    const nextMetric = state.gmetric === 'secondary' ? 'secondary' : 'primary';
    const nextSystem = state.units === 'metric' ? 'metric' : state.units === 'us' ? 'us' : opts.system === 'native' ? isWsc ? 'metric' : 'us' : opts.system ?? (isWsc ? 'metric' : 'us');
    if (nextRange === range && nextMetric === metric && nextSystem === system) return;
    range = nextRange; metric = nextMetric; system = nextSystem;
    if (history) draw();
  });
  void load(false);
  return () => { disposed = true; controller.abort(); unsubscribe(); opts.signal?.removeEventListener('abort', abort); };
}
