// @ts-check
/**
 * Entry module for the contacts page (blueprint 7.4). Loaded by <script type="module">; its static imports
 * are listed in the page's modulepreload block (check:preload). The views (ui/contacts-views.js) are a dynamic
 * import started at once, so they download while the source registry loads and the static graph stays small.
 */
import { initChrome, pageSourceIds } from '../ui/chrome.js';
import { initEmbed } from '../core/embed.js';
import { initTabs } from '../ui/tabs.js';
import { fetchLocal } from '../core/net.js';
import { findSource, loadSources } from '../core/sources.js';
import { setIdRedirects, writeState } from '../core/url-state.js';

/** Page start-up. */
export async function main() {
  initEmbed({ page: 'contacts' });
  const viewsLoading = import('../ui/contacts-views.js');
  /** @type {Record<string, string>} */
  const names = {};
  try {
    await loadSources();
    for (const id of pageSourceIds(document)) { const r = findSource(id); if (r) names[id] = r.attribution || r.owner; }
  } catch { /* the footer then lists nothing by name and each panel says what failed */ }
  initChrome({ page: 'contacts', sources: names });
  const views = await viewsLoading;
  views.markOutwardLinks(document.querySelector('main') ?? document);

  try {
    const redirects = await fetchLocal('data/registry/id-redirects.json');
    if (redirects.ok) setIdRedirects(/** @type {any} */ (redirects.data));
  } catch { /* an absent redirect table means no redirects */ }

  const tabs = document.querySelector('[data-tabs]');
  if (tabs instanceof HTMLElement) initTabs(tabs, { onChange: (id) => writeState({ view: id }, { push: true }) });
  const dir = document.querySelector('[data-panel="contacts-directory"]');
  const near = document.querySelector('[data-panel="contacts-near-me"]');
  if (dir instanceof HTMLElement) views.mountDirectory(dir);
  if (near instanceof HTMLElement) views.mountNearMe(near);
}

if (globalThis.document) void main();
