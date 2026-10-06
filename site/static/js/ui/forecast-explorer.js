// @ts-check
import { clear, h } from '../core/dom.js';
import { formatAsOf, zonedDayKey } from '../core/time.js';
import { formatTemperature } from '../core/units.js';
import { renderTimeSeries } from './charts/time-series.js';
import { amountText, probabilityText } from './charts/bars.js';

/** @typedef {{ state?: () => import('../types.js').UrlState, onChange?: (patch: import('../types.js').UrlState) => void }} ForecastControls */
/** @typedef {import('../types.js').ForecastPeriod} ForecastPeriod */
/** @typedef {import('../types.js').QpfDay} QpfDay */

/** @param {HTMLElement} parent @param {string} label @param {[string,string][]} values @param {string} value @param {(value: string) => void} change */
function select(parent, label, values, value, change) {
  const input = /** @type {HTMLSelectElement} */ (h('select', { 'aria-label': label }, values.map(([v, text]) => h('option', { value: v, selected: v === value }, text))));
  input.addEventListener('change', () => { const scope = parent.parentElement; change(input.value); /** @type {HTMLElement | null} */ (scope?.querySelector(`select[aria-label="${CSS.escape(label)}"]`))?.focus(); });
  parent.append(h('label', {}, label, input));
}
/** @param {ForecastPeriod} p @param {'us' | 'metric' | 'native'} system */
function temperature(p, system) {
  if (p.temperature === null) return null;
  if (system === 'metric' && p.temperatureUnit === 'F') return (p.temperature - 32) * 5 / 9;
  if (system === 'us' && p.temperatureUnit === 'C') return p.temperature * 9 / 5 + 32;
  return p.temperature;
}

/** @param {HTMLElement} host @param {ForecastPeriod[]} periods @param {{ timeZone: string, system: 'us' | 'metric' | 'native' }} data @param {ForecastControls} [opts] */
export function renderForecastExplorer(host, periods, data, opts = {}) {
  const state = opts.state?.() ?? {};
  let system = data.system; let range = state.range === '3' ? '3' : '7';
  let selectedTime = typeof state.period === 'string' ? state.period : '';
  if (!periods.some((p) => p.startTime === selectedTime)) selectedTime = periods.find((p) => zonedDayKey(new Date(p.startTime), data.timeZone) === state.day)?.startTime ?? periods[0]?.startTime ?? '';
  const draw = () => {
    clear(host);
    const days = [...new Set(periods.map((p) => zonedDayKey(new Date(p.startTime), data.timeZone)))].slice(0, Number(range));
    const shown = range === '7' ? periods : periods.filter((p) => days.includes(zonedDayKey(new Date(p.startTime), data.timeZone)));
    if (!shown.some((p) => p.startTime === selectedTime)) selectedTime = shown[0]?.startTime ?? '';
    const controls = h('div', { class: 'chart-controls' });
    select(controls, 'Forecast Time Range', [['3', 'Next Three Days'], ['7', 'Full Seven-Day Outlook']], range, (value) => { range = value; opts.onChange?.({ range }); draw(); });
    select(controls, 'Forecast Units', [['us', 'Fahrenheit / Inches'], ['metric', 'Celsius / Millimetres']], system === 'metric' ? 'metric' : 'us', (value) => { system = value === 'metric' ? 'metric' : 'us'; opts.onChange?.({ units: system }); draw(); });
    const cards = h('div', { class: 'forecast-periods', 'aria-label': 'Choose a Forecast Period' });
    const detail = h('section', { class: 'forecast-selected', 'aria-live': 'polite', 'data-forecast-selected': '' });
    const chart = h('div', { class: 'forecast-chart-panel' });
    /** @param {ForecastPeriod} period @param {boolean} [notify] */
    const choose = (period, notify = true) => {
      selectedTime = period.startTime;
      for (const button of cards.querySelectorAll('button')) button.setAttribute('aria-pressed', String(button.dataset.period === selectedTime));
      clear(detail);
      detail.append(h('h3', {}, period.name), h('p', { class: 'readout' }, formatTemperature(period.temperature, period.temperatureUnit, system)),
        h('p', {}, period.detailedForecast || period.shortForecast),
        h('p', { class: 'stamp' }, `${formatAsOf(period.startTime, data.timeZone)} to ${formatAsOf(period.endTime, data.timeZone)}`),
        h('p', {}, `${period.probabilityOfPrecipitation === null ? 'Precipitation chance not supplied' : `${period.probabilityOfPrecipitation}% chance of precipitation`}. Wind: ${[period.windDirection, period.windSpeed].filter(Boolean).join(' ') || 'not supplied'}.`));
      if (notify) opts.onChange?.({ period: selectedTime, day: zonedDayKey(new Date(selectedTime), data.timeZone) });
    };
    for (const period of shown) {
      const button = h('button', { type: 'button', class: 'forecast-period', 'aria-pressed': String(period.startTime === selectedTime), 'data-period': period.startTime }, h('strong', {}, period.name), h('span', { class: 'forecast-period__value' }, formatTemperature(period.temperature, period.temperatureUnit, system)), h('span', {}, period.shortForecast));
      button.addEventListener('click', () => { choose(period); drawChart(); }); cards.append(button);
    }
    const drawChart = () => renderTimeSeries(chart, { title: 'Forecast Period Temperature', unit: system === 'metric' ? '°C' : '°F', timeZone: data.timeZone, discrete: true,
      lines: [true, false].map((daytime) => ({ name: daytime ? 'Daytime Forecast' : 'Nighttime Forecast', kind: 'forecast', marker: daytime ? 'circle' : 'square', points: shown.filter((p) => p.isDaytime === daytime).map((p) => ({ time: p.startTime, value: temperature(p, system), label: `${p.name}, ${formatAsOf(p.startTime, data.timeZone)}`, detail: p.shortForecast })) })), selectedTime,
      onSelect: (point) => { const period = shown.find((p) => p.startTime === point.time); if (period) choose(period); } });
    host.append(controls, h('p', { class: 'chart-legend' }, h('span', { class: 'chart-legend__day' }, 'Circle: Daytime Forecast'), h('span', { class: 'chart-legend__night' }, 'Square: Nighttime Forecast')), chart, cards, detail);
    const selected = shown.find((p) => p.startTime === selectedTime); if (selected) choose(selected, false);
    drawChart();
  };
  draw();
}

