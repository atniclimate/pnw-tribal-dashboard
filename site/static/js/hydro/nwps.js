// @ts-check
/**
 * NWPS gauges; the NWS flood category is displayed, never a self-computed one (blueprint 5.5). DOM-free.
 *
 * Owner: lane L7. Pure functions only: no fetch, no DOM, no clock (callers pass `now`).
 */

/** @typedef {import('../types.js').Gauge} Gauge */
/** @typedef {import('../types.js').GaugeStatus} GaugeStatus */
/** @typedef {import('../types.js').FloodCategory} FloodCategory */

import { url as sourceUrl } from '../core/sources.js';

/** Footprint states and their region codes. */
export const STATE_REGIONS = Object.freeze({ WA: 'wa', OR: 'or', ID: 'id' });

const FLOOD_CATEGORIES = new Set(['no_flooding', 'action', 'minor', 'moderate', 'major', 'not_defined']);
const STAGE_UNITS = new Set(['ft', 'm']);

/**
 * NWPS reports "no value" as -999 (readings) and -9999 (thresholds). A real zero is a reading.
 * @param {unknown} value
 * @returns {number | null}
 */
export function cleanNumber(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  if (value === -999 || value === -9999 || value <= -990) return null;
  return value;
}

/**
 * The 0001-01-01 time NWPS sends with an empty reading is no time at all.
 * @param {unknown} value
 * @returns {string | null}
 */
export function cleanTime(value) {
  if (typeof value !== 'string' || value === '') return null;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms) || ms < Date.UTC(1990, 0, 1)) return null;
  return value;
}

/**
 * The NWS category word as published; "not current" markers and unknown words carry no category.
 * @param {unknown} raw
 * @param {boolean} allowOutOfService
 * @returns {FloodCategory | 'out_of_service' | null}
 */
function cleanCategory(raw, allowOutOfService) {
  if (typeof raw !== 'string') return null;
  if (raw === 'out_of_service') return allowOutOfService ? 'out_of_service' : null;
  return FLOOD_CATEGORIES.has(raw) ? /** @type {FloodCategory} */ (raw) : null;
}

/**
 * Splits a primary or secondary reading into stage or flow by its unit.
 * @param {Record<string, unknown> | null | undefined} block
 * @returns {{ stage: number | null, unit: string | null, flow: number | null, flowUnit: string | null }}
 */
function splitReadings(block) {
  /** @type {{ stage: number | null, unit: string | null, flow: number | null, flowUnit: string | null }} */
  const out = { stage: null, unit: null, flow: null, flowUnit: null };
  if (!block) return out;
  for (const [valueKey = '', unitKey = ''] of [['primary', 'primaryUnit'], ['secondary', 'secondaryUnit']]) {
    const unit = typeof block[unitKey] === 'string' ? /** @type {string} */ (block[unitKey]) : '';
    const value = cleanNumber(block[valueKey]);
    if (STAGE_UNITS.has(unit)) {
      if (out.stage === null && value !== null) { out.stage = value; out.unit = unit; }
    } else if (unit !== '') {
      if (out.flow === null && value !== null) { out.flow = value; out.flowUnit = unit; }
    }
  }
  return out;
}

/**
 * Sentinels (-999, -9999) become null; out_of_service kept.
 * @param {unknown} json
 * @param {{ fetchedAt: string, now: Date }} ctx
 * @returns {GaugeStatus[]}
 */
