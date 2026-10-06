// @ts-check
/**
 * deploy.yml and reference-refresh.yml (blueprint 2.7, 6.5): inert before Gate V, GITHUB_TOKEN only,
 * first-party actions pinned by full SHA, and actionlint clean. Owner: lane L9.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { CORE_SCHEMA, load } from 'js-yaml';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const GATE = "vars.CTHD_PAGES_ACTIONS == 'true'";

/** @param {string} name */
async function workflow(name) {
  const text = await readFile(path.join(ROOT, '.github', 'workflows', name), 'utf8');
  return { text, wf: /** @type {any} */ (load(text, { schema: CORE_SCHEMA })) };
}

/** @param {any} wf */
const steps = (wf) => Object.values(wf.jobs).flatMap((/** @type {any} */ j) => j.steps ?? []);

for (const name of ['deploy.yml', 'reference-refresh.yml']) {
  describe(name, () => {
    test('uses only first-party actions pinned by full commit SHA', async () => {
      const { wf } = await workflow(name);
      for (const s of steps(wf).filter((/** @type {any} */ x) => x.uses)) {
        assert.match(s.uses, /^actions\/[a-z0-9-]+@[0-9a-f]{40}$/, s.uses);
      }
    });

    test('authenticates only with GITHUB_TOKEN', async () => {
      const { text } = await workflow(name);
      const secrets = [...text.matchAll(/secrets\.([A-Za-z_]+)/g)].map((m) => m[1]);
      assert.deepEqual(secrets.filter((s) => s !== 'GITHUB_TOKEN'), []);
    });
  });
}

describe('deploy.yml', () => {
  test('every job skips while CTHD_PAGES_ACTIONS is absent', async () => {
    const { wf } = await workflow('deploy.yml');
    const jobs = Object.entries(wf.jobs);
    assert.ok(jobs.length > 0);
    for (const [id, job] of jobs) assert.ok(String(/** @type {any} */ (job).if).startsWith(GATE), `job ${id}`);
  });

  test('triggers, permissions, and concurrency follow blueprint 6.5', async () => {
    const { wf } = await workflow('deploy.yml');
    assert.equal(wf.on.push, undefined, 'a push must pass CI before publishing');
    assert.deepEqual(wf.on.workflow_run, { workflows: ['CI'], types: ['completed'], branches: ['main'] });
    assert.deepEqual(wf.on.schedule, [{ cron: '4,14,24,34,44,54 * * * *' }]);
    assert.ok('workflow_dispatch' in wf.on);
    assert.deepEqual(wf.permissions, { contents: 'read', actions: 'read', pages: 'write', 'id-token': 'write' });
    assert.deepEqual(wf.concurrency, { group: 'pages', 'cancel-in-progress': false });
  });

  test('runs compile, snapshots, validation, and assembly in order, with full history for retention', async () => {
    const { wf } = await workflow('deploy.yml');
    const all = steps(wf);
    const runs = all.filter((/** @type {any} */ s) => s.run).map((/** @type {any} */ s) => s.run);
    const order = ['scripts/compile/all.mjs --fallback', 'scripts/snapshot/run.mjs --out site/data/live --previous',
      'scripts/check/validate-live.mjs site/data/live', 'scripts/assemble-site.mjs --out _site --sha "$RELEASE_SHA" --previous'];
    const at = order.map((o) => runs.findIndex((/** @type {string} */ r) => r.includes(o)));
    assert.ok(at.every((i) => i >= 0), JSON.stringify(at));
    assert.deepEqual([...at].sort((a, b) => a - b), at);
    const checkout = all.find((/** @type {any} */ s) => String(s.uses).startsWith('actions/checkout@'));
    assert.equal(checkout.with['fetch-depth'], 0);
    assert.equal(checkout.with['persist-credentials'], false);
    assert.equal(wf.jobs.deploy.needs, 'release-check');
    assert.match(checkout.with.ref, /needs.release-check.outputs.sha/);
    assert.match(wf.jobs['release-check'].steps[0].run, /head_sha="\$sha"/);
    assert.match(wf.jobs['release-check'].steps[0].run, /if \[ "\$conclusion" != success \]/);
    const upload = all.find((/** @type {any} */ s) => String(s.uses).startsWith('actions/upload-pages-artifact@'));
    assert.equal(upload.with.path, '_site');
    assert.ok(all.some((/** @type {any} */ s) => String(s.uses).startsWith('actions/deploy-pages@')));
  });
});

describe('reference-refresh.yml', () => {
  test('the schedule is inert while CTHD_PAGES_ACTIONS is absent; dispatch still runs', async () => {
    const { wf } = await workflow('reference-refresh.yml');
    assert.deepEqual(wf.on.schedule, [{ cron: '17 9 3 * *' }]);
    for (const job of Object.values(wf.jobs)) {
      assert.equal(/** @type {any} */ (job).if, `github.event_name == 'workflow_dispatch' || ${GATE}`);
    }
    assert.deepEqual(wf.permissions, { contents: 'write', 'pull-requests': 'write' });
  });

  test('opens or updates a reference/refresh-<date> pull request and never merges', async () => {
    const { text } = await workflow('reference-refresh.yml');
    assert.match(text, /branch="reference\/refresh-\$\{stamp\}"/);
    assert.match(text, /gh pr create --base main/);
    assert.doesNotMatch(text, /gh pr merge/);
  });
});

test('actionlint passes on deploy.yml and reference-refresh.yml', (t) => {
  const exe = path.join(ROOT, 'node_modules', '.bin', process.platform === 'win32' ? 'actionlint.exe' : 'actionlint');
  const bin = existsSync(exe) ? exe : spawnSync('actionlint', ['-version']).status === 0 ? 'actionlint' : null;
  if (!bin) { t.skip('actionlint is not installed (node scripts/dev/actionlint.mjs --install); CI runs it'); return; }
  const r = spawnSync(bin, ['-no-color', '.github/workflows/deploy.yml', '.github/workflows/reference-refresh.yml'], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
});
