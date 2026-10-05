// @ts-check
/**
 * Entry module for the resources page (blueprint 7.5). Loaded by <script type="module">; its static imports
 * are listed in the page's modulepreload block (check:preload). The hub (ui/resources-hub.js) is a dynamic
 * import started at once, so it downloads while the source registry loads and the static graph stays small.
 */
import { initChrome, pageSourceIds } from '../ui/chrome.js';
import { initEmbed } from '../core/embed.js';
import { fetchLocal } from '../core/net.js';
import { findSource, loadSources } from '../core/sources.js';
import { setIdRedirects } from '../core/url-state.js';

/** Page start-up. */
export async function main() {
  initEmbed({ page: 'resources' });
  const hubLoading = import('../ui/resources-hub.js');
  /** @type {Record<string, string>} */
  const names = {};
  try {
    await loadSources();
    for (const id of pageSourceIds(document)) { const r = findSource(id); if (r) names[id] = r.attribution || r.owner; }
  } catch { /* each panel says what failed */ }
  initChrome({ page: 'resources', sources: names });
  const hub = await hubLoading;
  hub.markOutwardLinks(document.querySelector('main') ?? document);
  try {
    const redirects = await fetchLocal('data/registry/id-redirects.json');
    if (redirects.ok) setIdRedirects(/** @type {any} */ (redirects.data));
  } catch { /* an absent redirect table means no redirects */ }

  const slot = document.querySelector('[data-panel="resources"]');
  if (!(slot instanceof HTMLElement)) return;
  hub.mountResources(slot);
}

if (globalThis.document) void main();