/** @param {HTMLElement} host @param {{ days: QpfDay[], timeZone: string, updateTime: string }} data @param {'us' | 'metric' | 'native'} initialSystem @param {ForecastControls} [opts] */
export function renderQpfExplorer(host, data, initialSystem, opts = {}) {
  const initial = opts.state?.() ?? {};
  let system = initialSystem; let range = initial.range === '3' ? '3' : '7';
  let day = typeof initial.day === 'string' ? initial.day : data.days[0]?.dayKey ?? '';
  const draw = () => {
    clear(host);
    const days = data.days.slice(0, Number(range));
    if (!days.some((d) => d.dayKey === day)) day = days[0]?.dayKey ?? '';
    const controls = h('div', { class: 'chart-controls' });
    select(controls, 'Precipitation Time Range', [['3', 'Next Three Days'], ['7', 'Full Seven-Day Outlook']], range, (value) => { range = value; opts.onChange?.({ range }); draw(); });
    select(controls, 'Precipitation Units', [['us', 'Inches'], ['metric', 'Millimetres']], system === 'us' ? 'us' : 'metric', (value) => { system = value === 'metric' ? 'metric' : 'us'; opts.onChange?.({ units: system }); draw(); });
    select(controls, 'Inspect Forecast Day', days.map((d) => [d.dayKey, `${d.label} ${d.dayKey}`]), day, (value) => { day = value; opts.onChange?.({ day, period: undefined }); draw(); });
    const chart = h('div'); host.append(controls, chart);
    renderTimeSeries(chart, { title: 'Daily Forecast Precipitation', unit: system === 'us' ? 'in' : 'mm', timeZone: data.timeZone, zeroFloor: true, bars: true, selectedTime: `${day}T12:00:00Z`, lines: [{ name: 'Forecast Total', kind: 'forecast', points: days.map((d) => ({ time: `${d.dayKey}T12:00:00Z`, value: system === 'us' ? d.amountIn : d.amountMm, label: `${d.label} (${d.dayKey})`, detail: `${amountText(d, system)}, ${probabilityText(d)}${d.partial ? ', partial day' : ''}` })) }], onSelect: (point) => { day = point.time.slice(0, 10); const input = controls.querySelector('select[aria-label="Inspect Forecast Day"]'); if (input instanceof HTMLSelectElement) input.value = day; opts.onChange?.({ day, period: undefined }); } });
    host.append(h('p', { class: 'caption' }, `Each total covers its labelled calendar day in ${data.timeZone}. Partial days are identified in the readout and table. Probability is the highest chance during that day, not an amount of rain.`), h('p', { class: 'stamp' }, data.updateTime ? `NWS grid forecast updated ${formatAsOf(data.updateTime, data.timeZone)}.` : 'The source did not supply a forecast issue time.'));
  };
  draw();
}
