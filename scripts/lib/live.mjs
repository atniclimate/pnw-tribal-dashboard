// @ts-check
/**
 * Live snapshot envelopes, checks, health, and the manifest (blueprint 5.10, 6.4, 6.6). Shared by
 * `scripts/snapshot/run.mjs` and `scripts/check/validate-live.mjs`. Owner: lane L9.
 */
import { createHash } from 'node:crypto';
import { SCHEMA_BASE } from '../check/lib/data-files.mjs';

/** @typedef {import('../../site/static/js/types.js').LiveEnvelope<unknown>} Envelope */
/** @typedef {import('../../site/static/js/types.js').LiveManifest} LiveManifest */
/** @typedef {import('../../site/static/js/types.js').StatusState} StatusState */
/** @typedef {{ code: string, message: string, at: string }} Failure */
/** @typedef {import('ajv/dist/2020.js').Ajv2020} Ajv */

export const LIVE_FILE = /^[a-z0-9]+(-[a-z0-9]+)*\.json$/;
export const MANIFEST_FILE = 'manifest.json';
export const HEALTH_FILE = 'health.json';
/** Source id of the health file (registered by lane L15 as data/sources/cthd-health.yaml). */
export const HEALTH_SOURCE_ID = 'cthd-health';

/** Live sanity bounds (blueprint 6.6). */
export const MAX_ITEMS = Object.freeze(/** @type {Record<string, number>} */ ({ 'alerts.json': 2000, 'declarations-fema.json': 500 }));
export { STAGE_FT_MIN, STAGE_FT_MAX } from '../../site/static/js/core/units.js';
import { STAGE_FT_MIN, STAGE_FT_MAX } from '../../site/static/js/core/units.js';
/** Numeric values upstreams use for "no data"; none may reach a live file. */
export const SENTINELS = Object.freeze([-999, -9999, -99999, -999999, -9999999]);
const FT_PER_M = 3.280839895;

/** @param {string} file */
export function stemOf(file) {
  return file.replace(/\.json$/, '');
}

/** @param {string} file */
export function schemaUrlFor(file) {
  return `${SCHEMA_BASE}live-${stemOf(file)}.schema.json`;
}

/** @param {string | Buffer} bytes */
export function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * Serialize an envelope exactly as it is written to disk.
 * @param {unknown} value
 */
export function serialize(value) {
  return `${JSON.stringify(value)}\n`;
}

/**
 * @param {string} code
 * @param {string} message
 * @param {Date} now
 * @returns {Failure}
 */
export function failure(code, message, now) {
  return { code, message: message.slice(0, 500), at: now.toISOString() };
}

/**
 * The file a failed task writes when no previous copy exists: `rejected`, no items, rendered Unavailable.
 * @param {{ id: string, sourceIds: string[] }} task
 * @param {string} file
 * @param {Failure} fail
 * @param {Date} now
 * @returns {Envelope}
 */
export function rejectedEnvelope(task, file, fail, now) {
  const at = now.toISOString();
  return {
    schema: /** @type {`cthd.live.${string}/1`} */ (`cthd.live.${stemOf(file)}/1`),
    id: task.id,
    sourceIds: [...task.sourceIds],
    generatedAt: at,
    observedAt: at,
    asOf: null,
    asOfBasis: null,
    completeness: 'rejected',
    carriedForward: false,
    failure: fail,
    perSource: Object.fromEntries(task.sourceIds.map((id) => [id, { ok: false, count: 0, asOf: null }])),
    diagnostics: {},
    items: [],
  };
}

/**
 * The previous deploy's file, carried forward after a failure: items, `observedAt`, and `asOf` kept.
 * @param {Envelope} previous
 * @param {Failure} fail
 * @param {Date} now
 * @returns {Envelope}
 */
export function carriedEnvelope(previous, fail, now) {
  return { ...previous, generatedAt: now.toISOString(), carriedForward: true, failure: fail };
}

/**
 * Walk every value under `value`, calling `visit` on each plain object and number.
 * @param {unknown} value
 * @param {(v: unknown, at: string) => void} visit
 * @param {string} [at]
 */
