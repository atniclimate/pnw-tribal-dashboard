import type { IngestParser, ParseContext, ParseFailure, ParseOutcome } from '@ewm/ingest-core';

import { normalizeEcccAlert } from './normalizer.js';
import type { EcccAlertInput, EcccLanguageInput } from './types.js';
import {
  isRecord,
  optionalString,
  requirePolygonGeometry,
  requireRecord,
  requireString,
  requireTimestamp,
} from './validation.js';

const UTF8 = new TextDecoder('utf-8', { fatal: true });

function failure(code: string, message: string, itemIndex?: number, originalId?: string): ParseFailure {
  const result: {
    code: string;
    message: string;
    itemIndex?: number;
    originalId?: string;
  } = { code, message };
  if (itemIndex !== undefined) result.itemIndex = itemIndex;
  if (originalId !== undefined) result.originalId = originalId;
  return result;
}

function language(
  properties: Record<string, unknown>,
  suffix: 'en' | 'fr',
  languageTag: 'en-CA' | 'fr-CA',
): EcccLanguageInput | undefined {
  const headline = optionalString(properties[`alert_name_${suffix}`]);
  const description = optionalString(properties[`alert_text_${suffix}`]);
  if (headline === undefined && description === undefined) return undefined;
  if (headline === undefined || description === undefined) {
    throw new Error(`${languageTag} requires both alert_name_${suffix} and alert_text_${suffix}`);
  }
  return { language: languageTag, headline, description };
}

function alertTypeToMessageType(alertType: string): EcccAlertInput['messageType'] {
  return alertType.trim().toLowerCase() === 'cancel' ? 'cancel' : 'alert';
}

function featureToInput(value: unknown, itemIndex: number): EcccAlertInput {
  const feature = requireRecord(value, `feature ${itemIndex}`);
  if (feature.type !== 'Feature') throw new Error(`feature ${itemIndex}.type must be "Feature"`);
  const properties = requireRecord(feature.properties, `feature ${itemIndex}.properties`);
  const originalId = requireString(
    optionalString(properties.id) ?? feature.id,
    `feature ${itemIndex}.id`,
  );
  const sent = requireTimestamp(
    properties.publication_datetime,
    `feature ${itemIndex}.properties.publication_datetime`,
  );
  const effective =
    optionalString(properties.validity_datetime) ??
    optionalString(properties.publication_datetime) ??
    sent;
  requireTimestamp(effective, `feature ${itemIndex}.properties.validity_datetime`);
  const expiresValue = optionalString(properties.expiration_datetime);
  if (expiresValue !== undefined) {
    requireTimestamp(expiresValue, `feature ${itemIndex}.properties.expiration_datetime`);
  }

  const en = language(properties, 'en', 'en-CA');
  const fr = language(properties, 'fr', 'fr-CA');
  const languages = [en, fr].filter((block): block is EcccLanguageInput => block !== undefined);
  if (languages.length === 0) throw new Error(`feature ${itemIndex} has no source language block`);

  const alertType = requireString(properties.alert_type, `feature ${itemIndex}.properties.alert_type`);
  const event =
    optionalString(properties.alert_short_name_en) ??
    optionalString(properties.alert_name_en) ??
    optionalString(properties.alert_short_name_fr) ??
    requireString(properties.alert_name_fr, `feature ${itemIndex}.properties.alert_name_fr`);
  const designation =
    optionalString(properties.alert_name_en) ??
    requireString(properties.alert_name_fr, `feature ${itemIndex}.properties.alert_name_fr`);
  const province = requireString(properties.province, `feature ${itemIndex}.properties.province`);
  const status =
    optionalString(properties.status_en)?.toLowerCase() ??
    optionalString(properties.status_fr)?.toLowerCase() ??
    '';

  const onset = optionalString(properties.validity_datetime);
  const areaDesc = optionalString(properties.feature_name_en) ?? optionalString(properties.feature_name_fr);
  const severity = optionalString(properties.severity);
  const urgency = optionalString(properties.urgency);
  const impact = optionalString(properties.impact_en) ?? optionalString(properties.impact_fr);
  const colour = optionalString(properties.risk_colour_en) ?? optionalString(properties.risk_colour_fr);
  const confidence = optionalString(properties.confidence_en) ?? optionalString(properties.confidence_fr);

  return {
    originalId,
    references: [],
    sent,
    messageType: alertTypeToMessageType(alertType),
    event,
    originalDesignation: designation,
    alertType,
    ended: status === 'ended' || status === 'terminée' || status === 'terminé',
    effective,
    expires: expiresValue ?? null,
    geometry: requirePolygonGeometry(feature.geometry, `feature ${itemIndex}.geometry`),
    geometryBasis: 'polygon',
    geocodes: Object.freeze([`province:${province}`]),
    languages: Object.freeze(languages),
    ...(onset === undefined ? {} : { onset }),
    ...(areaDesc === undefined ? {} : { areaDesc }),
    ...(severity === undefined ? {} : { severity }),
    ...(urgency === undefined ? {} : { urgency }),
    ...(impact === undefined ? {} : { mscImpact: impact }),
    ...(colour === undefined ? {} : { colour }),
    ...(confidence === undefined ? {} : { certainty: confidence }),
  };
}

