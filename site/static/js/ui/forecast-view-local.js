// @ts-check
/**
 * Local view of the forecasts page (blueprint 7.3): point forecast with Current Conditions, daily precipitation
 * bars, and the Forecaster's Discussion; for British Columbia the city page forecast. Loaded on first use by
 * pages/forecasts.js (a dynamic import), so it is outside the page's static graph. DOM module.
 */
import { loadLatestAfd } from '../forecast/afd.js';
import { findNearestCityPage, loadCityPage, normalizeCityPage } from '../forecast/eccc-citypage.js';
import { loadQpf } from '../forecast/gridpoint-qpf.js';
import { loadPoint, loadPointForecast } from '../forecast/nws-forecast.js';
import { loadCurrentObservation } from '../forecast/observation.js';
import { onStateChange } from '../core/url-state.js';
import { NO_NATION, renderAfd, renderLocalBc, renderLocalUs, renderQpf, unavailableStatus } from './forecast-panels.js';

/** @typedef {import('../types.js').StatusSnapshot} StatusSnapshot */

/**
 * The forecast grid for the Nation's headquarters, asked for once per Nation (the request itself is also held
 * in memory for an hour by core/net.js).
 * @param {import('./forecast-views.js').ViewContext} ctx
 * @param {AbortSignal} signal
 */
async function pointFor(ctx, signal) {
  const nation = ctx.nation();
  if (!nation) return null;
  // core/net owns the TTL cache. Retaining a signal-bound promise here can give
  // the next Nation selection an aborted request from an earlier render.
  return loadPoint(nation.hq, { signal });
}

/** Keep the sibling forecast and precipitation controls synchronized without replacing the focused control. */
/** @param {import('./forecast-views.js').ViewContext} ctx @param {(controls: import('./forecast-explorer.js').ForecastControls) => void} draw */
function connectedControls(ctx, draw) {
  let writing = false;
  const key = () => { const s = ctx.state(); return [s.units, s.range, s.day, s.period].join('|'); };
  let previous = key();
  const controls = { state: ctx.state, onChange: (/** @type {import('../types.js').UrlState} */ patch) => { writing = true; ctx.writeState(patch); previous = key(); writing = false; } };
  draw(controls);
  return onStateChange(() => { const next = key(); if (next !== previous) { previous = next; if (!writing) draw(controls); } });
}

/** @type {import('./forecast-views.js').ViewPanels} */
export const panels = {
  'forecast-local': {
    async load(ctx, signal) {
      const n = await ctx.nationReady();
      const ids = ['nws-forecast', 'eccc-citypage-realtime'];
      if (!n) return { data: null, status: unavailableStatus(ids, NO_NATION) };
      if (n.country === 'CA') {
        /** @type {{ feature: unknown, distanceKm: number | null, status: StatusSnapshot }} */
        let found;
        if (n.eccc?.citypageId) {
          const r = await loadCityPage(n.eccc.citypageId, { signal });
          found = { feature: r.data, distanceKm: n.eccc.distanceKm ?? null, status: r.status };
        } else {
          const r = await findNearestCityPage(n.hq, { signal });
          found = { feature: r.feature, distanceKm: r.distanceKm, status: r.status };
        }
        if (!found.feature) return { data: null, status: found.status };
        const city = normalizeCityPage(found.feature);
        return { data: { kind: 'bc', nation: n, city, distanceKm: found.distanceKm, pageUrl: /** @type {any} */ (found.feature)?.properties?.url?.en ?? null }, status: found.status };
      }
      const f = await loadPointForecast(n.hq, { signal });
      if (f.status.state === 'unavailable') return { data: null, status: f.status };
      const obs = f.point ? await loadCurrentObservation(f.point, n.hq, { signal }) : { observation: null };
      return { data: { kind: 'us', nation: n, office: f.office, periods: f.periods, observation: obs.observation, system: ctx.system() }, status: f.status };
    },
    render(body, data, _status, ctx) {
      if (data.kind === 'bc') return connectedControls(ctx, (controls) => renderLocalBc(body, { ...data, system: ctx.system() }, controls));
      else return connectedControls(ctx, (controls) => renderLocalUs(body, { ...data, system: ctx.system() }, controls));
    },
  },

  'forecast-qpf': {
    async load(ctx, signal) {
      const n = await ctx.nationReady();
      if (!n) return { data: null, status: unavailableStatus(['nws-gridpoints'], NO_NATION) };
      if (n.country === 'CA') return { data: null, status: unavailableStatus(['nws-gridpoints'], 'Daily precipitation bars are not drawn for British Columbia, because no verified source supplies them. The Environment and Climate Change Canada forecast above is the reference.') };
      const p = await pointFor(ctx, signal);
      if (!p?.point) return { data: null, status: p?.status ?? unavailableStatus(['nws-gridpoints'], 'The forecast grid could not be found.') };
      const r = await loadQpf(p.point, n.timeZone, { signal });
      if (r.state.state !== 'ready') return { data: null, status: r.status.state === 'unavailable' ? r.status : unavailableStatus(['nws-gridpoints'], r.state.state === 'error' ? r.state.message : 'No precipitation data.') };
      return { data: { ...r.state, system: ctx.system() }, status: r.status };
    },
    render(body, data, _status, ctx) { return connectedControls(ctx, (controls) => renderQpf(body, data, ctx.system(), controls)); },
  },

  'forecast-afd': {
    async load(ctx, signal) {
      const n = await ctx.nationReady();
      if (!n) return { data: null, status: unavailableStatus(['nws-afd'], NO_NATION) };
      if (n.country === 'CA') return { data: null, status: unavailableStatus(['nws-afd'], 'Area Forecast Discussions are a National Weather Service product and do not cover British Columbia.') };
      const p = await pointFor(ctx, signal);
      if (!p?.point) return { data: null, status: p?.status ?? unavailableStatus(['nws-afd'], 'The forecast office could not be found.') };
      const r = await loadLatestAfd(p.point.wfo, { signal });
      if (!r.text) return { data: null, status: r.status.state === 'unavailable' ? r.status : unavailableStatus(['nws-afd'], 'The office published no discussion text.') };
      return { data: { text: r.text, issuedAt: r.issuedAt, office: r.office, wfo: p.point.wfo, timeZone: n.timeZone }, status: r.status };
    },
    render(body, data) { renderAfd(body, data, data.timeZone); },
  },
};
