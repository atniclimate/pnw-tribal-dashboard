// @ts-check
/**
 * Panel renderers for the forecasts page (blueprint 7.3). DOM module. Data reaches the DOM only through h();
 * every readout is printed as text, and an absent value is shown as absence, never as zero.
 */
import { APP } from '../config/app.js';
import { clear, h } from '../core/dom.js';
import { deriveStatus } from '../core/status.js';
import { formatAsOf } from '../core/time.js';
import { formatTemperature } from '../core/units.js';
import { initDisclosure } from './disclosure.js';
import { qpfBars, amountText, probabilityText } from './charts/bars.js';
import { cityForecastLabel } from '../forecast/eccc-citypage.js';
import { FORECAST_LABEL } from '../forecast/nws-forecast.js';

/** @typedef {import('../types.js').StatusSnapshot} StatusSnapshot */
/** @typedef {import('../types.js').ForecastPeriod} ForecastPeriod */
/** @typedef {import('../types.js').QpfDay} QpfDay */

/** Shown by every Nation-dependent panel when no Nation is chosen. */
export const NO_NATION = 'No Nation is selected. Choose a Nation above to see its forecast for its headquarters.';

const COMPASS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];

/**
 * An unavailable status that names its reason.
 * @param {string[]} sourceIds
 * @param {string} reason
 * @param {Date} [now]
 * @returns {StatusSnapshot}
 */
export function unavailableStatus(sourceIds, reason, now = new Date()) {
  return deriveStatus({ sourceIds, policy: APP.freshness.forecasts, now, unavailableReason: reason });
}

/**
 * @param {number} degrees
 * @returns {string} 16-point compass name
 */
export function compass(degrees) {
  return /** @type {string} */ (COMPASS[Math.round((((degrees % 360) + 360) % 360) / 22.5) % 16]);
}

/**
 * @param {number} kmh
 * @param {'us' | 'metric' | 'native'} system
 * @returns {string}
 */
function windText(kmh, system) {
  return system === 'us' ? `${Math.round(kmh * 0.621371)} mph` : `${Math.round(kmh)} km/h`;
}

/**
 * @param {import('../forecast/observation.js').Observation} obs
 * @param {{ timeZone: string, system: 'us' | 'metric' | 'native' }} ctx
 * @returns {HTMLElement}
 */
export function renderObservation(obs, ctx) {
  const wind = obs.windKmh === null ? null : obs.windKmh === 0 ? 'Calm' : `Wind ${obs.windDirectionDeg === null ? '' : `${compass(obs.windDirectionDeg)} `}${windText(obs.windKmh, ctx.system)}${obs.windGustKmh === null ? '' : `, gusts ${windText(obs.windGustKmh, ctx.system)}`}`;
  return h('section', { class: 'forecast-current', 'aria-labelledby': 'current-conditions-h' },
    h('h3', { id: 'current-conditions-h' }, 'Current Conditions'),
    h('p', { class: 'readout' }, formatTemperature(obs.temperatureC, 'C', ctx.system === 'native' ? 'metric' : ctx.system)),
    h('p', {}, [obs.description, wind, obs.humidityPercent === null ? null : `Humidity ${Math.round(obs.humidityPercent)}%`].filter(Boolean).join('. ')),
    h('p', { class: 'stamp' },
      'Observed ', h('time', { datetime: obs.observedAt }, formatAsOf(obs.observedAt, ctx.timeZone)),
      ` at ${obs.stationName}${obs.distanceKm === null ? '' : `, ${Math.round(obs.distanceKm)} km from headquarters`}. A station observation, not a forecast.`));
}

/**
 * @param {ForecastPeriod[]} periods
 * @param {{ system: 'us' | 'metric' | 'native' }} ctx
 * @returns {HTMLElement}
 */
export function renderPeriods(periods, ctx) {
  const rows = periods.map((p) => h('tr', {},
    h('th', { scope: 'row' }, p.name),
    h('td', {}, p.temperature === null ? 'No temperature' : formatTemperature(p.temperature, p.temperatureUnit, ctx.system)),
    h('td', {}, p.probabilityOfPrecipitation === null ? 'No probability' : `${p.probabilityOfPrecipitation}%`),
    h('td', {}, [p.windDirection, p.windSpeed].filter(Boolean).join(' ') || 'No wind'),
    h('td', {}, p.detailedForecast || p.shortForecast)));
  return h('div', { class: 'table-wrap', tabindex: 0, role: 'region', 'aria-label': '7-Day Forecast table' }, h('table', { 'data-forecast-periods': '' },
    h('caption', {}, FORECAST_LABEL),
    h('thead', {}, h('tr', {}, ['Period', 'Temperature', 'Chance of Precipitation', 'Wind', 'Forecast'].map((t) => h('th', { scope: 'col' }, t)))),
    h('tbody', {}, rows)));
}

/**
 * @param {HTMLElement} body
 * @param {{ nation: { name: string, timeZone: string }, office: string | null, periods: ForecastPeriod[],
 *   observation: import('../forecast/observation.js').Observation | null, system: 'us' | 'metric' | 'native' }} d
 * @returns {void}
 */
