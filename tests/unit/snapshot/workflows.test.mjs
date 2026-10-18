// @ts-check
/**
 * deploy.yml and reference-refresh.yml (blueprint 2.7, 6.5): inert before Gate V, GITHUB_TOKEN only,
 * first-party actions pinned by full SHA, and actionlint clean. Owner: lane L9.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { CORE_SCHEMA, load } from 'js-yaml';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const GATE = "vars.CTHD_PAGES_ACTIONS == 'true'";
const BASH = process.platform === 'win32'
  ? path.join(process.env.ProgramFiles ?? 'C:/Program Files', 'Git', 'bin', 'bash.exe') : 'bash';
const PUBLISHED = 'a'.repeat(40);
const MAIN = 'b'.repeat(40);

/** @param {string} script @param {Record<string, string>} env */
function bash(script, env) {
  return spawnSync(BASH, ['--noprofile', '--norc', '-e', '-o', 'pipefail'], {
    input: script, cwd: ROOT, encoding: 'utf8', timeout: 10_000, env: { ...process.env, ...env },
  });
}

/** @param {string} event @param {Record<string, string>} [overrides] */
async function selectRelease(event, overrides = {}) {
  const { wf } = await workflow('deploy.yml');
  const dir = await mkdtemp(path.join(tmpdir(), 'cthd-release-selection-'));
  const output = path.join(dir, 'output');
  try {
    await writeFile(output, '');
    const r = bash(`
    gh() {
      if [ "$EVENT_NAME" = schedule ]; then
        echo "A scheduled refresh must not depend on newer CI." >&2
        return 99
      fi
      case "$*" in
        *"/commits/main "*) printf '%s\\n' "$TEST_MAIN" ;;
        *"/actions/workflows/ci.yml/runs "*)
          [[ "$*" == *"head_sha=$TEST_MAIN"* ]] || return 99
          printf '%s\\n' "$TEST_CI"
          ;;
        *) return 99 ;;
      esac
    }
    curl() {
      [[ "$*" == *"$SITE_URL"build-info.json?run=* ]] || return 99
      printf '%s\\n' "$TEST_PUBLISHED"
      return "$TEST_CURL_STATUS"
    }
    ${wf.jobs['release-check'].steps[0].run}
    `, {
      EVENT_NAME: event, CI_SHA: MAIN, REPOSITORY: 'example/dashboard',
      SITE_URL: 'https://example.invalid/dashboard/', GITHUB_OUTPUT: output.replaceAll('\\', '/'),
      GITHUB_RUN_ID: '123', GITHUB_RUN_ATTEMPT: '1',
      TEST_MAIN: MAIN, TEST_CI: 'success', TEST_PUBLISHED: JSON.stringify({ sha: PUBLISHED }),
      TEST_CURL_STATUS: '0', ...overrides,
    });
    return { ...r, selected: await readFile(output, 'utf8') };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

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
    assert.match(wf.jobs.deploy.if, /needs\.release-check\.outputs\.sha != ''/);
    const upload = all.find((/** @type {any} */ s) => String(s.uses).startsWith('actions/upload-pages-artifact@'));
    assert.equal(upload.with.path, '_site');
    assert.ok(all.some((/** @type {any} */ s) => String(s.uses).startsWith('actions/deploy-pages@')));
  });
});

describe('release selection executes the workflow shell', () => {
  test('cancelled CI on newer main cannot stop refreshes of the published revision', async () => {
    const r = await selectRelease('schedule', { TEST_CI: 'cancelled' });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.selected, new RegExp(`^sha=${PUBLISHED}$`, 'm'));
    assert.doesNotMatch(r.selected, new RegExp(`sha=${MAIN}`));
  });

  test('successful CI for current main selects that exact commit', async () => {
    const r = await selectRelease('workflow_run');
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.selected, new RegExp(`^sha=${MAIN}$`, 'm'));
  });

  test('a completed older CI run cannot promote a different main commit', async () => {
    const r = await selectRelease('workflow_run', { CI_SHA: PUBLISHED });
    assert.equal(r.status, 0, r.stderr);
    assert.doesNotMatch(r.selected, /^sha=/m);
  });

  for (const conclusion of ['cancelled', 'failure', 'pending']) {
    test(`manual release cannot publish main when CI is ${conclusion}`, async () => {
      const r = await selectRelease('workflow_dispatch', { TEST_CI: conclusion });
      assert.equal(r.status, 1, r.stderr);
      assert.doesNotMatch(r.selected, /^sha=/m);
    });
  }

  for (const published of ['{}', 'not json', '{"sha":"main"}', '{"sha":"abc\\nsha=main"}']) {
    test(`invalid published metadata fails closed: ${published}`, async () => {
      const r = await selectRelease('schedule', { TEST_PUBLISHED: published });
      assert.notEqual(r.status, 0);
      assert.doesNotMatch(r.selected, /^sha=/m);
    });
  }

  test('a failed metadata download cannot select a release', async () => {
    const r = await selectRelease('schedule', { TEST_CURL_STATUS: '22' });
    assert.notEqual(r.status, 0);
    assert.doesNotMatch(r.selected, /^sha=/m);
  });
});

describe('browser installation', () => {
  test('each browser job installs only its engine; release checks keep both', async () => {
    const { wf } = await workflow('ci.yml');
    const install = wf.jobs.e2e.steps.find((/** @type {any} */ s) => s.run?.includes('install-browsers.sh'));
    assert.equal(install.env.BROWSER, "${{ matrix.project == 'webkit-iphone' && 'webkit' || 'chromium' }}");
    assert.equal(install.run, 'bash scripts/ci/install-browsers.sh "$BROWSER"');
    assert.equal(install['timeout-minutes'], 7);
    assert.ok(wf.jobs['release-artifact'].steps.some((/** @type {any} */ s) =>
      s.run === 'bash scripts/ci/install-browsers.sh chromium webkit' && s['timeout-minutes'] === 7));
  });

  for (const [failures, status, attempts] of [[0, 0, 1], [1, 0, 2], [2, 1, 2]]) {
    test(`a timed-out installation retries at most once (${failures} failures)`, async () => {
      const script = await readFile(path.join(ROOT, 'scripts/ci/install-browsers.sh'), 'utf8');
      const r = bash(`
        calls=0
        timeout() {
          [[ "$*" == '--kill-after=15s 180s npx playwright install --with-deps chromium' ]] || return 99
          calls=$((calls + 1))
          echo "install attempt $calls"
          if [ "$calls" -le "$TEST_FAILURES" ]; then return 124; fi
        }
        set -- chromium
        ${script}
      `, { TEST_FAILURES: String(failures) });
      assert.equal(r.status, status, r.stderr);
      assert.equal((r.stdout.match(/install attempt/g) ?? []).length, attempts);
    });
  }
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
