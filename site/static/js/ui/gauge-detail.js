// @ts-check
/**
 * Gauge detail with stage table, hydrograph image, alt text, and a text table (blueprint 7.3). DOM module.
 *
 * Owner: lane L7. The category shown is the NWS's own; null thresholds read "Not defined", never "normal".
 * The hydrograph image carries alt text naming the latest and crest values and is followed by the same values
 * as a text table. British Columbia stations show level and discharge with the threshold note and no category.
 */

import { clear, h } from '../core/dom.js';
import { formatAsOf } from '../core/time.js';
import { categoryLabel, observedDisplay } from '../hydro/flood-category.js';
import { hydrographText } from '../hydro/nwps.js';
import { WSC_THRESHOLD_NOTE } from '../hydro/wsc.js';
import { floodToken, readingText } from './gauge-list.js';

/** @typedef {import('../types.js').Gauge} Gauge */
/** @typedef {import('../types.js').GaugeStatus} GaugeStatus */

/** The NWPS hydrograph PNG is 600 by 465 pixels. */
export const HYDROGRAPH_SIZE = Object.freeze({ width: 600, height: 465 });

const LINK_LABELS = /** @type {Record<string, string>} */ ({
  nwps: 'NWPS Gauge Page (National Water Prediction Service)',
  usgs: 'USGS Monitoring Location Page',
  wateroffice: 'Water Survey of Canada Station Page',
});
const STAGE_ROWS = /** @type {[string, 'action' | 'minor' | 'moderate' | 'major'][]} */ ([
  ['Action Stage', 'action'], ['Minor Flood Stage', 'minor'], ['Moderate Flood Stage', 'moderate'], ['Major Flood Stage', 'major'],
]);

/**
 * Pure view model for tests and the DOM renderer.
 * @param {Gauge} gauge
 * @param {GaugeStatus | null} status
 * @param {{ timeZone: string, now?: Date }} opts
 */
export function buildGaugeDetailModel(gauge, status, opts) {
  const now = opts.now ?? new Date();
  const display = observedDisplay(status, now);
  const obs = status?.observed ?? null;
  const fc = status?.forecast ?? null;
  const isWsc = gauge.agency === 'WSC';
  const stages = gauge.stages;
  const stageRows = STAGE_ROWS.map(([label, key]) => ({
    label,
    value: stages && stages[key] !== null && stages[key] !== undefined ? `${stages[key]} ${stages.unit}` : 'Not defined',
  }));
  const hydro = hydrographText(gauge, status);
  const when = (/** @type {string | null | undefined} */ t) => (t ? formatAsOf(t, opts.timeZone) : null);
  return {
    isWsc,
    display,
    observed: { reading: readingText(status), time: when(obs?.validTime) },
    forecastCategory: !isWsc && fc?.category ? categoryLabel(fc.category) : null,
    crest: fc && fc.crestStage !== null && fc.crestStage !== undefined
      ? { text: `${fc.crestStage} ${fc.unit ?? ''}`.trim(), time: when(fc.crestTime) }
      : null,
    stageRows,
    stageSource: stages ? { sourceId: stages.sourceId, retrieved: when(stages.retrievedAt)?.split(' ')[0] ?? null } : null,
    thresholdNote: isWsc ? WSC_THRESHOLD_NOTE : null,
    alt: hydro.alt,
    tableRows: [
      { label: 'Latest Observed Stage', value: hydro.rows[0]?.value ?? '', time: when(obs?.validTime) },
      { label: 'Forecast Crest', value: hydro.rows[1]?.value ?? '', time: when(fc?.crestTime) },
    ],
  };
}

/**
 * @param {HTMLElement} el
 * @param {Gauge} gauge
 * @param {GaugeStatus | null} status
 * @param {{ timeZone: string }} opts
 * @returns {void}
 */
