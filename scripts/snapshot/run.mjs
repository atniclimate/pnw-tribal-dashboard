// @ts-check
/**
 * Snapshot runner (blueprint 5.10, 6.4). Owner: lane L9.
 *
 *   node scripts/snapshot/run.mjs --out site/data/live
 *        [--previous <deployed data/live/ URL or a local directory>]
 *        [--tasks alerts,news] [--force] [--fixtures tests/fixtures/upstream] [--tasks-dir <dir>]
 *        [--now <ISO time>] [--build-sha <sha>]
 *
 * Loads every task module in scripts/snapshot/tasks/, reads the previously deployed manifest and files,
 * runs the tasks that are due (previous `observedAt` older than `cadenceMin` minus two minutes, or a
 * previous failure) with concurrency four and a ninety-second budget each, and carries forward the
 * previous file for any task that failed or was not due. A failed task with no previous copy writes a
 * `rejected` envelope with no items, which the client renders as Unavailable, never as "none."
 * Every envelope is validated against schemas/live-<file>.schema.json and the live sanity bounds before
 * it is written; then health.json is written, and the manifest is written last.
 *
 * `SNAPSHOT_FAIL=news,declarations` forces the named tasks to fail (they do not run), to prove carry-forward.
 * One task failing never blocks the deploy; the runner exits nonzero only on a programming error in the
 * runner itself (for example an unwritable output directory).
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { loadAjv } from '../check/lib/data-files.mjs';
import { readCompileFailure } from '../lib/compile-fallback.mjs';
import { createFixtureHttp, createHttp, getOwn, joinLocation, loadSourceRegistry } from '../lib/http.mjs';
import {
  HEALTH_FILE, LIVE_FILE, MANIFEST_FILE, buildManifest, carriedEnvelope, envelopeErrors, failure, healthEnvelope,
  rejectedEnvelope, schemaUrlFor, serialize,
} from '../lib/live.mjs';

/** @typedef {import('../../site/static/js/types.js').SnapshotTask} SnapshotTask */
/** @typedef {import('../../site/static/js/types.js').SnapshotHttp} SnapshotHttp */
/** @typedef {import('../../site/static/js/types.js').LiveEnvelope<unknown>} Envelope */
/** @typedef {import('../../site/static/js/types.js').LiveManifest} LiveManifest */
/** @typedef {import('../lib/live.mjs').TaskOutcome} TaskOutcome */
/** @typedef {import('../lib/live.mjs').Failure} Failure */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const DEFAULT_TASKS_DIR = path.join(ROOT, 'scripts', 'snapshot', 'tasks');
export const CONCURRENCY = 4;
export const TASK_BUDGET_MS = 90_000;
/** A task is due when its previous observation is older than `cadenceMin` minus this many minutes. */
export const DUE_SLACK_MIN = 2;
const KEBAB = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const RESERVED = new Set([HEALTH_FILE, MANIFEST_FILE]);
/** @type {ReturnType<typeof loadAjv> | undefined} */
let ajvOnce;

/**
 * @typedef {object} RunOptions
 * @property {string} out output directory (site/data/live)
 * @property {string | null} [previous] deployed data/live/ base URL or a local directory
 * @property {string} [tasksDir]
 * @property {string[] | null} [only] run only these task ids (others are carried forward as not due)
 * @property {boolean} [force] ignore the due logic
 * @property {string[]} [failIds] task ids forced to fail (SNAPSHOT_FAIL)
 * @property {Date} [now]
 * @property {string | null} [fixtures] answer requests from fixture captures instead of the network
 * @property {(task: SnapshotTask, signal: AbortSignal) => SnapshotHttp} [httpFor]
 * @property {string} [buildSha]
 * @property {number} [budgetMs]
 * @property {number} [concurrency]
 * @property {string} [root] repository root (registry, reference data, source registry)
 * @property {(input: string, init?: RequestInit) => Promise<Response>} [fetchImpl] for reading the previous deploy
 * @property {(message: string) => void} [log]
 */

/**
 * @typedef {object} RunResult
 * @property {TaskOutcome[]} outcomes
 * @property {string[]} writeOrder file names in the order written (manifest.json last)
 * @property {LiveManifest} manifest
 */

/**
 * Check a task module's default export against the SnapshotTask contract.
 * @param {unknown} t
 * @returns {string[]} problems
 */
