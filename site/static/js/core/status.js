// @ts-check
/**
 * Port of @ewm/core-status (STATUS_STATES, validateSnapshot, createStatusRegistry, stateFromAge) extended with
 * deriveStatus and the two dashboard rules: sourceIds non-empty, and asOfBasis set whenever asOf is set
 * (blueprint 3.3). DOM-free.
 */
import { formatTime } from './time.js';

/** @typedef {import('../types.js').StatusState} StatusState */
/** @typedef {import('../types.js').StatusSnapshot} StatusSnapshot */
/** @typedef {import('../types.js').FreshnessPolicy} FreshnessPolicy */
/** @typedef {import('../types.js').StatusRegistry} StatusRegistry */
/** @typedef {import('../types.js').StatusInputs} StatusInputs */

/** The five honest states, in CAST order. @type {readonly StatusState[]} */
export const STATUS_STATES = Object.freeze(/** @type {StatusState[]} */ (['live', 'cached', 'stale', 'degraded', 'unavailable']));

const ASOF_BASES = ['issued', 'observed', 'valid', 'model-run', 'retrieved'];

/**
 * Problems with a snapshot; empty means valid. CAST rules, plus the two dashboard rules: `sourceIds` is
 * non-empty, and `asOfBasis` is set whenever `asOf` is set.
 * @param {StatusSnapshot} snapshot
 * @returns {string[]}
 */
export function validateSnapshot(snapshot) {
  /** @type {string[]} */
  const problems = [];
  if (!STATUS_STATES.includes(snapshot.state)) {
    problems.push(`unknown state "${String(snapshot.state)}"`);
  }
  if (snapshot.state !== 'unavailable' && snapshot.asOf === null) {
    problems.push(`state "${snapshot.state}" requires an "asOf" timestamp, and showing data without its age is dishonest`);
  }
  if (snapshot.asOf !== null && Number.isNaN(Date.parse(snapshot.asOf))) {
    problems.push(`"asOf" is not a parseable ISO 8601 timestamp: "${snapshot.asOf}"`);
  }
  // Dashboard rule 1.
  if (!Array.isArray(snapshot.sourceIds) || snapshot.sourceIds.length === 0) {
    problems.push('"sourceIds" must be a non-empty list of registry source ids');
  }
  // Dashboard rule 2.
  if (snapshot.asOf !== null && snapshot.asOf !== undefined && !ASOF_BASES.includes(/** @type {string} */ (snapshot.asOfBasis))) {
    problems.push('"asOfBasis" is required whenever "asOf" is set');
  }
  return problems;
}

/**
 * Registry of panel statuses; throws on unknown ids and dishonest snapshots (CAST semantics). A newly
 * registered id starts honestly as unavailable ("not yet loaded") unless an initial snapshot is given.
 * @returns {StatusRegistry}
 */
export function createStatusRegistry() {
  /** @type {Map<string, StatusSnapshot>} */
  const snapshots = new Map();
  /** @type {Set<import('../types.js').StatusListener>} */
  const listeners = new Set();

  /**
   * @param {string} id
   * @param {StatusSnapshot} snapshot
   */
  const set = (id, snapshot) => {
    const problems = validateSnapshot(snapshot);
    if (problems.length > 0) throw new Error(`invalid status snapshot for "${id}": ${problems.join('; ')}`);
    snapshots.set(id, snapshot);
    for (const listener of [...listeners]) listener(id, snapshot);
  };

  return {
    register(id, initial) {
      if (snapshots.has(id)) throw new Error(`status id "${id}" is already registered`);
      set(id, initial ?? {
        state: 'unavailable', asOf: null, asOfBasis: null, detail: 'not yet loaded', sourceIds: [id],
        origin: 'direct', completeness: 'partial', checkedAt: new Date().toISOString(),
      });
    },
    report(id, snapshot) {
      if (!snapshots.has(id)) throw new Error(`status id "${id}" is not registered`);
      set(id, snapshot);
    },
    get(id) {
      const snapshot = snapshots.get(id);
      if (snapshot === undefined) throw new Error(`status id "${id}" is not registered`);
      return snapshot;
    },
    has: (id) => snapshots.has(id),
    ids: () => [...snapshots.keys()],
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };
}

/**
 * CAST stateFromAge, unchanged: only ever live, stale, or degraded. Cache provenance and total absence are
 * facts the caller knows, not facts derivable from age.
 * @param {string} asOf
 * @param {Date} now
 * @param {FreshnessPolicy} policy
 * @returns {'live' | 'stale' | 'degraded'}
 */