function decodeJson(bytes: Uint8Array): unknown {
  const text = UTF8.decode(bytes);
  return JSON.parse(text) as unknown;
}

/** Pure production-wire parser for the GeoMet weather-alerts FeatureCollection. */
export const parseEcccGeoMet: IngestParser<Uint8Array> = (
  payload: Uint8Array,
  context: ParseContext,
): ParseOutcome => {
  let decoded: unknown;
  try {
    decoded = decodeJson(payload);
  } catch (error) {
    return {
      messages: [],
      observedAt: context.fetchedAt,
      diagnostics: [],
      failures: [failure('eccc-geomet-invalid-json', String(error))],
      completeness: 'rejected',
    };
  }

  if (!isRecord(decoded) || decoded.type !== 'FeatureCollection' || !Array.isArray(decoded.features)) {
    return {
      messages: [],
      observedAt: context.fetchedAt,
      diagnostics: [],
      failures: [
        failure(
          'eccc-geomet-invalid-collection',
          'GeoMet payload must be a FeatureCollection with a features array',
        ),
      ],
      completeness: 'rejected',
    };
  }

  const messages: ParseOutcome['messages'][number][] = [];
  const failures: ParseFailure[] = [];
  decoded.features.forEach((feature, itemIndex) => {
    const originalId =
      isRecord(feature) && isRecord(feature.properties)
        ? optionalString(feature.properties.id) ?? optionalString(feature.id)
        : undefined;
    try {
      messages.push(normalizeEcccAlert(featureToInput(feature, itemIndex), context));
    } catch (error) {
      failures.push(
        failure('eccc-geomet-invalid-feature', String(error), itemIndex, originalId),
      );
    }
  });

  // The OGC endpoint pages at a server cap (500 observed live). A partial
  // page that conceals active alerts must reject the batch, never publish
  // as complete; last-good data is retained downstream.
  const matched = decoded.numberMatched;
  if (
    typeof matched === 'number' &&
    Number.isFinite(matched) &&
    matched > decoded.features.length
  ) {
    failures.push(
      failure(
        'eccc-truncated-collection',
        `GeoMet page returned ${String(decoded.features.length)} of ${String(matched)} matched alerts; a partial page could conceal active alerts`,
      ),
    );
  }

  const outcome: {
    messages: typeof messages;
    observedAt: string;
    sourceUpdatedAt?: string;
    diagnostics: ParseOutcome['diagnostics'];
    failures: typeof failures;
    completeness: ParseOutcome['completeness'];
  } = {
    messages,
    observedAt: context.fetchedAt,
    diagnostics: [],
    failures,
    completeness: failures.length === 0 ? 'complete' : 'rejected',
  };
  const sourceUpdatedAt = optionalString(decoded.timeStamp);
  if (sourceUpdatedAt !== undefined && !Number.isNaN(Date.parse(sourceUpdatedAt))) {
    outcome.sourceUpdatedAt = sourceUpdatedAt;
  }
  return outcome;
};
