import type { Geometry } from 'geojson';

/** Four ordered CAP impact bands plus an explicitly unranked fallback. */
export type SeverityBand = 'extreme' | 'severe' | 'moderate' | 'minor' | 'unstated';

/** Protective-action axis, intentionally separate from impact severity. */
export type ActionPosture = 'act-now' | 'prepare' | 'monitor' | 'ended';

/** Confidence derived only from CAP certainty. */
export type AlertConfidence = 'observed' | 'likely' | 'possible' | 'unknown';

export type AlertLifecycleState = 'active' | 'superseded' | 'cancelled' | 'expired';
export type AlertMessageType = 'alert' | 'update' | 'cancel';
export type GeometryBasis = 'polygon' | 'zone' | 'point' | 'none';

export interface AlertLanguageBlock {
  headline: string;
  description: string;
  instruction?: string;
}

export interface MappingApplied {
  name: string;
  version: string;
}

export interface AlertCoverage {
  /** Zone means the source named an administrative forecast zone, not a precise footprint. */
  geometryBasis: GeometryBasis;
  geocodes: readonly string[];
}

export interface AlertProvenance {
  agency: string;
  originalId: string;
  fetchedAt: string;
  mappingApplied: MappingApplied;
  coverage: AlertCoverage;
}

/**
 * Ratified ATNI-CAST alert message. `alertId` is agency-namespaced and never reused.
 * A lifecycle resolver assigns the stable `eventId` shared by its update/cancel chain.
 */
export interface NormalizedAlert {
  alertId: string;
  eventId: string;
  sourceId: string;
  sent: string;
  messageType: AlertMessageType;
  references: readonly string[];
  lifecycleState: AlertLifecycleState;
  event: string;
  originalDesignation: string;
  band: SeverityBand;
  posture: ActionPosture;
  confidence: AlertConfidence;
  effective: string;
  onset?: string;
  expires: string | null;
  geometry: Geometry | null;
  areaDesc?: string;
  /** BCP-47 keys. Source-authored blocks only; callers must never synthesize translations. */
  sourceLanguage: Readonly<Record<string, AlertLanguageBlock>>;
  /** Agency or other authority responsible for the supplied language blocks. */
  translationAuthority: string;
  provenance: AlertProvenance;
}

export interface AlertTombstone {
  alertId: string;
  eventId: string;
  sent: string;
  state: 'superseded' | 'cancelled';
  replacedByAlertId?: string;
}

export interface AlertEventIdentity {
  eventId: string;
  lifecycleState: AlertLifecycleState;
  current: NormalizedAlert | null;
  tombstones: readonly AlertTombstone[];
  memberAlertIds: readonly string[];
}

export interface AlertLifecycleRejection {
  alertId: string;
  eventId: string;
  reason: 'older-sent' | 'duplicate-id';
}

export interface AlertLifecycleResolution {
  events: readonly AlertEventIdentity[];
  rejected: readonly AlertLifecycleRejection[];
}

export interface AlertEventGroup {
  id: string;
  watershed?: string;
  memberAlertIds: readonly string[];
  highest: {
    band: SeverityBand;
    memberCount: number;
  };
}

const BAND_RANK: Readonly<Record<Exclude<SeverityBand, 'unstated'>, number>> = {
  minor: 0,
  moderate: 1,
  severe: 2,
  extreme: 3,
};

/** Builds the never-reused provenance namespace used by messages and CAP references. */
export function createAlertId(agency: string, originalId: string): string {
  if (agency.trim() === '') throw new Error('Alert agency must not be empty');
  if (originalId.trim() === '') throw new Error('Alert originalId must not be empty');
  return `${agency}:${originalId}`;
}

/** Returns null whenever either operand is unranked. */
export function compareSeverityBands(left: SeverityBand, right: SeverityBand): number | null {
  if (left === 'unstated' || right === 'unstated') return null;
  return BAND_RANK[left] - BAND_RANK[right];
}

/** Finds the highest ranked member; returns unranked only when every member is unranked. */
export function highestSeverityBand(bands: readonly SeverityBand[]): SeverityBand {
  let highest: Exclude<SeverityBand, 'unstated'> | undefined;
  for (const band of bands) {
    if (band === 'unstated') continue;
    if (highest === undefined || BAND_RANK[band] > BAND_RANK[highest]) highest = band;
  }
  return highest ?? 'unstated';
}

/** Creates grouping metadata only. It never synthesizes or merges an alert. */
export function createAlertEventGroup(
  id: string,
  members: readonly Pick<NormalizedAlert, 'alertId' | 'band'>[],
  watershed?: string,
): AlertEventGroup {
  if (id.trim() === '') throw new Error('Alert event group id must not be empty');
  if (members.length === 0) throw new Error('Alert event group must contain at least one alert');

  const group: AlertEventGroup = {
    id,
    memberAlertIds: Object.freeze(members.map(({ alertId }) => alertId)),
    highest: Object.freeze({
      band: highestSeverityBand(members.map(({ band }) => band)),
      memberCount: members.length,
    }),
  };
  if (watershed !== undefined) group.watershed = watershed;
  return Object.freeze(group);
}
