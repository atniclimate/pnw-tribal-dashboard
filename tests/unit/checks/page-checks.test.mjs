// @ts-check
/**
 * Seeded violations for scripts/check/chrome.mjs and scripts/check/modulepreload.mjs, plus the
 * dev server's MIME and path rules.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, test } from 'node:test';
import { chromeProblems, normalizeChrome } from '../../../scripts/check/chrome.mjs';
import { analyzePage, staticImports } from '../../../scripts/check/modulepreload.mjs';
import { blocks } from '../../../scripts/check/lib/pages.mjs';
import { MIME, resolvePath } from '../../../scripts/dev/serve.mjs';

const root = await readFile(new URL('../../../site/index.html', import.meta.url), 'utf8');
const alerts = await readFile(new URL('../../../site/alerts/index.html', import.meta.url), 'utf8');

describe('check:chrome', () => {
  test('chrome is identical across pages once prefixes and aria-current are normalized', () => {
    const a = blocks(root, 'chrome').map((b) => normalizeChrome(b.inner));
    const b = blocks(alerts, 'chrome').map((x) => normalizeChrome(x.inner));
    assert.equal(a.length, 2);
    assert.deepEqual(a, b);
  });

  test('a changed nav label is detected', () => {
    const edited = alerts.replace('>Forecasts</a>', '>Forecast</a>');
    const a = blocks(root, 'chrome').map((x) => normalizeChrome(x.inner));
    const b = blocks(edited, 'chrome').map((x) => normalizeChrome(x.inner));
    assert.notDeepEqual(a, b);
  });

  test('a missing block and a second aria-current are problems', () => {
    assert.match(chromeProblems(alerts.replace('<!-- chrome:end -->', ''))[0] ?? '', /expected 2 chrome blocks/);
    assert.match(chromeProblems(alerts.replace('>Dashboard</a>', ' aria-current="page">Dashboard</a>')).join(' '), /at most one aria-current/);
  });
});

describe('check:preload', () => {
  test('static imports are found; dynamic import() and comments are ignored', () => {
    const src = [
      "import { a } from './a.js';",
      "import * as b from '../b.js';",
      "import './side-effect.js';",
      "export { c } from './c.js';",
      "import {\n  d,\n  e,\n} from './de.js';",
      "const m = await import('./lazy.js');",
      "/** @typedef {import('../types.js').X} X */",
      "// import { z } from './commented.js';",
    ].join('\n');
    assert.deepEqual(staticImports(src), ['./a.js', '../b.js', './side-effect.js', './c.js', './de.js']);
  });

  test('the alerts page lists exactly its graph', async () => {
    const r = await analyzePage('alerts/index.html', alerts);
    assert.deepEqual(r.have, r.want);
    assert.equal(r.want[0], '../static/js/pages/alerts.js');
  });

  test('a missing and an extra preload are detected', async () => {
    const edited = alerts
      .replace('  <link rel="modulepreload" href="../static/js/ui/panel.js">\n', '')
      .replace('<!-- modulepreload:end -->', '<link rel="modulepreload" href="../static/js/map/loader.js">\n  <!-- modulepreload:end -->');
    const r = await analyzePage('alerts/index.html', edited);
    assert.ok(r.want.includes('../static/js/ui/panel.js') && !r.have.includes('../static/js/ui/panel.js'));
    assert.ok(r.have.includes('../static/js/map/loader.js') && !r.want.includes('../static/js/map/loader.js'));
  });
});

describe('dev server', () => {
  test('serves .mjs and .js as text/javascript (module workers need it)', () => {
    assert.match(MIME['.mjs'] ?? '', /^text\/javascript/);
    assert.match(MIME['.js'] ?? '', /^text\/javascript/);
    assert.match(MIME['.woff2'] ?? '', /^font\/woff2/);
  });

  test('resolves directories, redirects missing slashes, and refuses traversal', async () => {
    const idx = await resolvePath('/pnw-tribal-dashboard/alerts/');
    assert.ok(idx && 'file' in idx && idx.file.endsWith('index.html'));
    assert.deepEqual(await resolvePath('/pnw-tribal-dashboard/alerts'), { redirect: '/pnw-tribal-dashboard/alerts/' });
    assert.equal(await resolvePath('/pnw-tribal-dashboard/../package.json'), null);
    assert.equal(await resolvePath('/pnw-tribal-dashboard/no-such-page/'), null);
  });
});
