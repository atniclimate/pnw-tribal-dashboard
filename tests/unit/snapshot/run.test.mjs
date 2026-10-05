// @ts-check
/**
 * Snapshot runner acceptance (blueprint 12.3 L9, 5.10, 6.4), driven by test-only tasks over dated fixture
 * captures. Owner: lane L9.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { validateLive } from '../../../scripts/check/validate-live.mjs';
import { sha256 } from '../../../scripts/lib/live.mjs';
import { DUE_SLACK_MIN, isDue, runSnapshot, taskProblems } from '../../../scripts/snapshot/run.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..', '..');
const FIXTURE_TASKS = path.join(HERE, 'fixture-tasks');
const FIXTURES = path.join(ROOT, 'tests', 'fixtures', 'upstream');
const SHA = '0123456789abcdef0123456789abcdef01234567';
const T0 = new Date('2026-10-05T07:00:00Z');
/** OPB RSS capture time (tests/fixtures/upstream/news-opb/2026-10-05-rss.meta.json). */
const NEWS_CAPTURED = '2026-10-05T06:25:56.283Z';
const quiet = () => {};

/** @type {string} */
let tmp;
before(async () => { tmp = await mkdtemp(path.join(os.tmpdir(), 'cthd-snapshot-')); });
after(async () => { await rm(tmp, { recursive: true, force: true }); });

/** @param {string} name */
const dir = (name) => path.join(tmp, name);
/** @param {string} d @param {string} f */
const readJson = async (d, f) => JSON.parse(await readFile(path.join(d, f), 'utf8'));

/**
 * A tasks directory holding re-exports of the fixture tasks plus extra inline modules.
 * @param {string} name
 * @param {Record<string, string>} [extra] file name to module source
 */
async function tasksDir(name, extra = {}) {
  const d = dir(name);
  await mkdir(d, { recursive: true });
  for (const t of ['news', 'declarations']) {
    await writeFile(path.join(d, `${t}.mjs`), `export { default } from ${JSON.stringify(pathToFileURL(path.join(FIXTURE_TASKS, `${t}.mjs`)).href)};\n`);
  }
  for (const [f, src] of Object.entries(extra)) await writeFile(path.join(d, f), src);
  return d;
}

/** @param {Partial<import('../../../scripts/snapshot/run.mjs').RunOptions> & { out: string }} o */
const run = (o) => runSnapshot({ tasksDir: FIXTURE_TASKS, fixtures: FIXTURES, buildSha: SHA, now: T0, previous: null, log: quiet, ...o });

describe('dry run against fixtures', () => {
  test('writes valid envelopes and a manifest with correct hashes, last', async () => {
    const out = dir('dry');
    const r = await run({ out });
    assert.equal(r.writeOrder.at(-1), 'manifest.json');
    assert.equal(r.writeOrder.at(-2), 'health.json');
    assert.deepEqual(await validateLive(out), []);
    const manifest = await readJson(out, 'manifest.json');
    assert.equal(manifest.buildSha, SHA);
    assert.deepEqual(manifest.files.map((/** @type {{ path: string }} */ f) => f.path),
      ['data/live/declarations-fema.json', 'data/live/health.json', 'data/live/news.json']);
    for (const f of manifest.files) {
      const bytes = await readFile(path.join(out, f.path.replace('data/live/', '')));
      assert.equal(f.sha256, sha256(bytes));
      assert.equal(f.bytes, bytes.length);
    }
    const news = await readJson(out, 'news.json');
    assert.equal(news.completeness, 'complete');
    assert.equal(news.carriedForward, false);
    assert.ok(news.items.length > 0);
    assert.equal(news.observedAt, NEWS_CAPTURED, 'a fixture run reports the capture time, never the run time');
    assert.equal(news.generatedAt, T0.toISOString());
    const decl = await readJson(out, 'declarations-fema.json');
    assert.equal(decl.items.length, 1);
    assert.equal(decl.items[0].designatedAreas.length, 49);
  });
});

