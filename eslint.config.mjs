// @ts-check
/**
 * ESLint flat config (blueprint 2.2, 3.1, 3.4, 4.1, 10.1). Owner: lane L0.
 *
 * Enforced here: no HTML sinks, no inline handlers, no Math.random in site/, fetch() only in core/net.js
 * (browser) and scripts/lib/http.mjs (Node; development tools in scripts/dev/ are exempt), the vendored
 * MapLibre modules only from map/loader.js, `new maplibregl.Map(` only in map/create-map.js, no flyTo or
 * setHTML anywhere, no `parseFloat(...) || null`, no DOM globals in DOM-free directories, the layer import
 * rules of blueprint 3.1, and no unregistered https:// literals in site code.
 */
import js from '@eslint/js';
import globals from 'globals';
import noUnsanitized from 'eslint-plugin-no-unsanitized';

const SITE = 'site/static/js';

/** Hosts that may appear as literals in site code: human fallback pages only. API endpoints come from the registry. */
const URL_ALLOWLIST = [
  'www.weather.gov', 'weather.gov', 'weather.gc.ca', 'forecast.weather.gov', 'atniclimate.github.io',
  'github.com', 'www.w3.org',
];
const allowAlt = URL_ALLOWLIST.map((h) => h.replace(/\./g, '[.]')).join('|');
// esquery regular expressions cannot contain a slash, so `..` stands for `//` and the host boundary is any
// character that cannot continue a host name.
const URL_LITERAL = `/^https?:..(?!(?:${allowAlt})(?:[^a-z0-9.-]|$))/`;

const HTML_SINKS = [
  { selector: "AssignmentExpression[left.property.name=/^(innerHTML|outerHTML)$/]", message: 'HTML sinks are banned; build DOM with h() from core/dom.js.' },
  { selector: "CallExpression[callee.property.name='insertAdjacentHTML']", message: 'insertAdjacentHTML is banned; use h().' },
  { selector: "CallExpression[callee.object.name='document'][callee.property.name=/^(write|writeln)$/]", message: 'document.write is banned.' },
  { selector: "CallExpression[callee.property.name='createContextualFragment']", message: 'HTML parsing of data is banned.' },
  { selector: "NewExpression[callee.name='DOMParser']", message: 'HTML parsing of data is banned.' },
  { selector: "CallExpression[callee.property.name='setHTML']", message: 'setHTML is banned; popups use setDOMContent with h() elements (blueprint 3.4).' },
  { selector: "CallExpression[callee.property.name='flyTo']", message: 'flyTo is banned; use jumpTo or fitBounds (blueprint 4.1).' },
  { selector: "CallExpression[callee.property.name='setAttribute'][arguments.0.value=/^on/i]", message: 'Inline handlers are banned; use addEventListener or on() from core/dom.js.' },
  { selector: "AssignmentExpression[left.property.name=/^on[a-z]+$/]", message: 'Inline handler properties are banned; use addEventListener.' },
  { selector: "LogicalExpression[operator='||'][left.callee.name='parseFloat'][right.raw='null']", message: 'parseFloat(x) || null turns 0 into null; use toNumberOrNull from core/units.js.' },
  { selector: "LogicalExpression[operator='||'][left.callee.property.name='parseFloat'][right.raw='null']", message: 'Number.parseFloat(x) || null turns 0 into null; use toNumberOrNull.' },
];
const SITE_ONLY = [
  { selector: "CallExpression[callee.object.name='Math'][callee.property.name='random']", message: 'Math.random is banned in site/ (no fabricated data).' },
  { selector: "NewExpression[callee.object.name=/^(maplibregl|maplibre)$/][callee.property.name='Map']", message: 'new maplibregl.Map( appears only in map/create-map.js.' },
  { selector: `Literal[value=${URL_LITERAL}]`, message: 'URL literals come from the source registry (core/sources.js); human fallback hosts are allowlisted in eslint.config.mjs.' },
  { selector: `TemplateElement[value.raw=${URL_LITERAL}]`, message: 'URL literals come from the source registry (core/sources.js).' },
  { selector: "MemberExpression[object.name='globalThis'][property.name='fetch']", message: 'fetch is called only in core/net.js.' },
  { selector: "MemberExpression[object.name='window'][property.name='fetch']", message: 'fetch is called only in core/net.js.' },
];
const MAPLIBRE_IMPORT = { group: ['**/vendor/maplibre-gl*', '**/vendor/maplibre-gl*/**', 'maplibre-gl', 'maplibre-gl/*'], message: 'Only map/loader.js imports the vendored MapLibre modules (blueprint 2.5).' };
const DOM_GLOBALS = ['window', 'document', 'localStorage', 'sessionStorage', 'navigator', 'location', 'history'].map((name) => ({
  name, message: 'This directory is DOM-free so Node imports it unchanged (blueprint 2.2).',
}));

/**
 * Layer rules (blueprint 3.1): pages -> ui -> data, alerts, bc, hydro, forecast, declarations -> core.
 * map -> ui/status-pill, map/sovereignty, core. Lower layers never import higher ones.
 * @param {string[]} banned directory names (relative to site/static/js) this layer may not import
 */
const layer = (banned) => banned.flatMap((d) => [`../${d}/*`, `../../${d}/*`, `../${d}/**`, `../../${d}/**`]);