function walk(value, visit, at = '') {
  visit(value, at);
  if (Array.isArray(value)) value.forEach((v, i) => walk(v, visit, `${at}/${i}`));
  else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) walk(v, visit, `${at}/${k}`);
}

/**
 * Sanity checks beyond the schema (blueprint 6.6, live payload gate).
 * @param {string} file
 * @param {Envelope} env
 * @returns {string[]}
 */
export function sanityErrors(file, env) {
  /** @type {string[]} */
  const errors = [];
  const max = MAX_ITEMS[file];
  if (max !== undefined && env.items.length > max) errors.push(`${env.items.length} items exceeds the bound of ${max}`);
  /** @type {[string, unknown][]} */
  const times = [['/asOf', env.asOf], ['/observedAt', env.observedAt], ['/generatedAt', env.generatedAt],
    ...Object.entries(env.perSource ?? {}).map(([k, v]) => /** @type {[string, unknown]} */ ([`/perSource/${k}/asOf`, v?.asOf]))];
  for (const [at, t] of times) if (t !== null && (typeof t !== 'string' || Number.isNaN(Date.parse(t)))) errors.push(`${at} does not parse as a time`);
  walk(env.items, (v, at) => {
    if (typeof v === 'number' && SENTINELS.includes(v)) errors.push(`/items${at} is the sentinel value ${v}`);
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const o = /** @type {Record<string, unknown>} */ (v);
      const unit = typeof o.unit === 'string' ? o.unit.toLowerCase() : null;
      const factor = unit === 'ft' || unit === 'feet' ? 1 : unit === 'm' || unit === 'meters' ? FT_PER_M : null;
      if (factor === null) return;
      for (const key of ['stage', 'crestStage']) {
        const s = o[key];
        if (typeof s === 'number' && (s * factor < STAGE_FT_MIN || s * factor > STAGE_FT_MAX)) {
          errors.push(`/items${at}/${key} ${s} ${unit} is outside ${STAGE_FT_MIN} to ${STAGE_FT_MAX} ft`);
        }
      }
    }
  });
  return errors;
}

/**
 * Schema and sanity errors for one live envelope.
 * @param {Ajv} ajv with every schema in schemas/ registered
 * @param {string} file output file name, for example `news.json`
 * @param {unknown} value
 * @returns {string[]} empty when valid
 */
export function envelopeErrors(ajv, file, value) {
  if (!LIVE_FILE.test(file) || file === MANIFEST_FILE) return [`${file} is not a live envelope file name`];
  const validate = ajv.getSchema(schemaUrlFor(file));
  if (!validate) return [`no schema ${schemaUrlFor(file)}`];
  if (!validate(value)) return (validate.errors ?? []).slice(0, 10).map((e) => `${e.instancePath || '/'} ${e.message ?? ''}`.trim());
  return sanityErrors(file, /** @type {Envelope} */ (value));
}

/**
 * The state the health table shows for a set of output envelopes. Clients still derive their own state
 * from `asOf` and the source's freshness policy (blueprint 5.10).
 * @param {Envelope[]} envs
 * @returns {StatusState}
 */
export function healthState(envs) {
  if (envs.length === 0 || envs.some((e) => e.completeness === 'rejected')) return 'unavailable';
  if (envs.some((e) => e.carriedForward || e.completeness === 'partial')) return 'degraded';
  return 'live';
}

/**
 * @typedef {object} TaskOutcome
 * @property {string} id task id (or task module name when the module failed to load)
 * @property {'ran' | 'not-due' | 'failed' | 'invalid-module'} result
 * @property {Record<string, Envelope>} envelopes output file to the envelope written this run
 * @property {Failure | null} failure
 */

/**
 * Build `health.json` from this run's task outcomes.
 * @param {TaskOutcome[]} outcomes
 * @param {Date} now
 * @param {{ step: string, message: string, at: string } | null} [compileFailure] recorded by the compile fallback
 * @returns {Envelope}
 */