export function renderLocalUs(body, d) {
  clear(body);
  const ctx = { timeZone: d.nation.timeZone, system: d.system };
  body.append(h('p', { class: 'panel-note' }, `Forecast for the headquarters point of ${d.nation.name}${d.office ? `, from the National Weather Service ${d.office} office` : ''}.`));
  body.append(d.observation
    ? renderObservation(d.observation, ctx)
    : h('p', { class: 'panel-note', 'data-no-observation': '' }, 'No current observation is available from the stations near this headquarters. The forecast periods below are forecasts, not observations.'));
  body.append(d.periods.length > 0 ? renderPeriods(d.periods, ctx) : h('p', { class: 'panel-unavailable' }, 'The National Weather Service returned no forecast periods.'));
}

/**
 * @param {HTMLElement} body
 * @param {{ nation: { name: string }, city: { name: string, lastUpdated: string | null, periods: { name: string, summary: string }[] }, distanceKm: number | null, pageUrl: string | null }} d
 * @returns {void}
 */
export function renderLocalBc(body, d) {
  clear(body);
  body.append(h('p', { class: 'panel-note' }, d.distanceKm === null ? `Forecast for ${d.city.name}.` : cityForecastLabel(d.city.name, d.distanceKm, d.nation.name)));
  body.append(h('div', { class: 'table-wrap', tabindex: 0, role: 'region', 'aria-label': '7-Day Forecast table' }, h('table', { 'data-forecast-periods': '' },
    h('caption', {}, FORECAST_LABEL),
    h('thead', {}, h('tr', {}, h('th', { scope: 'col' }, 'Period'), h('th', { scope: 'col' }, 'Forecast'))),
    h('tbody', {}, d.city.periods.map((p) => h('tr', {}, h('th', { scope: 'row' }, p.name), h('td', {}, p.summary)))))));
  body.append(h('p', { class: 'panel-note' }, 'Forecast text is shown as published by Environment and Climate Change Canada, without changes. ',
    d.pageUrl ? h('a', { href: d.pageUrl, rel: 'noopener' }, 'Open this forecast at Environment and Climate Change Canada') : null));
  body.append(h('p', { class: 'panel-note' }, 'Daily precipitation bars are not drawn for British Columbia, because no verified source supplies them. The Environment and Climate Change Canada forecast above is the reference.'));
}

/**
 * @param {HTMLElement} body
 * @param {{ days: QpfDay[], timeZone: string, updateTime: string }} d
 * @param {'us' | 'metric' | 'native'} system
 * @returns {void}
 */
export function renderQpf(body, d, system) {
  clear(body);
  body.append(qpfBars(d.days, { system }));
  body.append(h('p', { class: 'caption' }, `Bars show the forecast total for each day in ${d.timeZone} time. The percentage under each day is the highest chance of precipitation in any forecast period that day. A dashed bar is a partial day.`));
  const rows = d.days.map((day) => h('tr', {},
    h('th', { scope: 'row' }, `${day.label} (${day.dayKey})${day.partial ? ', partial day' : ''}`),
    h('td', {}, amountText(day, system)),
    h('td', {}, probabilityText(day))));
  const button = /** @type {HTMLButtonElement} */ (h('button', { type: 'button', class: 'disclosure__button' }, 'Daily Precipitation as Text'));
  const region = h('div', { class: 'table-wrap', tabindex: 0, role: 'region', 'aria-label': 'Daily precipitation table' }, h('table', {},
    h('caption', {}, 'Daily precipitation forecast'),
    h('thead', {}, h('tr', {}, h('th', { scope: 'col' }, 'Day'), h('th', { scope: 'col' }, 'Total'), h('th', { scope: 'col' }, 'Chance'))),
    h('tbody', {}, rows)));
  body.append(button, region);
  initDisclosure(button, region);
}

/**
 * AFD text as paragraphs: blank lines separate blocks, single line breaks reflow. Wording is untouched.
 * @param {string} text
 * @returns {string[]}
 */
export function afdParagraphs(text) {
  return text.replace(/\r/g, '').split(/\n\s*\n/).map((b) => b.split('\n').map((l) => l.trim()).filter(Boolean).join(' ')).filter(Boolean);
}

/**
 * Collapsed by default.
 * @param {HTMLElement} body
 * @param {{ text: string, issuedAt: string | null, office: string | null, wfo: string }} d
 * @param {string} timeZone
 * @returns {void}
 */
export function renderAfd(body, d, timeZone) {
  clear(body);
  const when = d.issuedAt ? formatAsOf(d.issuedAt, timeZone) : null;
  const button = /** @type {HTMLButtonElement} */ (h('button', { type: 'button', class: 'disclosure__button', 'data-afd-toggle': '' }, `Read the Forecaster's Discussion${d.office ? ` from ${d.office}` : ''}${when ? `, issued ${when}` : ''}`));
  const region = h('div', { 'data-afd-text': '' },
    afdParagraphs(d.text).map((p) => h('p', {}, p)),
    h('p', { class: 'panel-note' }, 'Plain text from the National Weather Service; line breaks are reflowed for reading. ',
      h('a', { href: `https://forecast.weather.gov/product.php?site=${encodeURIComponent(d.wfo)}&issuedby=${encodeURIComponent(d.wfo)}&product=AFD`, rel: 'noopener' }, 'Open the original product')));
  body.append(button, region);
  initDisclosure(button, region);
}

/**
 * A short message with the official link, for panels that have no data to show.
 * @param {HTMLElement} body
 * @param {StatusSnapshot} status
 * @param {{ label: string, url: string }[]} links
 * @returns {void}
 */
export function renderUnavailable(body, status, links) {
  clear(body);
  // The official links are in the provenance footer, which always names and links every source.
  void links;
  body.append(h('p', { class: 'panel-unavailable' }, status.detail ?? 'No data is available right now.'));
}
