/**
 * @ewm/core-status — the honest-status machine.
 *
 * Platform invariant #5: every data layer surfaces exactly one of five states,
 * always accompanied by an "as of" timestamp when any data is being shown.
 * No layer ever silently pretends to be current.
 *
 * Framework-agnostic: vanilla TypeScript, zero dependencies.
 */

/**
 * The five states a data layer can be in.
 *
 * - `live` — fetched within the source's expected cadence; current.
 * - `cached` — served from a local cache (e.g. offline-first storage). The data
 *   itself may still be recent; `asOf` tells the truth.
 * - `stale` — older than the source's expected update cadence, but still shown.
 * - `degraded` — the source is reachable but returning partial or fallback data,
 *   or a refresh failed while older data remains on screen.
 * - `unavailable` — nothing can be shown for this layer.
 */
export type StatusState = 'live' | 'cached' | 'stale' | 'degraded' | 'unavailable';

export const STATUS_STATES: readonly StatusState[] = [
  'live',
  'cached',
  'stale',
  'degraded',
  'unavailable',
] as const;

/**
 * A point-in-time report for one layer.
 *
 * `asOf` is the ISO 8601 instant the *underlying data* was produced (not when we
 * fetched it). It is required for every state except `unavailable`, because if
 * anything is on screen the user is owed its age.
 */
export interface StatusSnapshot {
  readonly state: StatusState;
  readonly asOf: string | null;
  /** Optional human-readable context, e.g. "refresh failed: HTTP 503". */
  readonly detail?: string;
}

export type StatusListener = (id: string, snapshot: StatusSnapshot) => void;

/**
 * Registry of layer statuses for one running platform instance.
 * Modules register a status id per surface/layer/telemetry feed, report into it,
 * and UI (status pills, briefings) subscribes.
 */
export interface StatusRegistry {
  /** Register a status id. Idempotent registration is an error — ids are owned by one layer. */
  register(id: string, initial?: StatusSnapshot): void;
  /** Report a new snapshot. Throws on unknown ids and on snapshots that violate the honesty rules. */
  report(id: string, snapshot: StatusSnapshot): void;
  get(id: string): StatusSnapshot;
  has(id: string): boolean;
  ids(): string[];
  /** Subscribe to all snapshot changes. Returns an unsubscribe function. */
  subscribe(listener: StatusListener): () => void;
}

const DEFAULT_INITIAL: StatusSnapshot = {
  state: 'unavailable',
  asOf: null,
  detail: 'not yet loaded',
};

/**
 * Validate a snapshot against the honesty rules.
 * Returns a list of problems; empty means valid.
 */
export function validateSnapshot(snapshot: StatusSnapshot): string[] {
  const problems: string[] = [];
  if (!STATUS_STATES.includes(snapshot.state)) {
    problems.push(`unknown state "${String(snapshot.state)}"`);
  }
  if (snapshot.state !== 'unavailable' && snapshot.asOf === null) {
    problems.push(
      `state "${snapshot.state}" requires an "asOf" timestamp — showing data without its age is dishonest`,
    );
  }
  if (snapshot.asOf !== null && Number.isNaN(Date.parse(snapshot.asOf))) {
    problems.push(`"asOf" is not a parseable ISO 8601 timestamp: "${snapshot.asOf}"`);
  }
  return problems;
}

export function createStatusRegistry(): StatusRegistry {
  const snapshots = new Map<string, StatusSnapshot>();
  const listeners = new Set<StatusListener>();

  const set = (id: string, snapshot: StatusSnapshot): void => {
    const problems = validateSnapshot(snapshot);
    if (problems.length > 0) {
      throw new Error(`invalid status snapshot for "${id}": ${problems.join('; ')}`);
    }
    snapshots.set(id, snapshot);
    for (const listener of listeners) {
      listener(id, snapshot);
    }
  };

  return {
    register(id, initial = DEFAULT_INITIAL) {
      if (snapshots.has(id)) {
        throw new Error(`status id "${id}" is already registered`);
      }
      set(id, initial);
    },
    report(id, snapshot) {
      if (!snapshots.has(id)) {
        throw new Error(`status id "${id}" is not registered`);
      }
      set(id, snapshot);
    },
    get(id) {
      const snapshot = snapshots.get(id);
      if (snapshot === undefined) {
        throw new Error(`status id "${id}" is not registered`);
      }
      return snapshot;
    },
    has: (id) => snapshots.has(id),
    ids: () => [...snapshots.keys()],
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

/**
 * Freshness policy for age-derived states. Modules declare how old data may be
 * before it stops being "live"; the platform derives the honest label.
 */
export interface FreshnessPolicy {
  /** Data younger than this is `live`. */
  freshForMs: number;
  /** Data older than `freshForMs` but younger than this is `stale`; beyond it, `degraded`. */
  usableForMs: number;
}

/**
 * Derive the honest state from a data timestamp and a freshness policy.
 * Only ever returns `live`, `stale`, or `degraded` — cache provenance
 * (`cached`) and total absence (`unavailable`) are facts the caller knows,
 * not facts derivable from age.
 */
export function stateFromAge(
  asOf: string,
  now: Date,
  policy: FreshnessPolicy,
): Extract<StatusState, 'live' | 'stale' | 'degraded'> {
  const produced = Date.parse(asOf);
  if (Number.isNaN(produced)) {
    throw new Error(`"asOf" is not a parseable ISO 8601 timestamp: "${asOf}"`);
  }
  if (policy.freshForMs < 0 || policy.usableForMs < policy.freshForMs) {
    throw new Error('invalid freshness policy: require 0 <= freshForMs <= usableForMs');
  }
  const age = now.getTime() - produced;
  if (age <= policy.freshForMs) return 'live';
  if (age <= policy.usableForMs) return 'stale';
  return 'degraded';
}
