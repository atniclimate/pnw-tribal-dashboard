import type { ActionPosture, AlertConfidence, SeverityBand } from './model.js';

export const NWS_MAPPING_TABLE = Object.freeze({
  name: 'atni-cast-nws-cap',
  version: '1.0.0',
  severity: Object.freeze({
    extreme: 'extreme',
    severe: 'severe',
    moderate: 'moderate',
    minor: 'minor',
    unknown: 'unstated',
  } satisfies Record<string, SeverityBand>),
  urgency: Object.freeze({
    immediate: 'act-now',
    expected: 'prepare',
    future: 'prepare',
    past: 'ended',
    unknown: 'monitor',
  } satisfies Record<string, ActionPosture>),
  certainty: Object.freeze({
    observed: 'observed',
    likely: 'likely',
    possible: 'possible',
    unlikely: 'unknown',
    unknown: 'unknown',
  } satisfies Record<string, AlertConfidence>),
  eventPosture: Object.freeze([
    Object.freeze({ suffix: 'emergency', posture: 'act-now' as const }),
    Object.freeze({ suffix: 'warning', posture: 'act-now' as const }),
    Object.freeze({ suffix: 'watch', posture: 'prepare' as const }),
    Object.freeze({ suffix: 'advisory', posture: 'monitor' as const }),
    Object.freeze({ suffix: 'statement', posture: 'monitor' as const }),
  ]),
});

export const ECCC_MAPPING_TABLE = Object.freeze({
  name: 'atni-cast-eccc-cap',
  version: '1.0.0',
  precedence: Object.freeze(['MSC_Impact', 'Colour', 'CAP severity'] as const),
  mscImpact: Object.freeze({
    extreme: 'extreme',
    high: 'severe',
    severe: 'severe',
    medium: 'moderate',
    moderate: 'moderate',
    'modéré': 'moderate',
    low: 'minor',
    minor: 'minor',
  } satisfies Record<string, SeverityBand>),
  colour: Object.freeze({
    red: 'extreme',
    orange: 'severe',
    yellow: 'moderate',
    jaune: 'moderate',
    green: 'minor',
  } satisfies Record<string, SeverityBand>),
  capSeverity: NWS_MAPPING_TABLE.severity,
  urgency: NWS_MAPPING_TABLE.urgency,
  certainty: NWS_MAPPING_TABLE.certainty,
});

export interface NwsMappingInput {
  severity?: string | null;
  urgency?: string | null;
  certainty?: string | null;
  event?: string | null;
  ended?: boolean;
}

export interface MappedAlertDimensions {
  band: SeverityBand;
  posture: ActionPosture;
  confidence: AlertConfidence;
}

function key(value: string | null | undefined): string {
  return value?.trim().toLowerCase() ?? '';
}

function lookup<T>(table: Readonly<Record<string, T>>, value: string | null | undefined, fallback: T): T {
  return table[key(value)] ?? fallback;
}

/** Applies the audited NWS CAP mapping without deriving impact from the event title. */
export function mapNwsAlert(input: NwsMappingInput): MappedAlertDimensions {
  let posture: ActionPosture = lookup(NWS_MAPPING_TABLE.urgency, input.urgency, 'monitor');
  if (input.ended === true) {
    posture = 'ended';
  } else {
    const event = key(input.event);
    const eventRule = NWS_MAPPING_TABLE.eventPosture.find(({ suffix }) => event.endsWith(suffix));
    if (eventRule !== undefined) posture = eventRule.posture;
  }
  return {
    band: lookup(NWS_MAPPING_TABLE.severity, input.severity, 'unstated'),
    posture,
    confidence: lookup(NWS_MAPPING_TABLE.certainty, input.certainty, 'unknown'),
  };
}

export interface EcccMappingInput extends NwsMappingInput {
  mscImpact?: string | null;
  colour?: string | null;
}

/** Uses MSC_Impact, then Colour, then base CAP severity. Event titles never affect band. */
export function mapEcccAlert(input: EcccMappingInput): MappedAlertDimensions {
  const impact = lookup(ECCC_MAPPING_TABLE.mscImpact, input.mscImpact, undefined);
  const colour = lookup(ECCC_MAPPING_TABLE.colour, input.colour, undefined);
  const base = lookup(ECCC_MAPPING_TABLE.capSeverity, input.severity, 'unstated');
  const common = mapNwsAlert(input);
  return { ...common, band: impact ?? colour ?? base };
}