export function renderGaugeDetail(el, gauge, status, opts) {
  const m = buildGaugeDetailModel(gauge, status, opts);
  clear(el);
  el.classList.add('gauge-detail');
  const agency = gauge.agency === 'NWS' ? 'National Weather Service, National Water Prediction Service' : 'Water Survey of Canada';
  const ids = [gauge.lid ? `NWS ${gauge.lid}` : null, gauge.usgsId ? `USGS ${gauge.usgsId}` : null, gauge.wscId ? `WSC ${gauge.wscId}` : null].filter(Boolean).join('; ');

  const header = h('header', { class: 'gauge-detail__header' },
    h('h3', {}, gauge.name),
    h('p', { class: 'gauge-card__stamp' }, [gauge.river, agency, ids].filter(Boolean).join('. ')));

  const latest = h('section', { class: `gauge-card${m.display.current ? '' : ' gauge-card--not-current'}`, 'data-flood': floodToken(m.isWsc ? null : m.display.category), 'aria-label': 'Latest Observation' },
    h('h4', { class: 'gauge-card__name' }, 'Latest Observation'),
    h('span', { class: 'gauge-card__reading' }, m.observed.reading),
    h('span', { class: 'gauge-card__category' }, m.isWsc ? 'No official flood category for this station' : m.display.label),
    h('span', { class: 'gauge-card__stamp' }, m.observed.time ? `Observed ${m.observed.time}` : 'No observation time'),
    m.forecastCategory ? h('span', { class: 'gauge-card__stamp' }, `Forecast category: ${m.forecastCategory}`) : null,
    gauge.isForecastPoint
      ? h('span', { class: 'gauge-card__stamp' }, m.crest ? `Forecast crest ${m.crest.text}${m.crest.time ? ` at ${m.crest.time}` : ''}` : 'No forecast crest published')
      : null);

  const stageTable = m.isWsc
    ? h('p', { class: 'gauge-detail__note' }, m.thresholdNote ?? 'No official flood thresholds are published for this station.')
    : h('section', { class: 'gauge-detail__stages' },
      h('h4', {}, 'Flood Stages'),
      h('table', {},
        h('thead', {}, h('tr', {}, h('th', { scope: 'col' }, 'Category'), h('th', { scope: 'col' }, 'Stage'))),
        h('tbody', {}, m.stageRows.map((r) => h('tr', {}, h('th', { scope: 'row' }, r.label), h('td', {}, r.value))))),
      h('p', { class: 'gauge-card__stamp' }, m.stageSource
        ? `Source: ${agency}${m.stageSource.retrieved ? `; retrieved ${m.stageSource.retrieved}` : ''}. Not defined means the agency publishes no value at that level.`
        : 'No flood stage table is published for this gauge.'));

  /** @type {HTMLElement[]} */
  const hydro = [];
  if (gauge.hydrographImage) {
    hydro.push(h('section', { class: 'gauge-detail__hydrograph' },
      h('h4', {}, 'Hydrograph'),
      h('img', { src: gauge.hydrographImage, alt: m.alt, width: HYDROGRAPH_SIZE.width, height: HYDROGRAPH_SIZE.height, loading: 'lazy', decoding: 'async' }),
      h('table', {},
        h('caption', {}, 'Hydrograph Values as Text'),
        h('thead', {}, h('tr', {}, h('th', { scope: 'col' }, 'Value'), h('th', { scope: 'col' }, 'Reading'), h('th', { scope: 'col' }, 'Time'))),
        h('tbody', {}, m.tableRows.map((r) => h('tr', {}, h('th', { scope: 'row' }, r.label), h('td', {}, r.value), h('td', {}, r.time ?? 'Not available')))))));
  }

  const links = Object.entries(gauge.links ?? {}).filter(([k]) => LINK_LABELS[k]);
  const linkList = links.length
    ? h('ul', { class: 'gauge-detail__links' }, links.map(([k, href]) => h('li', {}, h('a', { href, rel: 'noopener' }, LINK_LABELS[k]))))
    : null;

  el.append(header, latest, stageTable, ...hydro);
  if (linkList) el.append(linkList);
}
