// @ts-check
/**
 * Page registry: routes, navigation order, views, and embed heights (blueprint 1.2 and 7.0).
 * DOM-free. Owner: lane L0. The static chrome in every page's HTML mirrors NAV_ORDER; scripts/check/chrome.mjs
 * keeps the copies identical.
 */

/** @typedef {import('../types.js').PageConfig} PageConfig */
/** @typedef {import('../types.js').PageId} PageId */

export const PRODUCT_NAME = 'Cascadia Tribal Hazard Dashboard';
export const PRODUCT_DESCRIPTION = 'Active weather, flood, and hazard alerts for Tribal Nations and First Nations across Cascadia.';
export const PREDECESSOR = 'IndigenousACCESS.org';
export const CONTACT_EMAIL = 'climate@atnitribes.org';
export const SITE_BASE_PATH = '/pnw-tribal-dashboard/';

/** @type {readonly PageConfig[]} */
export const PAGES = Object.freeze(/** @type {PageConfig[]} */ ([
  { id: 'dashboard', path: '', title: 'Dashboard', navLabel: 'Dashboard', views: [], embeddable: true, defaultEmbedHeight: 1500 },
  { id: 'alerts', path: 'alerts/', title: 'Alerts', navLabel: 'Alerts', views: ['list', 'map', 'declarations'], embeddable: true, defaultEmbedHeight: 1200 },
  { id: 'forecasts', path: 'forecasts/', title: 'Forecasts', navLabel: 'Forecasts', views: ['local', 'precip', 'ar', 'satellite', 'radar', 'rivers'], embeddable: true, defaultEmbedHeight: 1300 },
  { id: 'contacts', path: 'contacts/', title: 'Contacts', navLabel: 'Contacts', views: ['directory', 'near-me'], embeddable: true, defaultEmbedHeight: 1200 },
  { id: 'resources', path: 'resources/', title: 'Resources', navLabel: 'Resources', views: [], embeddable: true, defaultEmbedHeight: 1100 },
  { id: 'safety', path: 'safety/', title: 'Safety', navLabel: 'Safety', views: [], embeddable: true, defaultEmbedHeight: 1100 },
  { id: 'news', path: 'news/', title: 'News', navLabel: 'News', views: [], embeddable: true, defaultEmbedHeight: 1100 },
  { id: 'usage', path: 'usage/', title: 'Usage and Disclaimer', navLabel: 'Usage', views: ['usage', 'sources', 'status', 'privacy', 'accessibility'], embeddable: true, defaultEmbedHeight: 900 },
  { id: 'archive', path: 'archive/', title: 'Event Archive', navLabel: null, views: [], embeddable: true, defaultEmbedHeight: 900 },
  { id: 'archive-event', path: 'archive/2025-12-atmospheric-river/', title: 'December 2025 Atmospheric Rivers', navLabel: null, views: [], embeddable: true, defaultEmbedHeight: 1100 },
  { id: 'embed', path: 'embed/', title: 'Embedding the Dashboard', navLabel: null, views: [], embeddable: false, defaultEmbedHeight: null },
  { id: 'classic', path: 'classic/', title: 'Previous Dashboard', navLabel: null, views: [], embeddable: false, defaultEmbedHeight: null },
]).map((p) => Object.freeze({ ...p, views: Object.freeze(p.views) })));

/** Primary navigation, in order (blueprint 7.0). */
export const NAV_ORDER = Object.freeze(/** @type {PageId[]} */ (['dashboard', 'alerts', 'forecasts', 'contacts', 'resources', 'safety', 'news', 'usage']));

/** `panel=` values accepted on the Dashboard (blueprint 1.4). */
export const DASHBOARD_PANELS = Object.freeze(['banner', 'alerts', 'nation', 'rivers', 'contacts', 'map']);

/** Safety page anchors (blueprint 1.2, 7.6). */
export const SAFETY_ANCHORS = Object.freeze(['flood', 'atmospheric-rivers', 'wind', 'winter', 'heat', 'smoke', 'wildfire', 'tsunami', 'earthquake', 'kit']);

/**
 * @param {PageId} id
 * @returns {PageConfig}
 */
export function page(id) {
  const p = PAGES.find((x) => x.id === id);
  if (!p) throw new Error(`unknown page "${id}"`);
  return p;
}
