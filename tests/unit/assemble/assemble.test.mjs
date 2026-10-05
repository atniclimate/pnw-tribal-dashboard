// @ts-check
/**
 * scripts/assemble-site.mjs (blueprint 2.1, 5.12): HTML-only attribute rewriting, the versioned asset
 * directory, the allowlist, build-info.json, and retention of the previous generation from git.
 * Owner: lane L9.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { loadAjv, SCHEMA_BASE } from '../../../scripts/check/lib/data-files.mjs';
import { assemble, rewriteHtml } from '../../../scripts/assemble-site.mjs';
import { readTar } from '../../../scripts/lib/tar.mjs';

const S12 = 'abcdef012345';

describe('rewriteHtml', () => {
  test('rewrites href and src values that start with (../)*static/ or ./static/', () => {
    const html = [
      '<link rel="stylesheet" href="static/css/site.css">',
      "<script type=\"module\" src='../static/js/pages/alerts.js'></script>",
      '<link rel="modulepreload" href="../../static/js/core/net.js">',
      '<img alt="" src="./static/img/logo.svg">',
      '<a href="static-page/">x</a>',
      '<a href="/static/elsewhere">x</a>',
      '<img data-src="static/a.png" srcset="static/b.png 2x">',
    ].join('\n');
    const out = rewriteHtml(html, S12);
    assert.match(out, /href="v\/abcdef012345\/css\/site.css"/);
    assert.match(out, /src='\.\.\/v\/abcdef012345\/js\/pages\/alerts.js'/);
    assert.match(out, /href="\.\.\/\.\.\/v\/abcdef012345\/js\/core\/net.js"/);
    assert.match(out, /src="\.\/v\/abcdef012345\/img\/logo.svg"/);
    assert.match(out, /href="static-page\/"/);
    assert.match(out, /href="\/static\/elsewhere"/);
    assert.match(out, /data-src="static\/a.png" srcset="static\/b.png 2x"/);
  });

  test('never rewrites text in scripts, styles, comments, or body text', () => {
    const html = '<p>See src="static/x.js" in the docs.</p><!-- <script src="static/old.js"></script> -->'
      + '<script>const u = \'<img src="static/q.png">\';</script><style>.a{background:url(static/a.png)}</style>';
    assert.equal(rewriteHtml(html, S12), html);
  });

  test('rejects a malformed sha12', () => {
    assert.throws(() => rewriteHtml('', 'xyz'));
  });
});

/** @param {string} cwd @param {string[]} args */
const git = (cwd, args) => execFileSync('git', ['-c', 'user.name=cthd-test', '-c', 'user.email=cthd-test@example.invalid', '-c', 'commit.gpgsign=false', ...args],
  { cwd, encoding: 'utf8' }).trim();

