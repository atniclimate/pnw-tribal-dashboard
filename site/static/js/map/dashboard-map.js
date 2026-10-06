// @ts-check
/** Dashboard map shell, loaded only after alerts paint. */
import { h } from '../core/dom.js';
/**
 * @param {(id: string, spec: Omit<import('../types.js').PanelSpec, 'sourceIds' | 'statusId' | 'title'>) => import('../types.js').PanelHandle | null} panel
 * @param {NonNullable<import('../types.js').CreateMapOptions['onSelect']>} onSelect
 * @param {AbortSignal} signal
 * @returns {Promise<import('../types.js').CthdMap | null>}
 */
export async function mountDashboardMap(panel, onSelect, signal) {
  /** @param {string[]} ids @param {string} detail @returns {import('../types.js').StatusSnapshot} */
  const unavailable = (ids, detail) => ({ state: 'unavailable', asOf: null, asOfBasis: null, sourceIds: ids, origin: 'snapshot', completeness: 'partial', checkedAt: new Date().toISOString(), detail });
    const target = h('div', { class: 'dashboard-map' });
    // Map controls and attribution are siblings of its canvas frame. Keep the whole
    // mounted map together when the panel refreshes its provenance footer.
    const mapHost = h('div', { class: 'dashboard-map-host' }, target);
    const message = h('p', { class: 'caption', role: 'status' }, 'Loading the interactive map and public reference geography.');
    const retry = /** @type {HTMLButtonElement} */ (h('button', { class: 'btn btn--secondary', type: 'button', hidden: true }, 'Reload to Retry Map'));
    const render = (/** @type {HTMLElement} */ body) => body.append(message, retry, mapHost);
    let status = unavailable(['cthd-registry'], 'Reference geography is loading. Current conditions have separate layer statuses.');
    const handle = panel('map', { load: async () => ({ data: true, status }), render, renderUnavailable: render });
    // Browsers retain rejected module imports for the document lifetime.
    retry.addEventListener('click', () => location.reload());
      try {
        const { requestMap } = await import('./adapter.js');
        const loaded = await requestMap(target, { label: 'Cascadia Hazard Map', controls: true,
          sovereignty: { sourceIds: ['bia-lar', 'census-aiannh-2025', 'nrcan-aboriginal-lands-bc'] },
          layers: ['outlines', 'hq', 'boundaries', 'alerts', 'zones', 'gauges', 'radar'],
          mode: 'auto',
          onSelect });
        if (signal.aborted) { loaded.destroy(); return null; }
        const syncMapMode = () => {
          if (loaded.mode !== 'outline') return;
          status = unavailable(['census-aiannh-2025', 'nrcan-aboriginal-lands-bc'], 'Outline reference map displayed. Source geometry dates are not available. Interactive weather layers are not loaded in this mode.');
          void handle?.refresh();
        };
        loaded.onModeChange(syncMapMode);
        syncMapMode();
        loaded.onLayerStatus?.((id, snapshot) => {
          if (id !== 'hq') return;
          status = { ...snapshot, detail: snapshot.state === 'unavailable' ? snapshot.detail ?? 'Nation locations could not load.'
            : 'Reference geography loaded. This date describes the Nation registry. Current conditions have separate layer statuses and source times.' };
          void handle?.refresh();
        });
        message.hidden = true;
        return loaded;
      } catch {
        message.textContent = 'The map could not load. Reload to retry; your selected Nation and filters are saved in this page address.'; retry.hidden = false;
        status = unavailable(['cthd-registry'], 'Map loading failed. Use Reload to Retry Map to recover.'); void handle?.refresh();
        return null;
      }
}
