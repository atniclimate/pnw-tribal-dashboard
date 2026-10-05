// @ts-check
/**
 * Local dry run of the deploy.yml pipeline (blueprint 2.1, 6.5) over a copy of the real site/: snapshots
 * from the fixture tasks, validate-live, then assemble. No upload or deploy. Owner: lane L9.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cp, mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { assemble } from '../../../scripts/assemble-site.mjs';
import { validateLive } from '../../../scripts/check/validate-live.mjs';
import { runSnapshot } from '../../../scripts/snapshot/run.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** @type {string} */
let tmp;
before(async () => { tmp = await mkdtemp(path.join(os.tmpdir(), 'cthd-dry-run-')); });
after(async () => { await rm(tmp, { recursive: true, force: true }); });

/** @param {string} dir @returns {Promise<string[]>} */
async function htmlFiles(dir) {
  /** @type {string[]} */
  const out = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...await htmlFiles(p));
    else if (e.name.endsWith('.html')) out.push(p);
  }
  return out;
}

test('compile-free dry run: snapshots, validate-live, and assemble produce a deployable _site/', async () => {
  const site = path.join(tmp, 'site');
  await cp(path.join(ROOT, 'site'), site, { recursive: true, filter: (src) => !src.includes(`${path.sep}data${path.sep}live${path.sep}`) });
  const live = path.join(site, 'data', 'live');
  await runSnapshot({ out: live, tasksDir: path.join(ROOT, 'tests', 'unit', 'snapshot', 'fixture-tasks'),
    fixtures: path.join(ROOT, 'tests', 'fixtures', 'upstream'), previous: null, now: new Date('2026-10-05T07:00:00Z'),
    buildSha: '0123456789abcdef0123456789abcdef01234567', log: () => {} });
  assert.deepEqual(await validateLive(live), []);

  const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
  const out = path.join(tmp, '_site');
  const r = await assemble({ out, sha, previous: null, site, repo: ROOT, log: () => {} });
  const v = path.join(out, 'v', r.sha12);
  assert.ok((await stat(path.join(v, 'js'))).isDirectory());
  assert.ok((await stat(path.join(out, 'data', 'live', 'manifest.json'))).isFile());
  assert.deepEqual(JSON.parse(await readFile(path.join(out, 'build-info.json'), 'utf8')).sha12, r.sha12);
  if ((await readdir(path.join(site, 'static'))).includes('vendor')) {
    assert.ok((await stat(path.join(v, 'vendor'))).isDirectory(), 'vendored files ship under v/<sha12>/vendor/');
  }
  // No page outside classic/ still points at the unversioned static/ directory.
  for (const file of await htmlFiles(out)) {
    if (file.includes(`${path.sep}classic${path.sep}`) || file.startsWith(v)) continue;
    const html = await readFile(file, 'utf8');
    assert.doesNotMatch(html, /\s(?:href|src)\s*=\s*["'](?:\.\/)?(?:\.\.\/)*static\//, path.relative(out, file));
  }
});