export function healthEnvelope(outcomes, now, compileFailure = null) {
  const at = now.toISOString();
  /** @type {Record<string, unknown>[]} */
  const items = [];
  /** @type {Record<string, { ok: boolean, count: number, asOf: string | null }>} */
  const perSource = {};
  /** @type {Map<string, { observedAt: string, carriedForward: boolean, failure: Failure | null, envs: Envelope[] }>} */
  const sources = new Map();
  const counts = { tasksRun: 0, tasksNotDue: 0, tasksFailed: 0, tasksInvalid: 0, filesCarriedForward: 0, filesRejected: 0 };
  for (const o of [...outcomes].sort((a, b) => a.id.localeCompare(b.id))) {
    const envs = Object.values(o.envelopes);
    if (o.result === 'ran') counts.tasksRun++;
    else if (o.result === 'not-due') counts.tasksNotDue++;
    else if (o.result === 'failed') counts.tasksFailed++;
    else counts.tasksInvalid++;
    counts.filesCarriedForward += envs.filter((e) => e.carriedForward).length;
    counts.filesRejected += envs.filter((e) => e.completeness === 'rejected').length;
    const observed = envs.map((e) => e.observedAt).sort()[0] ?? null;
    const detail = o.result === 'ran' ? `Ran this deploy; ${envs.map((e) => e.completeness).join(', ')}.`
      : o.result === 'not-due' ? 'Not due this deploy; the previous files were kept unchanged.'
        : o.result === 'invalid-module' ? 'The task module could not be loaded.'
          : envs.some((e) => e.carriedForward) ? 'Failed this deploy; the previous files were carried forward.'
            : 'Failed this deploy with no previous copy; shown as Unavailable.';
    items.push({ id: o.id, kind: 'task', state: healthState(envs), observedAt: observed,
      carriedForward: envs.some((e) => e.carriedForward), failure: o.failure, detail });
    for (const e of envs) {
      for (const [sid, ps] of Object.entries(e.perSource)) {
        const cur = perSource[sid];
        perSource[sid] = cur ? { ok: cur.ok && ps.ok, count: cur.count + ps.count, asOf: [cur.asOf, ps.asOf].filter(Boolean).sort().pop() ?? null } : { ...ps };
        const s = sources.get(sid) ?? { observedAt: e.observedAt, carriedForward: false, failure: /** @type {Failure | null} */ (null), envs: /** @type {Envelope[]} */ ([]) };
        if (e.observedAt < s.observedAt) s.observedAt = e.observedAt;
        s.carriedForward ||= e.carriedForward;
        s.failure ??= e.failure;
        s.envs.push(e);
        sources.set(sid, s);
      }
    }
  }
  for (const [sid, s] of [...sources].sort((a, b) => a[0].localeCompare(b[0]))) {
    const ps = perSource[sid];
    items.push({ id: sid, kind: 'source', state: ps && !ps.ok && !s.carriedForward ? 'unavailable' : healthState(s.envs),
      observedAt: s.observedAt, carriedForward: s.carriedForward, failure: s.failure,
      detail: `${ps?.count ?? 0} records; ${ps?.ok ? 'last fetch succeeded' : 'last fetch failed'}.` });
  }
  if (compileFailure) {
    items.push({ id: `compile-${compileFailure.step}`, kind: 'compile', state: 'degraded', observedAt: compileFailure.at, carriedForward: true,
      failure: { code: 'compile-failed', message: compileFailure.message.slice(0, 500), at: compileFailure.at },
      detail: 'The curated compile failed; the last good compiled files from production were deployed.' });
  }
  return {
    schema: 'cthd.live.health/1', id: 'health', sourceIds: [HEALTH_SOURCE_ID], generatedAt: at, observedAt: at, asOf: at,
    asOfBasis: 'observed', completeness: 'complete', carriedForward: false, failure: null, perSource, diagnostics: counts, items,
  };
}

/**
 * @param {{ file: string, bytes: Buffer, envelope: Envelope }[]} written
 * @param {Date} now
 * @param {string} buildSha
 * @returns {LiveManifest}
 */
export function buildManifest(written, now, buildSha) {
  return {
    schema: 'cthd.live.manifest/1',
    generatedAt: now.toISOString(),
    buildSha,
    files: [...written].sort((a, b) => a.file.localeCompare(b.file)).map((w) => ({
      path: `data/live/${w.file}`, sha256: sha256(w.bytes), bytes: w.bytes.length,
      observedAt: w.envelope.observedAt, carriedForward: w.envelope.carriedForward,
    })),
  };
}