export function normalizeNwpsGaugeList(json, ctx) {
  const list = json && typeof json === 'object' ? /** @type {{ gauges?: unknown }} */ (json).gauges : null;
  if (!Array.isArray(list)) throw new Error('NWPS gauge list: "gauges" array missing');
  /** @type {GaugeStatus[]} */
  const out = [];
  for (const g of list) {
    if (!g || typeof g !== 'object' || typeof g.lid !== 'string' || !/^[A-Za-z0-9]{5}$/.test(g.lid)) continue;
    const status = g.status ?? {};
    const o = status.observed;
    const f = status.forecast;
    const obsRead = splitReadings(o);
    const observed = o
      ? {
          stage: obsRead.stage, unit: obsRead.unit, flow: obsRead.flow, flowUnit: obsRead.flowUnit,
          category: cleanCategory(o.floodCategory, true), validTime: cleanTime(o.validTime),
        }
      : null;
    const fcRead = splitReadings(f);
    const fcValid = cleanTime(f?.validTime);
    const fcCategory = /** @type {FloodCategory | null} */ (cleanCategory(f?.floodCategory, false));
    const hasForecast = f && (fcRead.stage !== null || fcRead.flow !== null || fcCategory !== null);
    out.push({
      id: `nwps:${g.lid.toUpperCase()}`,
      observed,
      forecast: hasForecast
        ? { stage: fcRead.stage, unit: fcRead.unit, category: fcCategory, validTime: fcValid, crestStage: null, crestTime: null }
        : null,
    });
  }
  return out;
}

/**
 * NWPS time zone abbreviations to IANA names (state-aware for the Mountain zone).
 * @param {unknown} nwpsZone
 * @param {string | null} state two-letter state
 * @returns {string}
 */
export function ianaTimeZone(nwpsZone, state) {
  switch (nwpsZone) {
    case 'PST8PDT': return 'America/Los_Angeles';
    case 'MST7MDT': return state === 'ID' ? 'America/Boise' : 'America/Denver';
    case 'MST': return 'America/Phoenix';
    case 'CST6CDT': return 'America/Chicago';
    case 'AKST9AKDT': return 'America/Anchorage';
    default: return state === 'ID' ? 'America/Boise' : 'America/Los_Angeles';
  }
}

/**
 * "Skagit River near Mt Vernon" gives "Skagit River"; null when the name has no river part to split off.
 * @param {string} name
 * @returns {string | null}
 */
export function riverFromName(name) {
  const m = /^(.+?)\s+(?:near|at|below|above|nr|abv|blw|bl|ab|downstream of|upstream of)\s+/i.exec(name);
  return m && m[1] ? m[1].trim() : null;
}

/**
 * Thresholds copied verbatim; nulls stay null.
 * @param {unknown} json
 * `ctx.templates` supply the link and image patterns (`{lid}`, `{usgsId}`) from the reference build, which owns
 * the human-page hosts; with none, links stay empty and the image is null (pages call hydrographImageUrl).
 * @param {{ retrievedAt: string, templates?: { hydrograph?: string, nwps?: string, usgs?: string } }} ctx
 * @returns {Gauge}
 */
export function normalizeNwpsGauge(json, ctx) {
  const g = /** @type {Record<string, any>} */ (json);
  if (!g || typeof g !== 'object' || typeof g.lid !== 'string' || !/^[A-Za-z0-9]{5}$/.test(g.lid)) {
    throw new Error('NWPS gauge: lid missing or malformed');
  }
  const lid = g.lid.toUpperCase();
  const state = typeof g.state?.abbreviation === 'string' ? g.state.abbreviation : null;
  const region = state && Object.prototype.hasOwnProperty.call(STATE_REGIONS, state)
    ? /** @type {import('../types.js').RegionCode} */ (STATE_REGIONS[/** @type {'WA' | 'OR' | 'ID'} */ (state)])
    : null;
  if (!region) throw new Error(`NWPS gauge ${lid}: state "${String(state)}" is outside the footprint`);
  const lat = cleanNumber(g.latitude);
  const lon = cleanNumber(g.longitude);
  if (lat === null || lon === null) throw new Error(`NWPS gauge ${lid}: coordinates missing`);
  const usgsId = typeof g.usgsId === 'string' && /^[0-9]{8,15}$/.test(g.usgsId) ? g.usgsId : null;
  const unit = g.flood?.stageUnits;
  const cats = g.flood?.categories ?? {};
  const stageOf = (/** @type {string} */ k) => cleanNumber(cats[k]?.stage);
  const stages = STAGE_UNITS.has(unit)
    ? {
        unit: /** @type {'ft' | 'm'} */ (unit), basis: /** @type {'stage'} */ ('stage'),
        action: stageOf('action'), minor: stageOf('minor'), moderate: stageOf('moderate'), major: stageOf('major'),
        sourceId: 'nwps-gauges', retrievedAt: ctx.retrievedAt.slice(0, 10),
      }
    : null;
  const t = ctx.templates ?? {};
  /** @type {Record<string, string>} */
  const links = {};
  if (t.nwps) links.nwps = t.nwps.replace('{lid}', lid.toLowerCase());
  if (usgsId && t.usgs) links.usgs = t.usgs.replace('{usgsId}', usgsId);
  const name = String(g.name ?? '').trim();
  return {
    id: `nwps:${lid}`,
    country: 'US',
    agency: 'NWS',
    lid,
    usgsId,
    wscId: null,
    name,
    river: riverFromName(name),
    region,
    wfo: typeof g.wfo?.abbreviation === 'string' && g.wfo.abbreviation ? g.wfo.abbreviation : null,
    rfc: typeof g.rfc?.abbreviation === 'string' && g.rfc.abbreviation ? g.rfc.abbreviation : null,
    lat,
    lon,
    timeZone: ianaTimeZone(g.timeZone, state),
    stages,
    isForecastPoint: typeof g.pedts?.forecast === 'string' && g.pedts.forecast !== '',
    hydrographImage: t.hydrograph ? hydrographImageUrl(lid, t.hydrograph) : null,
    links,
    nationIds: [],
    selection: 'auto',
  };
}

