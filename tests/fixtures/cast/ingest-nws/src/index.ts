import { mapNwsAlert, type AlertMessageType, type NormalizedAlert } from '@ewm/alerts-schema';
import {
  stampAlertProvenance,
  type IngestDiagnostic,
  type ParseContext,
  type ParseFailure,
  type ParseOutcome,
  type UnstampedAlertMessage,
} from '@ewm/ingest-core';

export type NwsAlertParameters = Readonly<Record<string, readonly string[]>>;

/** Normalized NWS alerts retain the source parameter arrays, including VTEC tokens. */
export interface NwsNormalizedAlert extends NormalizedAlert {
  readonly parameters?: NwsAlertParameters;
}

export interface NwsParseOutcome extends Omit<ParseOutcome, 'messages'> {
  readonly messages: readonly NwsNormalizedAlert[];
}

type PolygonGeometry = Extract<
  NonNullable<NormalizedAlert['geometry']>,
  { type: 'Polygon' | 'MultiPolygon' }
>;

class NwsDecodeError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'NwsDecodeError';
    this.code = code;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new NwsDecodeError('malformed-nws-feature', `${label} must be an object`);
  }
  return value;
}

function requireText(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new NwsDecodeError('missing-nws-field', `${label} must be a non-empty string`);
  }
  return value;
}

function optionalText(value: unknown, label: string): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') {
    throw new NwsDecodeError('invalid-nws-field', `${label} must be a string when present`);
  }
  return value.trim() === '' ? undefined : value;
}

function requireTimestamp(value: unknown, label: string): string {
  const timestamp = requireText(value, label);
  if (Number.isNaN(Date.parse(timestamp))) {
    throw new NwsDecodeError('invalid-nws-timestamp', `${label} is not parseable: "${timestamp}"`);
  }
  return timestamp;
}

function optionalTimestamp(value: unknown, label: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  return requireTimestamp(value, label);
}

function nullableTimestamp(value: unknown, label: string): string | null {
  if (value === null) return null;
  if (value === undefined) {
    throw new NwsDecodeError('missing-nws-field', `${label} must be present`);
  }
  return requireTimestamp(value, label);
}

function optionalMappingValue(value: unknown, label: string): string | null | undefined {
  if (value === undefined || value === null) return value;
  if (typeof value !== 'string') {
    throw new NwsDecodeError('invalid-nws-field', `${label} must be a string when present`);
  }
  return value;
}

function decodeMessageType(value: unknown): AlertMessageType {
  const sourceValue = requireText(value, 'properties.messageType').toLowerCase();
  if (sourceValue === 'alert' || sourceValue === 'update' || sourceValue === 'cancel') {
    return sourceValue;
  }
  throw new NwsDecodeError(
    'unsupported-nws-message-type',
    `properties.messageType is not Alert, Update, or Cancel: "${String(value)}"`,
  );
}

function decodeStringArray(value: unknown, label: string): readonly string[] {
  if (!Array.isArray(value)) {
    throw new NwsDecodeError('invalid-nws-field', `${label} must be an array`);
  }
  const values = value.map((item, index) => requireText(item, `${label}[${index}]`));
  return Object.freeze(values);
}

function decodeGeocodes(value: unknown): readonly string[] {
  if (value === undefined || value === null) return Object.freeze([]);
  const geocode = requireRecord(value, 'properties.geocode');
  const ugc = geocode.UGC === undefined ? [] : decodeStringArray(geocode.UGC, 'geocode.UGC');
  const same = geocode.SAME === undefined ? [] : decodeStringArray(geocode.SAME, 'geocode.SAME');
  return Object.freeze([...new Set([...ugc, ...same])]);
}

function decodeReferences(value: unknown): readonly string[] {
  if (value === undefined || value === null) return Object.freeze([]);
  if (!Array.isArray(value)) {
    throw new NwsDecodeError('invalid-nws-references', 'properties.references must be an array');
  }
  const references = value.map((reference, index) => {
    if (typeof reference === 'string') {
      return requireText(reference, `properties.references[${index}]`);
    }
    const record = requireRecord(reference, `properties.references[${index}]`);
    return requireText(record.identifier, `properties.references[${index}].identifier`);
  });
  return Object.freeze(references);
}

function decodeParameters(value: unknown): NwsAlertParameters | undefined {
  if (value === undefined || value === null) return undefined;
  const source = requireRecord(value, 'properties.parameters');
  const parameters: Record<string, readonly string[]> = {};
  for (const [name, items] of Object.entries(source)) {
    parameters[name] = decodeStringArray(items, `properties.parameters.${name}`);
  }
  return Object.freeze(parameters);
}

