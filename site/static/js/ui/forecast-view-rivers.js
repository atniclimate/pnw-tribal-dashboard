// @ts-check
/**
 * Rivers view of the forecasts page (blueprint 7.3): the gauge list and gauge detail composed from the L7
 * components, and the British Columbia River Forecast Centre advisories. Loaded on first use by
 * pages/forecasts.js (a dynamic import). DOM module.
 */
import { normalizeRfcAdvisories } from '../bc/rfc-advisories.js';
import { clear, h } from '../core/dom.js';
import { getData } from '../core/sources.js';
import { loadGauges, nearbyGauges } from '../hydro/gauges-service.js';
import { renderGaugeDetail } from './gauge-detail.js';
import { renderGaugeList } from './gauge-list.js';

let showAllGauges = false;
let atOrAbove = false;

/** @type {import('./forecast-views.js').ViewPanels} */
export const panels = {
  'rivers-gauges': {
    async load(ctx, signal) {
      const n = await ctx.nationReady();
      const g = await loadGauges({ nation: n?.record ?? null, signal });
      return { data: g.gauges.length > 0 ? { ...g, nation: n } : null, status: g.status };
    },
    render(body, data, _status, ctx) {
      const tz = data.nation?.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
      const draw = () => {
        const selected = ctx.state().g;
        clear(body);
        if (typeof selected === 'string') {
          const gauge = data.gauges.find((/** @type {any} */ x) => x.id === selected);
          if (gauge) {
            const back = h('a', { class: 'btn btn--link', href: '?view=rivers' }, 'Back to the Gauge List');
            back.addEventListener('click', (e) => { e.preventDefault(); ctx.writeState({ g: undefined }); draw(); });
            const detail = h('div', {});
            body.append(back, detail);
            renderGaugeDetail(detail, gauge, data.statuses.get(gauge.id) ?? null, { timeZone: tz });
            return;
          }
        }
        const nearby = data.nation ? nearbyGauges(data.nation.record, data.gauges) : [];
        const useNearby = Boolean(data.nation) && nearby.length > 0 && !showAllGauges;
        const list = useNearby ? nearby : data.gauges;
        const controls = h('div', { class: 'filter-chips' });
        const toggle = h('button', { type: 'button', class: 'filter-chip', 'aria-pressed': String(atOrAbove) }, 'At or Above Action Stage');
        toggle.addEventListener('click', () => { atOrAbove = !atOrAbove; draw(); });
        controls.append(toggle);
        if (data.nation && nearby.length > 0) {
          const all = h('button', { type: 'button', class: 'filter-chip', 'aria-pressed': String(showAllGauges) }, 'Show All Gauges');
          all.addEventListener('click', () => { showAllGauges = !showAllGauges; draw(); });
          controls.append(all);
        }
        body.append(h('p', { class: 'panel-note' }, useNearby ? `Gauges near ${data.nation.name} headquarters. These are nearby gauges, not an assessment of what affects the Nation.` : 'Gauges grouped by region.'), controls);
        const holder = h('div', {});
        body.append(holder);
        renderGaugeList(holder, list, data.statuses, {
          timeZone: tz, atOrAboveAction: atOrAbove,
          onSelect: (id) => { ctx.writeState({ g: id }, { push: true }); draw(); },
        });
      };
      draw();
    },
  },

  'rivers-bc-rfc': {
    async load(_ctx, signal) {
      const res = await getData('bc-rfc-flood-advisories', { where: '1=1', outFields: '*', f: 'geojson' }, { signal });
      if (!res.data) return { data: null, status: res.status };
      const d = /** @type {any} */ (res.data);
      const items = Array.isArray(d.items) ? d.items.filter((/** @type {any} */ i) => i.kind === 'flood-advisory') : normalizeRfcAdvisories(d, { fetchedAt: new Date().toISOString(), ratified: false }).items;
      return { data: { items }, status: res.status };
    },
    render(body, data) {
      clear(body);
      if (data.items.length === 0) { body.append(h('p', {}, 'The BC River Forecast Centre lists no advisories, watches, or warnings in this copy.')); return; }
      body.append(h('ul', {}, data.items.map((/** @type {any} */ i) => h('li', {}, i.title))));
    },
  },
};