describe('carry-forward', () => {
  test('a forced failure (SNAPSHOT_FAIL) carries forward with the original observedAt and still writes the manifest', async () => {
    const first = dir('cf-first');
    await run({ out: first });
    const out = dir('cf-second');
    const later = new Date(T0.getTime() + 3 * 3600_000);
    const r = await run({ out, previous: first, failIds: ['news', 'declarations'], now: later });
    assert.equal(r.writeOrder.at(-1), 'manifest.json');
    assert.deepEqual(await validateLive(out), []);
    for (const f of ['news.json', 'declarations-fema.json']) {
      const prev = await readJson(first, f);
      const cur = await readJson(out, f);
      assert.equal(cur.carriedForward, true, f);
      assert.equal(cur.observedAt, prev.observedAt, f);
      assert.equal(cur.asOf, prev.asOf, f);
      assert.deepEqual(cur.items, prev.items, f);
      assert.equal(cur.failure.code, 'forced-failure');
      assert.equal(cur.generatedAt, later.toISOString());
    }
    const health = await readJson(out, 'health.json');
    const news = health.items.find((/** @type {{ id: string, kind: string }} */ i) => i.id === 'news' && i.kind === 'task');
    assert.equal(news.state, 'degraded');
    assert.equal(news.carriedForward, true);
  });

  test('the CLI honors SNAPSHOT_FAIL and exits zero', async () => {
    const first = dir('cli-first');
    await run({ out: first });
    const out = dir('cli-second');
    const res = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'snapshot', 'run.mjs'), '--out', out, '--previous', first,
      '--tasks-dir', FIXTURE_TASKS, '--fixtures', FIXTURES, '--now', '2026-10-05T12:00:00Z', '--build-sha', SHA],
    { env: { ...process.env, SNAPSHOT_FAIL: 'news,declarations' }, encoding: 'utf8' });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /news: forced to fail by SNAPSHOT_FAIL/);
    assert.equal((await readJson(out, 'news.json')).carriedForward, true);
    assert.deepEqual(await validateLive(out), []);
  });

  test('with no previous copy the file is rejected with no items (rendered Unavailable)', async () => {
    const out = dir('rejected');
    await run({ out, failIds: ['news'] });
    const news = await readJson(out, 'news.json');
    assert.equal(news.completeness, 'rejected');
    assert.equal(news.carriedForward, false);
    assert.deepEqual(news.items, []);
    assert.equal(news.asOf, null);
    assert.equal(news.failure.code, 'forced-failure');
    assert.deepEqual(news.perSource, { 'news-opb': { ok: false, count: 0, asOf: null } });
    const health = await readJson(out, 'health.json');
    assert.equal(health.items.find((/** @type {{ id: string }} */ i) => i.id === 'news').state, 'unavailable');
    assert.equal((await readJson(out, 'declarations-fema.json')).completeness, 'complete');
    assert.deepEqual(await validateLive(out), []);
  });

  test('a task returning its own rejected envelope carries the previous good file forward', async () => {
    const first = dir('own-rejected-first');
    await run({ out: first });
    const out = dir('own-rejected-second');
    await run({ out, previous: first, fixtures: null, force: true,
      httpFor: () => ({
        getJson: async (sourceId) => ({ ok: false, error: { kind: 'http', status: 503, message: 'HTTP 503' }, fetchedAt: T0.toISOString(), sourceId }),
        getText: async (sourceId) => ({ ok: false, error: { kind: 'timeout', message: 'no response' }, fetchedAt: T0.toISOString(), sourceId }),
        head: async (sourceId) => ({ ok: false, error: { kind: 'network', message: 'down' }, fetchedAt: T0.toISOString(), sourceId }),
      }) });
    const news = await readJson(out, 'news.json');
    assert.equal(news.carriedForward, true);
    assert.equal(news.observedAt, NEWS_CAPTURED);
    assert.equal(news.failure.code, 'timeout');
    assert.ok(news.items.length > 0);
  });

  test('a task that throws, returns an invalid envelope, or exceeds its budget never blocks the others', async () => {
    const tasks = await tasksDir('bad-tasks', {
      'thrower.mjs': "export default { id: 'tsunami', sourceIds: ['ntwc-atom'], cadenceMin: 10, outputs: ['tsunami.json'], async run() { throw new Error('boom'); } };\n",
      'invalid.mjs': "export default { id: 'wsc', sourceIds: ['eccc-hydrometric-realtime'], cadenceMin: 30, outputs: ['wsc-status.json'], async run() { return { 'wsc-status.json': { schema: 'cthd.live.wsc-status/1', items: 'nope' } }; } };\n",
      'slow.mjs': "export default { id: 'ar-products', sourceIds: ['cw3e-images'], cadenceMin: 60, outputs: ['ar-products.json'], run() { return new Promise(() => {}); } };\n",
      'broken.mjs': "export default { id: 'Not Kebab', outputs: [] };\n",
    });
    const out = dir('bad-out');
    const r = await run({ out, tasksDir: tasks, budgetMs: 200 });
    assert.deepEqual(await validateLive(out), []);
    const codes = Object.fromEntries(r.outcomes.map((o) => [o.id, o.failure?.code ?? null]));
    assert.equal(codes.tsunami, 'task-threw');
    assert.equal(codes.wsc, 'invalid-envelope');
    assert.equal(codes['ar-products'], 'task-timeout');
    assert.equal(codes.broken, 'invalid-task-module');
    assert.equal(codes.news, null);
    for (const f of ['tsunami.json', 'wsc-status.json', 'ar-products.json']) assert.equal((await readJson(out, f)).completeness, 'rejected', f);
    assert.equal((await readJson(out, 'news.json')).completeness, 'complete');
    const health = await readJson(out, 'health.json');
    assert.equal(health.diagnostics.tasksInvalid, 1);
    assert.equal(health.diagnostics.tasksFailed, 3);
  });
});