function clonePosition(value: unknown, label: string): number[] {
  if (!Array.isArray(value)) {
    throw new NwsDecodeError('invalid-nws-geometry', `${label} must be a finite GeoJSON position`);
  }
  const coordinates: unknown[] = value;
  if (
    coordinates.length < 2 ||
    coordinates.some((coordinate) => typeof coordinate !== 'number' || !Number.isFinite(coordinate))
  ) {
    throw new NwsDecodeError('invalid-nws-geometry', `${label} must be a finite GeoJSON position`);
  }
  return coordinates.map((coordinate) => {
    if (typeof coordinate !== 'number') {
      throw new NwsDecodeError('invalid-nws-geometry', `${label} contains a non-number`);
    }
    return coordinate;
  });
}

function cloneLinearRing(value: unknown, label: string): number[][] {
  if (!Array.isArray(value) || value.length < 4) {
    throw new NwsDecodeError(
      'invalid-nws-geometry',
      `${label} must contain at least four positions`,
    );
  }
  return value.map((position, index) => clonePosition(position, `${label}[${index}]`));
}

function clonePolygonCoordinates(value: unknown, label: string): number[][][] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new NwsDecodeError('invalid-nws-geometry', `${label} must contain a linear ring`);
  }
  return value.map((ring, index) => cloneLinearRing(ring, `${label}[${index}]`));
}

function decodePolygonGeometry(value: unknown): PolygonGeometry | null {
  if (value === undefined || value === null) return null;
  const geometry = requireRecord(value, 'feature.geometry');
  if (geometry.type === 'Polygon') {
    return {
      type: 'Polygon',
      coordinates: clonePolygonCoordinates(geometry.coordinates, 'geometry.coordinates'),
    };
  }
  if (geometry.type === 'MultiPolygon') {
    if (!Array.isArray(geometry.coordinates) || geometry.coordinates.length === 0) {
      throw new NwsDecodeError(
        'invalid-nws-geometry',
        'geometry.coordinates must contain a polygon',
      );
    }
    return {
      type: 'MultiPolygon',
      coordinates: geometry.coordinates.map((polygon, index) =>
        clonePolygonCoordinates(polygon, `geometry.coordinates[${index}]`),
      ),
    };
  }
  throw new NwsDecodeError(
    'unsupported-nws-geometry',
    `NWS alert geometry must be Polygon or MultiPolygon, received "${String(geometry.type)}"`,
  );
}

/**
 * api.weather.gov keeps synthetic monitoring entries (CAP status "Test",
 * null headline) inside alerts/active. Test and exercise messages are
 * intentional exclusions with countable diagnostics, never hard failures,
 * so one synthetic item cannot reject an otherwise valid batch.
 */
const EXCLUDED_CAP_STATUSES: ReadonlySet<string> = new Set(['test', 'exercise']);

function excludedCapStatus(value: unknown): string | undefined {
  if (!isRecord(value) || !isRecord(value.properties)) return undefined;
  const status = value.properties.status;
  if (typeof status !== 'string') return undefined;
  return EXCLUDED_CAP_STATUSES.has(status.trim().toLowerCase()) ? status : undefined;
}

function extractOriginalId(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  if (isRecord(value.properties) && typeof value.properties.id === 'string') {
    return value.properties.id;
  }
  return typeof value.id === 'string' ? value.id : undefined;
}

function decodeFeature(value: unknown, context: ParseContext): NwsNormalizedAlert {
  const feature = requireRecord(value, 'feature');
  if (feature.type !== 'Feature') {
    throw new NwsDecodeError('malformed-nws-feature', 'NWS alert item must have type "Feature"');
  }
  const properties = requireRecord(feature.properties, 'feature.properties');
  const originalId = requireText(properties.id, 'properties.id');
  const sent = requireTimestamp(properties.sent, 'properties.sent');
  const effective = requireTimestamp(properties.effective, 'properties.effective');
  const onset = optionalTimestamp(properties.onset, 'properties.onset');
  const expires = nullableTimestamp(properties.expires, 'properties.expires');
  const event = requireText(properties.event, 'properties.event');
  const messageType = decodeMessageType(properties.messageType);
  const headline = requireText(properties.headline, 'properties.headline');
  const description = requireText(properties.description, 'properties.description');
  const instruction = optionalText(properties.instruction, 'properties.instruction');
  const areaDesc = optionalText(properties.areaDesc, 'properties.areaDesc');
  const geometry = decodePolygonGeometry(feature.geometry);
  const geocodes = decodeGeocodes(properties.geocode);
  if (geometry === null && geocodes.length === 0) {
    throw new NwsDecodeError(
      'missing-nws-coverage',
      'NWS alert has neither polygon geometry nor UGC/SAME geocodes',
    );
  }
  const references = decodeReferences(properties.references);
  const parameters = decodeParameters(properties.parameters);
  const severity = optionalMappingValue(properties.severity, 'properties.severity');
  const urgency = optionalMappingValue(properties.urgency, 'properties.urgency');
  const certainty = optionalMappingValue(properties.certainty, 'properties.certainty');
  const mapped = mapNwsAlert({
    ...(severity === undefined ? {} : { severity }),
    ...(urgency === undefined ? {} : { urgency }),
    ...(certainty === undefined ? {} : { certainty }),
    event,
    ended: messageType === 'cancel',
  });
  const languageBlock = Object.freeze({
    headline,
    description,
    ...(instruction === undefined ? {} : { instruction }),
  });
  const message: UnstampedAlertMessage & { readonly parameters?: NwsAlertParameters } = {
    sent,
    messageType,
    event,
    originalDesignation: event,
    ...mapped,
    effective,
    ...(onset === undefined ? {} : { onset }),
    expires,
    geometry,
    ...(areaDesc === undefined ? {} : { areaDesc }),
    sourceLanguage: Object.freeze({ 'en-US': languageBlock }),
    translationAuthority: 'National Weather Service',
    ...(parameters === undefined ? {} : { parameters }),
  };

  return stampAlertProvenance(message, context, {
    agency: 'nws',
    originalId,
    references,
    coverage: {
      geometryBasis: geometry === null ? 'zone' : 'polygon',
      geocodes,
    },
  });
}