export function stateFromAge(asOf, now, policy) {
  const produced = Date.parse(asOf);
  if (Number.isNaN(produced)) throw new Error(`"asOf" is not a parseable ISO 8601 timestamp: "${asOf}"`);
  if (policy.freshForMs < 0 || policy.usableForMs < policy.freshForMs) {
    throw new Error('invalid freshness policy: require 0 <= freshForMs <= usableForMs');
  }
  const age = now.getTime() - produced;
  if (age <= policy.freshForMs) return 'live';
  if (age <= policy.usableForMs) return 'stale';
  return 'degraded';
}

/**
 * @param {unknown} v
 * @returns {v is { asOf: string }}
 */
const hasAsOf = (v) => typeof v === 'object' && v !== null && typeof /** @type {any} */ (v).asOf === 'string' && Number.isFinite(Date.parse(/** @type {any} */ (v).asOf));

/**
 * Encodes every row of the blueprint 3.3 status table, including the detail text. Order of precedence:
 * a finished direct fetch, a failed direct fetch (snapshot, then device copy), a pending or absent direct
 * fetch (snapshot, then device copy), then unavailable. `asOf` is always when the upstream produced the
 * data, never when it was fetched; the one exception is a source that publishes no time, which the caller
 * marks with basis 'retrieved' (and passes `now` as asOf).
 * @param {StatusInputs} inputs
 * @returns {StatusSnapshot}
 */
export function deriveStatus(inputs) {
  const { sourceIds, policy, now, snapshot, direct, device, unavailableReason } = inputs;
  if (!Array.isArray(sourceIds) || sourceIds.length === 0) throw new Error('deriveStatus: sourceIds must be non-empty');
  const checkedAt = now.toISOString();
  const nowIso = checkedAt;

  /**
   * @param {Partial<StatusSnapshot> & { state: StatusState }} s
   * @returns {StatusSnapshot}
   */
  const out = (s) => /** @type {StatusSnapshot} */ ({
    asOf: null, asOfBasis: null, origin: 'direct', completeness: 'complete', ...s, sourceIds: [...sourceIds], checkedAt,
  });

  const unavailable = () => out({
    state: 'unavailable', detail: unavailableReason ?? 'No data is available from this source right now.', completeness: 'partial',
  });

  const snap = snapshot && hasAsOf(snapshot) ? snapshot : null;

  const fromSnapshot = (/** @type {string} */ detail) => {
    const s = /** @type {NonNullable<typeof snap>} */ (snap);
    const carried = s.carriedForward ? ' The scheduled run could not refresh it; this is an earlier copy.' : '';
    return out({ state: stateFromAge(s.asOf, now, policy), asOf: s.asOf, asOfBasis: s.asOfBasis ?? 'retrieved', origin: 'snapshot', detail: detail + carried });
  };
  const fromDevice = () => out({ state: 'cached', asOf: /** @type {string} */ (device?.asOf), asOfBasis: device?.asOfBasis ?? 'retrieved', origin: 'device', detail: 'Saved on this device' });

  if (direct && direct !== 'pending' && direct.ok) {
    const asOf = hasAsOf(direct) ? direct.asOf : nowIso;
    const basis = hasAsOf(direct) ? (direct.asOfBasis ?? 'retrieved') : 'retrieved';
    if (direct.completeness === 'partial') {
      return out({ state: 'degraded', asOf, asOfBasis: basis, completeness: 'partial', detail: direct.detail ?? 'Partial: some data could not be loaded' });
    }
    const state = stateFromAge(asOf, now, policy);
    if (state === 'live') return out({ state, asOf, asOfBasis: basis, ...(direct.detail ? { detail: direct.detail } : {}) });
    return out({ state, asOf, asOfBasis: basis, detail: direct.detail ?? `Upstream has not updated since ${formatTime(asOf)}` });
  }

  if (direct && direct !== 'pending' && !direct.ok) {
    if (snap) return fromSnapshot(`Direct request failed (${direct.error.message}); showing the scheduled copy`);
    if (device && hasAsOf(device)) return fromDevice();
    return unavailable();
  }

  // Direct fetch pending, or this source has no direct fetch.
  if (snap) return fromSnapshot(`Scheduled copy from ${formatTime(snap.asOf)}${direct === 'pending' ? '; checking for updates' : ''}`);
  if (device && hasAsOf(device)) return fromDevice();
  return unavailable();
}