export function taskProblems(t) {
  const task = /** @type {Partial<SnapshotTask> | null} */ (t && typeof t === 'object' ? t : null);
  if (!task) return ['default export is not an object'];
  /** @type {string[]} */
  const p = [];
  if (typeof task.id !== 'string' || !KEBAB.test(task.id)) p.push('id must be a kebab-case string');
  if (!Array.isArray(task.sourceIds) || task.sourceIds.length === 0 || !task.sourceIds.every((s) => typeof s === 'string' && KEBAB.test(s))) p.push('sourceIds must be a non-empty list of source ids');
  if (typeof task.cadenceMin !== 'number' || !(task.cadenceMin > 0)) p.push('cadenceMin must be a positive number');
  if (!Array.isArray(task.outputs) || task.outputs.length === 0 || !task.outputs.every((f) => typeof f === 'string' && LIVE_FILE.test(f) && !RESERVED.has(f))) p.push('outputs must list live file names');
  if (typeof task.run !== 'function') p.push('run must be a function');
  return p;
}

/**
 * Whether a task should run now.
 * @param {SnapshotTask} task
 * @param {Map<string, Envelope>} previous valid previous envelopes by file
 * @param {Date} now
 */
export function isDue(task, previous, now) {
  for (const file of task.outputs) {
    const env = previous.get(file);
    if (!env || env.failure !== null || env.carriedForward || env.completeness === 'rejected') return true;
    const ageMin = (now.getTime() - Date.parse(env.observedAt)) / 60_000;
    if (!(ageMin < task.cadenceMin - DUE_SLACK_MIN)) return true;
  }
  return false;
}

/**
 * Run `fn` concurrently over `items`, at most `limit` at a time.
 * @template T
 * @param {T[]} items
 * @param {number} limit
 * @param {(item: T) => Promise<void>} fn
 */
async function pool(items, limit, fn) {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const item = /** @type {T} */ (items[next++]);
      await fn(item);
    }
  });
  await Promise.all(workers);
}

/**
 * Resolve the build commit for the manifest.
 * @param {string | undefined} given
 * @param {string} root
 */
export function resolveBuildSha(given, root) {
  const sha = given || process.env.GITHUB_SHA || (() => {
    try { return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(); } catch { return ''; }
  })();
  if (!/^[0-9a-f]{7,40}$/.test(sha)) throw new Error(`no usable build sha (got "${sha}"); pass --build-sha`);
  return sha;
}

/**
 * Load task modules from a directory, in file-name order.
 * @param {string} dir
 * @param {(m: string) => void} log
 * @param {(file: string) => boolean} hasSchema
 * @param {Date} now
 * @returns {Promise<{ tasks: SnapshotTask[], invalid: TaskOutcome[] }>}
 */
async function loadTasks(dir, log, hasSchema, now) {
  /** @type {string[]} */
  let names = [];
  try { names = (await readdir(dir)).filter((n) => n.endsWith('.mjs')).sort(); } catch { /* no tasks yet */ }
  /** @type {SnapshotTask[]} */
  const tasks = [];
  /** @type {TaskOutcome[]} */
  const invalid = [];
  const outputs = new Set();
  const ids = new Set();
  for (const n of names) {
    const name = n.replace(/\.mjs$/, '');
    /** @type {string[]} */
    let problems;
    /** @type {SnapshotTask | null} */
    let task = null;
    try {
      const mod = await import(pathToFileURL(path.join(dir, n)).href);
      task = mod.default;
      problems = taskProblems(task);
    } catch (e) {
      problems = [`import failed: ${/** @type {Error} */ (e).message}`];
    }
    if (task && problems.length === 0) {
      if (ids.has(task.id)) problems.push(`duplicate task id ${task.id}`);
      for (const f of task.outputs) {
        if (outputs.has(f)) problems.push(`output ${f} is already written by another task`);
        if (!hasSchema(f)) problems.push(`no schema ${schemaUrlFor(f)}`);
      }
    }
    if (!task || problems.length > 0) {
      const id = task && typeof task.id === 'string' && KEBAB.test(task.id) ? task.id : name;
      log(`task module ${n} is invalid: ${problems.join('; ')}`);
      invalid.push({ id, result: 'invalid-module', envelopes: {}, failure: failure('invalid-task-module', problems.join('; '), now) });
      continue;
    }
    ids.add(task.id);
    for (const f of task.outputs) outputs.add(f);
    tasks.push(task);
  }
  return { tasks, invalid };
}