export default [
  {
    ignores: ['node_modules/**', 'site/static/vendor/**', 'site/classic/**', '_site/**', '.cache/**',
      'reports/**', 'exports/**', 'test-results/**', 'playwright-report/**', 'tests/fixtures/**', 'site/data/**', 'index.html'],
  },
  js.configs.recommended,
  {
    files: ['**/*.js', '**/*.mjs'],
    languageOptions: { ecmaVersion: 2022, sourceType: 'module' },
    rules: {
      'no-unused-vars': ['error', { args: 'none', caughtErrors: 'none' }],
      'no-restricted-syntax': ['error', ...HTML_SINKS],
      eqeqeq: ['error', 'smart'],
      'no-var': 'off',
    },
  },
  // Browser code.
  {
    files: [`${SITE}/**/*.js`, 'site/*.js'],
    plugins: { 'no-unsanitized': noUnsanitized },
    languageOptions: { globals: { ...globals.browser } },
    rules: {
      'no-unsanitized/method': 'error',
      'no-unsanitized/property': 'error',
      'no-restricted-syntax': ['error', ...HTML_SINKS, ...SITE_ONLY],
      'no-restricted-globals': ['error', { name: 'fetch', message: 'fetch is called only in core/net.js (blueprint 3.1).' }],
      'no-restricted-imports': ['error', { patterns: [MAPLIBRE_IMPORT] }],
    },
  },
  { files: [`${SITE}/boot/flags.js`], languageOptions: { sourceType: 'script' } },
  { files: [`${SITE}/core/net.js`], rules: { 'no-restricted-globals': 'off' } },
  { files: [`${SITE}/map/loader.js`], rules: { 'no-restricted-imports': 'off' } },
  {
    files: [`${SITE}/map/create-map.js`],
    rules: { 'no-restricted-syntax': ['error', ...HTML_SINKS, ...SITE_ONLY.filter((r) => !r.selector.startsWith('NewExpression'))] },
  },
  // DOM-free directories and files (blueprint 2.2).
  {
    files: [`${SITE}/alerts/**/*.js`, `${SITE}/bc/**/*.js`, `${SITE}/hydro/**/*.js`, `${SITE}/forecast/**/*.js`,
      `${SITE}/declarations/**/*.js`, `${SITE}/data/**/*.js`, `${SITE}/config/**/*.js`, `${SITE}/map/style.js`, `${SITE}/map/topo.js`,
      ...['net', 'priority', 'status', 'time', 'units', 'geo', 'sources', 'store'].map((f) => `${SITE}/core/${f}.js`)],
    rules: {
      'no-restricted-globals': ['error', { name: 'fetch', message: 'fetch is called only in core/net.js.' }, ...DOM_GLOBALS],
    },
  },
  { files: [`${SITE}/core/net.js`], rules: { 'no-restricted-globals': ['error', ...DOM_GLOBALS] } },
  // Layer import rules (blueprint 3.1).
  {
    files: [`${SITE}/core/**/*.js`],
    rules: { 'no-restricted-imports': ['error', { patterns: [MAPLIBRE_IMPORT, { group: layer(['ui', 'pages', 'map', 'alerts', 'bc', 'hydro', 'forecast', 'declarations', 'data']), message: 'core/ imports only core/ and config/ (blueprint 3.1).' }] }] },
  },
  {
    files: [`${SITE}/alerts/**/*.js`, `${SITE}/bc/**/*.js`, `${SITE}/hydro/**/*.js`, `${SITE}/forecast/**/*.js`, `${SITE}/declarations/**/*.js`, `${SITE}/data/**/*.js`],
    rules: { 'no-restricted-imports': ['error', { patterns: [MAPLIBRE_IMPORT, { group: layer(['ui', 'pages', 'map']), message: 'Domain modules import only core/, config/, and other domain modules (blueprint 3.1).' }] }] },
  },
  {
    files: [`${SITE}/ui/**/*.js`],
    rules: { 'no-restricted-imports': ['error', { patterns: [MAPLIBRE_IMPORT, { group: layer(['pages']), message: 'ui/ never imports pages/ (blueprint 3.1).' }] }] },
  },
  {
    files: [`${SITE}/map/**/*.js`],
    ignores: [`${SITE}/map/loader.js`],
    rules: { 'no-restricted-imports': ['error', { patterns: [MAPLIBRE_IMPORT, { group: [...layer(['pages', 'alerts', 'bc', 'hydro', 'forecast', 'declarations', 'data', 'ui']), '!../ui/status-pill.js', '!../../ui/status-pill.js'], message: 'map/ imports only ui/status-pill.js, map/, and core/ (blueprint 3.1).' }] }] },
  },
  {
    files: [`${SITE}/map/loader.js`],
    rules: { 'no-restricted-imports': ['error', { patterns: [{ group: layer(['pages', 'alerts', 'bc', 'hydro', 'forecast', 'declarations', 'data', 'ui']), message: 'map/loader.js imports only map/ and core/.' }] }] },
  },
  // Node: scripts, tests, and config files.
  {
    files: ['scripts/**/*.mjs', 'tests/**/*.mjs', '*.mjs'],
    languageOptions: { globals: { ...globals.node } },
    rules: {
      'no-restricted-globals': ['error', { name: 'fetch', message: 'Node code fetches only through scripts/lib/http.mjs (blueprint 3.1).' }],
    },
  },
  { files: ['scripts/lib/http.mjs', 'scripts/dev/**/*.mjs'], rules: { 'no-restricted-globals': 'off' } },
  { files: ['tests/e2e/**/*.mjs'], languageOptions: { globals: { ...globals.node, ...globals.browser } } },
];