describe('due logic', () => {
  test('skips tasks not yet due and keeps their previous bytes', async () => {
    const first = dir('due-first');
    await run({ out: first, now: new Date(NEWS_CAPTURED) });
    const out = dir('due-second');
    // news: cadence 30 min; declarations: 60 min. Five minutes later neither is due.
    const r = await run({ out, previous: first, now: new Date(Date.parse(NEWS_CAPTURED) + 5 * 60_000) });
    assert.deepEqual(r.outcomes.map((o) => o.result).sort(), ['not-due', 'not-due']);
    for (const f of ['news.json', 'declarations-fema.json']) {
      assert.deepEqual(await readFile(path.join(out, f)), await readFile(path.join(first, f)), `${f} is byte-identical`);
    }
    assert.deepEqual(await validateLive(out), []);
  });

  test('runs a task once its previous observation is older than cadence minus two minutes', async () => {
    const first = dir('due-third');
    await run({ out: first, now: new Date(NEWS_CAPTURED) });
    const out = dir('due-fourth');
    const r = await run({ out, previous: first, now: new Date(Date.parse(NEWS_CAPTURED) + (30 - DUE_SLACK_MIN) * 60_000 + 1000) });
    const byId = Object.fromEntries(r.outcomes.map((o) => [o.id, o.result]));
    assert.equal(byId.news, 'ran');
    assert.equal(byId.declarations, 'not-due');
  });

  test('isDue: missing, failed, carried-forward, and rejected previous files are always due', () => {
    const task = /** @type {any} */ ({ id: 'news', sourceIds: ['news-opb'], cadenceMin: 30, outputs: ['news.json'], run: async () => ({}) });
    const now = new Date('2026-10-05T07:00:00Z');
    const fresh = { observedAt: '2026-10-05T06:55:00Z', failure: null, carriedForward: false, completeness: 'complete' };
    /** @param {object} e */
    const prev = (e) => new Map([['news.json', /** @type {any} */ (e)]]);
    assert.equal(isDue(task, new Map(), now), true);
    assert.equal(isDue(task, prev(fresh), now), false);
    assert.equal(isDue(task, prev({ ...fresh, carriedForward: true }), now), true);
    assert.equal(isDue(task, prev({ ...fresh, failure: { code: 'x', message: '', at: fresh.observedAt } }), now), true);
    assert.equal(isDue(task, prev({ ...fresh, completeness: 'rejected' }), now), true);
    assert.equal(isDue(task, prev({ ...fresh, observedAt: '2026-10-05T06:32:00Z' }), now), true, '28 minutes old with a 30-minute cadence');
    assert.equal(isDue(task, prev({ ...fresh, observedAt: '2026-10-05T06:32:01Z' }), now), false);
  });
});

describe('task contract', () => {
  test('taskProblems accepts a well-formed task and names each defect', () => {
    assert.deepEqual(taskProblems({ id: 'news', sourceIds: ['news-opb'], cadenceMin: 30, outputs: ['news.json'], run() {} }), []);
    assert.equal(taskProblems(null).length, 1);
    assert.equal(taskProblems({ id: 'x', sourceIds: [], cadenceMin: 0, outputs: ['manifest.json'] }).length, 4);
  });

  test('stale envelopes from an earlier run are removed from the output directory', async () => {
    const out = dir('stale');
    await mkdir(out, { recursive: true });
    await writeFile(path.join(out, 'old-task.json'), '{}');
    await run({ out });
    assert.deepEqual(await validateLive(out), []);
  });
});