/**
 * @param {RunOptions} opts
 * @returns {Promise<RunResult>}
 */
export async function runSnapshot(opts) {
  const root = opts.root ?? ROOT;
  const now = opts.now ?? new Date();
  const log = opts.log ?? ((m) => console.log(`[snapshot] ${m}`));
  const budgetMs = opts.budgetMs ?? TASK_BUDGET_MS;
  const failIds = new Set(opts.failIds ?? []);
  const buildSha = resolveBuildSha(opts.buildSha, root);
  ajvOnce ??= loadAjv();
  const ajv = await ajvOnce;

  const { tasks, invalid } = await loadTasks(opts.tasksDir ?? DEFAULT_TASKS_DIR, log, (f) => Boolean(ajv.getSchema(schemaUrlFor(f))), now);
  log(`${tasks.length} task(s): ${tasks.map((t) => t.id).join(', ') || 'none'}`);
  for (const id of failIds) if (!tasks.some((t) => t.id === id)) log(`SNAPSHOT_FAIL names "${id}", which is not a loaded task`);

  // Previous deploy: manifest, then each output file (raw bytes kept so unchanged files stay identical).
  /** @type {LiveManifest | null} */
  let prevManifest = null;
  /** @type {Map<string, { text: string, env: Envelope }>} */
  const prev = new Map();
  if (opts.previous) {
    const base = opts.previous;
    const getOpts = opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {};
    const mText = await getOwn(joinLocation(base, MANIFEST_FILE), getOpts);
    try { prevManifest = mText ? JSON.parse(mText) : null; } catch { prevManifest = null; }
    const listed = prevManifest && Array.isArray(prevManifest.files) ? new Set(prevManifest.files.map((f) => f.path.replace(/^data\/live\//, ''))) : null;
    const files = tasks.flatMap((t) => t.outputs).filter((f) => !listed || listed.has(f));
    await pool(files, 8, async (file) => {
      const text = await getOwn(joinLocation(base, file), getOpts);
      if (text === null) return;
      /** @type {unknown} */
      let env;
      try { env = JSON.parse(text); } catch { log(`previous ${file} is not JSON; ignored`); return; }
      const errors = envelopeErrors(ajv, file, env);
      if (errors.length > 0) { log(`previous ${file} fails validation (${errors[0]}); ignored`); return; }
      prev.set(file, { text, env: /** @type {Envelope} */ (env) });
    });
    log(`previous deploy: manifest ${prevManifest ? 'found' : 'absent'}, ${prev.size} usable file(s)`);
  }
  const prevEnvs = new Map([...prev].map(([f, p]) => [f, p.env]));

  // Context shared by tasks.
  const sharedHttp = opts.fixtures ? await createFixtureHttp(opts.fixtures) : null;
  const registry = opts.fixtures || opts.httpFor ? null : await loadSourceRegistry(root);
  const httpFor = opts.httpFor ?? ((_task, signal) => sharedHttp ?? createHttp({ registry, signal }));
  const registryDir = path.join(root, 'site', 'data', 'registry');
  /** @type {unknown} */
  let indexCache;
  const registryCtx = {
    get index() {
      if (indexCache === undefined) indexCache = JSON.parse(readFileSync(path.join(registryDir, 'nations-index.json'), 'utf8'));
      return /** @type {import('../../site/static/js/types.js').NationsIndex} */ (indexCache);
    },
    /** @param {string} id */
    async nation(id) {
      if (!KEBAB.test(id)) return null;
      try { return JSON.parse(await readFile(path.join(registryDir, 'nations', `${id}.json`), 'utf8')); } catch { return null; }
    },
  };
  /** @param {string} file */
  async function reference(file) {
    if (!/^[a-z0-9][a-z0-9.-]*\.json$/.test(file)) throw new Error(`invalid reference file name ${file}`);
    for (const dir of ['ref', 'geo']) {
      try { return JSON.parse(await readFile(path.join(root, 'site', 'data', dir, file), 'utf8')); } catch (e) {
        if (/** @type {NodeJS.ErrnoException} */ (e).code !== 'ENOENT') throw e;
      }
    }
    throw new Error(`reference file ${file} is not built (site/data/ref or site/data/geo)`);
  }

  /** @type {Map<string, { bytes: Buffer, envelope: Envelope }>} */
  const finals = new Map();
  /** @type {TaskOutcome[]} */
  const outcomes = [...invalid];

  /**
   * Settle one output after a failure: carry the previous file forward, or reject.
   * @param {SnapshotTask} task
   * @param {string} file
   * @param {Failure} fail
   * @param {Envelope | null} [rejected] the task's own rejected envelope, if it returned one
   */
  function settleFailure(task, file, fail, rejected = null) {
    const p = prevEnvs.get(file);
    const env = p && p.completeness !== 'rejected' ? carriedEnvelope(p, fail, now) : (rejected ?? rejectedEnvelope(task, file, fail, now));
    finals.set(file, { bytes: Buffer.from(serialize(env)), envelope: env });
    return env;
  }

  const selected = opts.only ? new Set(opts.only) : null;
  await pool(tasks, opts.concurrency ?? CONCURRENCY, async (task) => {
    const excluded = selected !== null && !selected.has(task.id);
    const run = !excluded && (failIds.has(task.id) || selected !== null || opts.force || isDue(task, prevEnvs, now));
    if (!run) {
      // Not due (every output has a usable previous file) or excluded by --tasks: keep the previous bytes.
      /** @type {Record<string, Envelope>} */
      const envelopes = {};
      for (const f of task.outputs) {
        const p = prev.get(f);
        if (!p) continue;
        finals.set(f, { bytes: Buffer.from(p.text), envelope: p.env });
        envelopes[f] = p.env;
      }
      log(`${task.id}: ${excluded ? 'not selected' : 'not due'}; previous files kept`);
      outcomes.push({ id: task.id, result: 'not-due', envelopes, failure: null });
      return;
    }
    /** @type {Failure | null} */
    let runFailure = null;
    /** @type {Record<string, unknown> | null} */
    let result = null;
    if (failIds.has(task.id)) {
      runFailure = failure('forced-failure', 'Forced by SNAPSHOT_FAIL; the task did not run.', now);
      log(`${task.id}: forced to fail by SNAPSHOT_FAIL`);
    } else {
      const ctl = new AbortController();
      /** @type {NodeJS.Timeout | undefined} */
      let timer;
      const budget = new Promise((_, reject) => {
        timer = setTimeout(() => { ctl.abort(); reject(new Error(`exceeded the ${Math.round(budgetMs / 1000)}-second task budget`)); }, budgetMs);
      });
      const ctx = {
        now, http: httpFor(task, ctl.signal), registry: registryCtx, reference,
        /** @param {string} file */
        previous: async (file) => prevEnvs.get(file) ?? null,
        /** @param {string} m */
        log: (m) => log(`${task.id}: ${m}`),
      };
      const started = Date.now();
      try {
        result = /** @type {Record<string, unknown>} */ (await Promise.race([task.run(ctx), budget]));
        if (!result || typeof result !== 'object') throw new Error('run() did not return a record of envelopes');
      } catch (e) {
        const msg = /** @type {Error} */ (e).message;
        runFailure = failure(/budget/.test(msg) ? 'task-timeout' : 'task-threw', msg, now);
      } finally {
        clearTimeout(timer);
      }
      log(`${task.id}: ran in ${Date.now() - started} ms${runFailure ? ` and failed (${runFailure.message})` : ''}`);
    }
    /** @type {Record<string, Envelope>} */
    const envelopes = {};
    /** @type {Failure | null} */
    let firstFailure = runFailure;
    for (const file of task.outputs) {
      if (runFailure) { envelopes[file] = settleFailure(task, file, runFailure); continue; }
      const raw = /** @type {Record<string, unknown>} */ (result)[file];
      /** @type {Failure | null} */
      let f = null;
      if (raw === undefined) f = failure('missing-output', `run() returned no ${file}`, now);
      else {
        const env = /** @type {Envelope} */ ({ ...(/** @type {object} */ (raw)), generatedAt: now.toISOString() });
        const errors = envelopeErrors(ajv, file, env);
        if (errors.length === 0 && env.id !== task.id) errors.push(`id "${env.id}" is not the task id`);
        if (errors.length > 0) f = failure('invalid-envelope', `${file}: ${errors.slice(0, 3).join('; ')}`, now);
        else if (env.completeness === 'rejected') {
          f = env.failure ?? failure('upstream-failed', `${task.id} could not fetch its sources`, now);
          envelopes[file] = settleFailure(task, file, f, env);
          firstFailure ??= f;
          continue;
        } else {
          finals.set(file, { bytes: Buffer.from(serialize(env)), envelope: env });
          envelopes[file] = env;
          continue;
        }
      }
      log(`${task.id}: ${f.message}`);
      envelopes[file] = settleFailure(task, file, f);
      firstFailure ??= f;
    }
    for (const extra of Object.keys(result ?? {}).filter((k) => !task.outputs.includes(k))) log(`${task.id}: ignored undeclared output ${extra}`);
    outcomes.push({ id: task.id, result: firstFailure ? 'failed' : 'ran', envelopes, failure: firstFailure });
  });

  // Health, validated like every other envelope; a health build bug must not block the deploy.
  const health = healthEnvelope(outcomes, now, await readCompileFailure(root, now));
  const healthErrors = envelopeErrors(ajv, HEALTH_FILE, health);
  if (healthErrors.length > 0) throw new Error(`health.json is invalid (runner bug): ${healthErrors.join('; ')}`);
  finals.set(HEALTH_FILE, { bytes: Buffer.from(serialize(health)), envelope: health });

  // Write: clear stale envelopes, write every file, then the manifest last.
  await mkdir(opts.out, { recursive: true });
  for (const n of await readdir(opts.out)) if (n.endsWith('.json') && !finals.has(n)) await rm(path.join(opts.out, n));
  /** @type {string[]} */
  const writeOrder = [];
  const ordered = [...finals.keys()].filter((f) => f !== HEALTH_FILE).sort();
  for (const file of [...ordered, HEALTH_FILE]) {
    await writeFile(path.join(opts.out, file), /** @type {{ bytes: Buffer }} */ (finals.get(file)).bytes);
    writeOrder.push(file);
  }
  const manifest = buildManifest([...finals].map(([file, v]) => ({ file, ...v })), now, buildSha);
  const mValidate = ajv.getSchema('https://atniclimate.github.io/pnw-tribal-dashboard/schemas/live-manifest.schema.json');
  if (!mValidate || !mValidate(manifest)) throw new Error(`manifest is invalid (runner bug): ${JSON.stringify(mValidate?.errors ?? 'no schema')}`);
  await writeFile(path.join(opts.out, MANIFEST_FILE), serialize(manifest));
  writeOrder.push(MANIFEST_FILE);

  const counts = health.diagnostics;
  log(`wrote ${writeOrder.length} file(s): ${counts.tasksRun} ran, ${counts.tasksNotDue} not due, ${counts.tasksFailed} failed, `
    + `${counts.tasksInvalid} invalid; ${counts.filesCarriedForward} carried forward, ${counts.filesRejected} rejected`);
  return { outcomes, writeOrder, manifest };
}

/** @param {string | undefined} v */
const list = (v) => (v ? v.split(',').map((s) => s.trim()).filter(Boolean) : []);

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({
    options: {
      out: { type: 'string', default: path.join(ROOT, 'site', 'data', 'live') },
      previous: { type: 'string' },
      tasks: { type: 'string' },
      'tasks-dir': { type: 'string' },
      force: { type: 'boolean', default: false },
      fixtures: { type: 'string' },
      now: { type: 'string' },
      'build-sha': { type: 'string' },
    },
  });
  try {
    const now = values.now ? new Date(values.now) : new Date();
    if (Number.isNaN(now.getTime())) throw new Error(`--now ${values.now} is not a time`);
    /** @type {RunOptions} */
    const opts = {
      out: path.resolve(values.out), previous: values.previous ?? null, force: values.force,
      failIds: list(process.env.SNAPSHOT_FAIL), now, fixtures: values.fixtures ? path.resolve(values.fixtures) : null,
      only: values.tasks ? list(values.tasks) : null,
    };
    if (values['tasks-dir']) opts.tasksDir = path.resolve(values['tasks-dir']);
    if (values['build-sha']) opts.buildSha = values['build-sha'];
    await runSnapshot(opts);
    process.exit(0);
  } catch (e) {
    console.error(`[snapshot] runner error: ${/** @type {Error} */ (e).stack ?? e}`);
    process.exit(1);
  }
}