describe('assemble', () => {
  /** @type {string} */
  let tmp;
  /** @type {string} */
  let repo;
  /** @type {string} */
  let sha1;
  /** @type {string} */
  let sha2;
  const deep = `deep/${'nested-directory-name/'.repeat(6)}module.js`;

  before(async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), 'cthd-assemble-'));
    repo = path.join(tmp, 'repo');
    /** @type {Record<string, string>} */
    const files = {
      'site/index.html': '<!doctype html><link rel="modulepreload" href="static/js/pages/dashboard.js"><script type="module" src="static/js/pages/dashboard.js"></script>',
      'site/alerts/index.html': '<!doctype html><script type="module" src="../static/js/pages/alerts.js"></script>',
      'site/404.html': '<!doctype html><base href="/pnw-tribal-dashboard/"><link rel="stylesheet" href="static/css/site.css">',
      'site/static/js/pages/dashboard.js': "import '../core/net.js'; export const v = 1; const s = 'static/x';\n",
      'site/static/js/pages/alerts.js': 'export const a = 1;\n',
      'site/static/js/core/net.js': 'export const net = 1;\n',
      'site/static/css/site.css': '.a { background: url(../img/a.png); }\n',
      'site/static/vendor/maplibre-gl-6.12.0/maplibre-gl.js': '/* vendored */\n',
      [`site/static/${deep}`]: 'export const deep = 1;\n',
      'site/data/live/.gitkeep': '',
      'site/robots.txt': 'User-agent: *\nDisallow: /\n',
      'site/notes.txt': 'not deployed\n',
      '.gitattributes': '* text=auto eol=lf\n',
    };
    for (const [rel, body] of Object.entries(files)) {
      await mkdir(path.dirname(path.join(repo, rel)), { recursive: true });
      await writeFile(path.join(repo, rel), body);
    }
    git(repo, ['init', '-q']);
    git(repo, ['add', '-A']);
    git(repo, ['commit', '-q', '-m', 'one']);
    sha1 = git(repo, ['rev-parse', 'HEAD']);
    await writeFile(path.join(repo, 'site/static/js/pages/dashboard.js'), "import '../core/net.js'; export const v = 2;\n");
    git(repo, ['commit', '-q', '-am', 'two']);
    sha2 = git(repo, ['rev-parse', 'HEAD']);
    await writeFile(path.join(repo, 'site/data/live/manifest.json'), '{"generated":"locally"}\n');
    await writeFile(path.join(tmp, 'prev-build-info.json'), JSON.stringify({ sha: sha1, sha12: sha1.slice(0, 12), builtAt: '2026-10-05T06:00:00Z', swDisabled: false }));
  });
  after(async () => { await rm(tmp, { recursive: true, force: true }); });

  test('copies the allowlist, versions static/, rewrites HTML only, and retains the previous generation', async () => {
    const out = path.join(tmp, 'site-out');
    const now = new Date('2026-10-05T07:00:00Z');
    const r = await assemble({ out, sha: sha2, previous: path.join(tmp, 'prev-build-info.json'), repo, now, log: () => {} });
    const v2 = sha2.slice(0, 12);
    const v1 = sha1.slice(0, 12);
    assert.equal(r.sha12, v2);
    assert.equal(r.retained, v1);
    assert.deepEqual((await readdir(out)).sort(), ['404.html', 'alerts', 'build-info.json', 'data', 'index.html', 'robots.txt', 'v']);
    assert.deepEqual((await readdir(path.join(out, 'v'))).sort(), [v1, v2].sort());
    assert.match(await readFile(path.join(out, 'index.html'), 'utf8'), new RegExp(`href="v/${v2}/js/pages/dashboard.js".*src="v/${v2}/js/pages/dashboard.js"`));
    assert.match(await readFile(path.join(out, 'alerts', 'index.html'), 'utf8'), new RegExp(`src="\\.\\./v/${v2}/js/pages/alerts.js"`));
    assert.match(await readFile(path.join(out, '404.html'), 'utf8'), new RegExp(`href="v/${v2}/css/site.css"`));
    assert.equal(await readFile(path.join(out, 'v', v2, 'js', 'pages', 'dashboard.js'), 'utf8'), "import '../core/net.js'; export const v = 2;\n");
    assert.equal(await readFile(path.join(out, 'v', v1, 'js', 'pages', 'dashboard.js'), 'utf8'), "import '../core/net.js'; export const v = 1; const s = 'static/x';\n",
      'the previous generation comes from git, and JavaScript is never rewritten');
    assert.equal(await readFile(path.join(out, 'v', v2, 'css', 'site.css'), 'utf8'), '.a { background: url(../img/a.png); }\n');
    assert.equal(await readFile(path.join(out, 'v', v2, 'vendor', 'maplibre-gl-6.12.0', 'maplibre-gl.js'), 'utf8'), '/* vendored */\n');
    assert.equal(await readFile(path.join(out, 'v', v1, ...deep.split('/')), 'utf8'), 'export const deep = 1;\n', 'long tar paths survive');
    assert.equal(await readFile(path.join(out, 'data', 'live', 'manifest.json'), 'utf8'), '{"generated":"locally"}\n');
    const info = JSON.parse(await readFile(path.join(out, 'build-info.json'), 'utf8'));
    assert.deepEqual(info, { sha: sha2, sha12: v2, builtAt: now.toISOString(), swDisabled: false });
    const validate = (await loadAjv()).getSchema(`${SCHEMA_BASE}build-info.schema.json`);
    assert.ok(validate?.(info), JSON.stringify(validate?.errors));
  });

  test('the same commit retains nothing extra; an unknown previous commit is logged, not fatal; the kill switch is written', async () => {
    const same = path.join(tmp, 'prev-same.json');
    await writeFile(same, JSON.stringify({ sha: sha2, sha12: sha2.slice(0, 12), builtAt: '2026-10-05T06:00:00Z', swDisabled: false }));
    const a = await assemble({ out: path.join(tmp, 'out-same'), sha: sha2, previous: same, repo, swDisabled: true, log: () => {} });
    assert.equal(a.retained, null);
    assert.equal(JSON.parse(await readFile(path.join(tmp, 'out-same', 'build-info.json'), 'utf8')).swDisabled, true);
    const unknown = path.join(tmp, 'prev-unknown.json');
    const fake = 'f'.repeat(40);
    await writeFile(unknown, JSON.stringify({ sha: fake, sha12: fake.slice(0, 12), builtAt: '2026-10-05T06:00:00Z', swDisabled: false }));
    /** @type {string[]} */
    const logs = [];
    const b = await assemble({ out: path.join(tmp, 'out-unknown'), sha: sha2, previous: unknown, repo, log: (m) => logs.push(m) });
    assert.equal(b.retained, null);
    assert.ok(logs.some((m) => /could not retain/.test(m)));
    const c = await assemble({ out: path.join(tmp, 'out-none'), sha: sha2, previous: path.join(tmp, 'absent.json'), repo, log: () => {} });
    assert.equal(c.retained, null);
  });

  test('refuses a short sha and an output inside site/', async () => {
    await assert.rejects(assemble({ out: path.join(tmp, 'x'), sha: 'abc', previous: null, repo }));
    await assert.rejects(assemble({ out: path.join(repo, 'site', 'out'), sha: sha2, previous: null, repo }));
  });

  test('readTar lists regular files from git archive output', () => {
    const tar = execFileSync('git', ['archive', '--format=tar', sha1, 'site/static'], { cwd: repo });
    const names = readTar(tar).map((f) => f.name);
    assert.ok(names.includes('site/static/js/core/net.js'));
    assert.ok(names.includes(`site/static/${deep}`));
  });
});