/**
 * The hydrograph image for a lid, from the registry template of nwps-hydrograph-images (or an explicit template,
 * which the reference build passes so it runs without a loaded registry).
 * @param {string} lid
 * @param {string} [template] a pattern with a {lid} placeholder
 * @returns {string}
 */
export function hydrographImageUrl(lid, template) {
  if (typeof lid !== 'string' || !/^[A-Za-z0-9]{5}$/.test(lid)) throw new Error(`invalid NWPS lid "${String(lid)}"`);
  const id = lid.toLowerCase();
  return template ? template.replace('{lid}', id) : sourceUrl('nwps-hydrograph-images', { lid: id });
}

/**
 * Alt text and a text table for the hydrograph image: latest and crest values, never decorative.
 * Times print in UTC here; the panel adds the Nation's zone through core/time.
 * @param {Gauge} gauge
 * @param {GaugeStatus | null | undefined} status
 * @returns {{ alt: string, rows: { label: string, value: string, time: string | null }[] }}
 */
export function hydrographText(gauge, status) {
  const obs = status?.observed ?? null;
  const fc = status?.forecast ?? null;
  const stamp = (/** @type {string | null | undefined} */ t) => (t ? `${t.slice(0, 10)} ${t.slice(11, 16)} UTC` : null);
  const reading = (/** @type {number | null | undefined} */ v, /** @type {string | null | undefined} */ u) =>
    v === null || v === undefined ? 'No current reading' : `${v} ${u ?? ''}`.trim();
  const latest = reading(obs?.stage, obs?.unit);
  const crest = reading(fc?.crestStage, fc?.unit);
  const rows = [
    { label: 'Latest Observed Stage', value: latest, time: stamp(obs?.validTime) },
    { label: 'Forecast Crest', value: fc?.crestStage === null || fc?.crestStage === undefined ? 'No forecast crest published' : crest,
      time: stamp(fc?.crestTime) },
  ];
  const latestPhrase = obs?.stage === null || obs?.stage === undefined
    ? 'no current observed stage'
    : `latest observed stage ${latest}${obs.validTime ? ` at ${stamp(obs.validTime)}` : ''}`;
  const crestPhrase = fc?.crestStage === null || fc?.crestStage === undefined
    ? 'no forecast crest published'
    : `forecast crest ${crest}${fc.crestTime ? ` at ${stamp(fc.crestTime)}` : ''}`;
  return { alt: `Hydrograph for ${gauge.name} (${gauge.lid ?? gauge.id}): ${latestPhrase}; ${crestPhrase}.`, rows };
}