function decodeCollection(payload: unknown): {
  readonly features: readonly unknown[];
  readonly sourceUpdatedAt?: string;
  readonly truncated: boolean;
} {
  const collection = requireRecord(payload, 'payload');
  if (collection.type !== 'FeatureCollection') {
    throw new NwsDecodeError(
      'invalid-nws-collection',
      'NWS alerts/active payload must have type "FeatureCollection"',
    );
  }
  if (!Array.isArray(collection.features)) {
    throw new NwsDecodeError(
      'invalid-nws-collection',
      'NWS alerts/active payload must contain a features array',
    );
  }
  // api.weather.gov pages at a 500-item cap and includes pagination.next
  // only when further pages exist. A single page of a longer collection
  // could conceal active alerts; transports must deliver the full
  // collection (following pagination) or the batch rejects to last-good.
  const truncated =
    isRecord(collection.pagination) &&
    typeof collection.pagination.next === 'string' &&
    collection.pagination.next.trim() !== '';
  const sourceUpdatedAt = optionalTimestamp(collection.updated, 'collection.updated');
  return {
    features: collection.features,
    ...(sourceUpdatedAt === undefined ? {} : { sourceUpdatedAt }),
    truncated,
  };
}

function itemFailure(error: unknown, itemIndex: number, originalId?: string): ParseFailure {
  const code = error instanceof NwsDecodeError ? error.code : 'invalid-nws-feature';
  const message = error instanceof Error ? error.message : String(error);
  return Object.freeze({
    code,
    message,
    itemIndex,
    ...(originalId === undefined ? {} : { originalId }),
  });
}

/** Pure parser for decoded api.weather.gov alerts/active GeoJSON. */
export function parseNws(payload: unknown, context: ParseContext): NwsParseOutcome {
  let decoded: ReturnType<typeof decodeCollection>;
  try {
    decoded = decodeCollection(payload);
  } catch (error) {
    const failure = itemFailure(error, 0);
    return Object.freeze({
      messages: Object.freeze([]),
      observedAt: context.fetchedAt,
      diagnostics: Object.freeze([]),
      failures: Object.freeze([{ code: failure.code, message: failure.message }]),
      completeness: 'rejected',
    });
  }

  const messages: NwsNormalizedAlert[] = [];
  const failures: ParseFailure[] = [];
  const diagnostics: IngestDiagnostic[] = [];
  decoded.features.forEach((feature, itemIndex) => {
    const excludedStatus = excludedCapStatus(feature);
    if (excludedStatus !== undefined) {
      const originalId = extractOriginalId(feature);
      diagnostics.push(
        Object.freeze({
          code: 'nws-status-excluded',
          message: `CAP status "${excludedStatus}" message excluded from the active alert set`,
          severity: 'info',
          itemIndex,
          ...(originalId === undefined ? {} : { originalId }),
        }),
      );
      return;
    }
    try {
      messages.push(decodeFeature(feature, context));
    } catch (error) {
      failures.push(itemFailure(error, itemIndex, extractOriginalId(feature)));
    }
  });

  if (decoded.truncated) {
    failures.push(
      Object.freeze({
        code: 'nws-truncated-collection',
        message:
          'NWS collection carries pagination.next; a partial page could conceal active alerts',
      }),
    );
  }

  return Object.freeze({
    messages: Object.freeze(messages),
    observedAt: context.fetchedAt,
    ...(decoded.sourceUpdatedAt === undefined ? {} : { sourceUpdatedAt: decoded.sourceUpdatedAt }),
    diagnostics: Object.freeze(diagnostics),
    failures: Object.freeze(failures),
    completeness: failures.length === 0 ? 'complete' : 'rejected',
  });
}
