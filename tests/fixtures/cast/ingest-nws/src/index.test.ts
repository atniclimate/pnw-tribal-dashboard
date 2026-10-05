import { NWS_MAPPING_TABLE } from '@ewm/alerts-schema';
import {
  replayCorpus,
  validateAlertProvenance,
  type CorpusFixture,
  type ParseContext,
} from '@ewm/ingest-core';
import { describe, expect, it } from 'vitest';

import cancelRaw from '../fixtures/synthetic/cancel.json?raw';
import malformedRaw from '../fixtures/synthetic/malformed-feature.json?raw';
import missingCoverageRaw from '../fixtures/synthetic/missing-coverage.json?raw';
import testMessageRaw from '../fixtures/synthetic/test-message.json?raw';
import polygonRaw from '../fixtures/live/alert-flood-warning-polygon-LAC019.json?raw';
import zoneRaw from '../fixtures/live/alert-red-flag-warning-zone-ORZ691.json?raw';
import { parseNws } from './index.js';

const FIXTURE_ROOT = 'packages/ingest-nws/fixtures';
const FIXTURE_TEXT: Readonly<Record<string, string>> = Object.freeze({
  'live/alert-flood-warning-polygon-LAC019.json': polygonRaw,
  'live/alert-red-flag-warning-zone-ORZ691.json': zoneRaw,
  'synthetic/malformed-feature.json': malformedRaw,
  'synthetic/missing-coverage.json': missingCoverageRaw,
  'synthetic/cancel.json': cancelRaw,
  'synthetic/test-message.json': testMessageRaw,
});
const CONTEXT: ParseContext = {
  source: {
    id: 'nws-alerts-active',
    owner: 'NOAA National Weather Service',
    url: 'https://api.weather.gov/alerts/active',
    license: 'U.S. public domain unless otherwise noted.',
    cadence: 'Event-driven',
    region: 'us',
    verifiedAt: '2026-07-17',
  },
  fetchedAt: '2026-07-17T18:10:00Z',
  mapping: { name: NWS_MAPPING_TABLE.name, version: NWS_MAPPING_TABLE.version },
};

function decodeJson(bytes: Uint8Array): unknown {
  return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
}

function decodeIndividualAlert(bytes: Uint8Array): unknown {
  return { type: 'FeatureCollection', features: [decodeJson(bytes)] };
}

function loadFixture(relativePath: string): unknown {
  const text = FIXTURE_TEXT[relativePath];
  if (text === undefined) throw new Error(`Unknown test fixture: ${relativePath}`);
  return JSON.parse(text) as unknown;
}

function readFixture(path: string): Promise<Uint8Array> {
  const prefix = `${FIXTURE_ROOT}/`;
  const normalized = path.replaceAll('\\', '/');
  const relativePath = normalized.startsWith(prefix) ? normalized.slice(prefix.length) : normalized;
  const text = FIXTURE_TEXT[relativePath];
  if (text === undefined) throw new Error(`Unknown corpus path: ${path}`);
  return Promise.resolve(new TextEncoder().encode(text));
}

function firstFeature(payload: unknown): unknown {
  if (
    typeof payload !== 'object' ||
    payload === null ||
    !('features' in payload) ||
    !Array.isArray(payload.features) ||
    payload.features.length === 0
  ) {
    throw new Error('Test fixture is not a non-empty FeatureCollection');
  }
  return payload.features[0];
}

const REPLAY_FIXTURES: readonly CorpusFixture<unknown>[] = [
  {
    label: 'live NWS polygon update alert',
    relativePath: 'live/alert-flood-warning-polygon-LAC019.json',
    context: CONTEXT,
    decode: decodeIndividualAlert,
    expectedCompleteness: 'complete',
  },
  {
    label: 'live NWS zone-only alert',
    relativePath: 'live/alert-red-flag-warning-zone-ORZ691.json',
    context: CONTEXT,
    decode: decodeIndividualAlert,
    expectedCompleteness: 'complete',
  },
  {
    label: 'synthetic NWS malformed feature',
    relativePath: 'synthetic/malformed-feature.json',
    context: CONTEXT,
    decode: decodeJson,
    expectedCompleteness: 'rejected',
  },
  {
    label: 'synthetic NWS missing geometry and geocodes',
    relativePath: 'synthetic/missing-coverage.json',
    context: CONTEXT,
    decode: decodeJson,
    expectedCompleteness: 'rejected',
  },
  {
    label: 'synthetic NWS cancel message',
    relativePath: 'synthetic/cancel.json',
    context: CONTEXT,
    decode: decodeJson,
    expectedCompleteness: 'complete',
  },
  {
    label: 'synthetic NWS test/keepalive message',
    relativePath: 'synthetic/test-message.json',
    context: CONTEXT,
    decode: decodeJson,
    expectedCompleteness: 'complete',
  },
];

describe('parseNws', () => {
  it('replays the package corpus through ingest-core', async () => {
    const report = await replayCorpus(FIXTURE_ROOT, REPLAY_FIXTURES, parseNws, readFixture);

    expect(report).toMatchObject({
      fixtureCount: 6,
      completeCount: 4,
      rejectedCount: 2,
      messageCount: 3,
      failureCount: 2,
    });
    expect(report.fixtures[0]?.inputSha256).toBe(
      'b78dc6d079acdf3de08aa09a06e7ebc5680c4881400ad1ba95add2307e2c8d62',
    );
    expect(report.fixtures[1]?.inputSha256).toBe(
      'ac5771d1208ebd02f3345716a101100890724dd2526dd60b8b1607f6ec1ac2ba',
    );
  });

  it('distinguishes source polygon coverage from zone-only coverage', () => {
    const polygon = parseNws(
      { type: 'FeatureCollection', features: [loadFixture(REPLAY_FIXTURES[0]!.relativePath)] },
      CONTEXT,
    ).messages[0]!;
    const zone = parseNws(
      { type: 'FeatureCollection', features: [loadFixture(REPLAY_FIXTURES[1]!.relativePath)] },
      CONTEXT,
    ).messages[0]!;

    expect(polygon.geometry?.type).toBe('Polygon');
    expect(polygon.provenance.coverage.geometryBasis).toBe('polygon');
    expect(polygon.provenance.coverage.geocodes).toContain('LAC019');
    expect(zone.geometry).toBeNull();
    expect(zone.provenance.coverage.geometryBasis).toBe('zone');
    expect(zone.provenance.coverage.geocodes).toContain('ORZ691');
    expect(zone.provenance.coverage.geocodes).toContain('041021');
  });

  it('isolates a malformed item without losing valid siblings', () => {
    const valid = loadFixture('live/alert-red-flag-warning-zone-ORZ691.json');
    const malformed = firstFeature(loadFixture('synthetic/malformed-feature.json'));
    const outcome = parseNws({ type: 'FeatureCollection', features: [valid, malformed] }, CONTEXT);

    expect(outcome.completeness).toBe('rejected');
    expect(outcome.messages).toHaveLength(1);
    expect(outcome.messages[0]?.originalDesignation).toBe('Red Flag Warning');
    expect(outcome.failures).toEqual([
      expect.objectContaining({ itemIndex: 1, originalId: 'synthetic-malformed' }),
    ]);
  });

  it('excludes CAP test and exercise messages as countable diagnostics, never failures', () => {
    const testMessage = firstFeature(loadFixture('synthetic/test-message.json'));
    const valid = loadFixture('live/alert-red-flag-warning-zone-ORZ691.json');
    const outcome = parseNws(
      { type: 'FeatureCollection', features: [testMessage, valid] },
      CONTEXT,
    );

    expect(outcome.completeness).toBe('complete');
    expect(outcome.messages).toHaveLength(1);
    expect(outcome.messages[0]?.originalDesignation).toBe('Red Flag Warning');
    expect(outcome.failures).toEqual([]);
    expect(outcome.diagnostics).toEqual([
      expect.objectContaining({
        code: 'nws-status-excluded',
        severity: 'info',
        itemIndex: 0,
        originalId: 'synthetic-test-message',
      }),
    ]);

    const exercise = JSON.parse(JSON.stringify(testMessage)) as {
      properties: Record<string, unknown>;
    };
    exercise.properties.status = 'Exercise';
    const exerciseOutcome = parseNws(
      { type: 'FeatureCollection', features: [exercise] },
      CONTEXT,
    );
    expect(exerciseOutcome.completeness).toBe('complete');
    expect(exerciseOutcome.messages).toHaveLength(0);
    expect(exerciseOutcome.diagnostics).toHaveLength(1);

    const actual = JSON.parse(JSON.stringify(valid)) as { properties: Record<string, unknown> };
    actual.properties.status = 'Actual';
    const actualOutcome = parseNws(
      { type: 'FeatureCollection', features: [actual] },
      CONTEXT,
    );
    expect(actualOutcome.completeness).toBe('complete');
    expect(actualOutcome.messages).toHaveLength(1);
    expect(actualOutcome.diagnostics).toEqual([]);
  });

  it('rejects a paginated collection rather than conceal further pages', () => {
    const valid = loadFixture('live/alert-red-flag-warning-zone-ORZ691.json');
    const outcome = parseNws(
      {
        type: 'FeatureCollection',
        features: [valid],
        pagination: { next: 'https://api.weather.gov/alerts/active?cursor=synthetic' },
      },
      CONTEXT,
    );

    expect(outcome.completeness).toBe('rejected');
    expect(outcome.failures).toEqual([
      expect.objectContaining({ code: 'nws-truncated-collection' }),
    ]);
    expect(outcome.messages).toHaveLength(1);

    const noNext = parseNws(
      { type: 'FeatureCollection', features: [valid], pagination: {} },
      CONTEXT,
    );
    expect(noNext.completeness).toBe('complete');
    expect(noNext.failures).toEqual([]);
  });

  it('stamps complete provenance on every emitted alert', () => {
    const payloads = [
      loadFixture('live/alert-flood-warning-polygon-LAC019.json'),
      loadFixture('live/alert-red-flag-warning-zone-ORZ691.json'),
      loadFixture('synthetic/cancel.json'),
    ];
    const outcomes = [
      parseNws({ type: 'FeatureCollection', features: [payloads[0]] }, CONTEXT),
      parseNws({ type: 'FeatureCollection', features: [payloads[1]] }, CONTEXT),
      parseNws(payloads[2], CONTEXT),
    ];

    const alerts = outcomes.flatMap(({ messages }) => messages);
    expect(alerts).toHaveLength(3);
    for (const [index, alert] of alerts.entries()) {
      expect(validateAlertProvenance(alert, CONTEXT, index)).toEqual([]);
      expect(alert.sourceId).toBe('nws-alerts-active');
      expect(alert.provenance.mappingApplied).toEqual({
        name: NWS_MAPPING_TABLE.name,
        version: NWS_MAPPING_TABLE.version,
      });
    }
  });

  it('is deterministic for two decodes of the same bytes', async () => {
    const bytes = await readFixture(`${FIXTURE_ROOT}/live/alert-flood-warning-polygon-LAC019.json`);
    const first = parseNws(decodeIndividualAlert(bytes), CONTEXT);
    const second = parseNws(decodeIndividualAlert(bytes), CONTEXT);

    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });

  it('preserves designation, VTEC, references, timestamps, and NWS source text', () => {
    const feature = loadFixture('live/alert-flood-warning-polygon-LAC019.json');
    const alert = parseNws({ type: 'FeatureCollection', features: [feature] }, CONTEXT)
      .messages[0]!;

    expect(alert.originalDesignation).toBe('Flood Warning');
    expect(alert.parameters?.VTEC).toEqual(['/O.EXT.KLCH.FL.W.0034.000000T0000Z-260722T0600Z/']);
    expect(alert.references).toEqual([
      'nws:urn:oid:2.49.0.1.840.0.68d4016ff85029b1d21ce6630bb0208931dc1592.001.1',
      'nws:urn:oid:2.49.0.1.840.0.3752dff805703714b4e03889cc4183a849a365f4.001.1',
    ]);
    expect(alert).toMatchObject({
      sent: '2026-07-17T11:02:00-05:00',
      effective: '2026-07-17T11:02:00-05:00',
      onset: '2026-07-17T11:02:00-05:00',
      expires: '2026-07-18T11:15:00-05:00',
    });
    expect(typeof alert.sourceLanguage['en-US']?.headline).toBe('string');
    expect(typeof alert.sourceLanguage['en-US']?.description).toBe('string');
  });

  it('maps a cancel message and its reference without fabricating geometry', () => {
    const payload = loadFixture('synthetic/cancel.json');
    const outcome = parseNws(payload, CONTEXT);
    const alert = outcome.messages[0]!;

    expect(outcome.completeness).toBe('complete');
    expect(alert.messageType).toBe('cancel');
    expect(alert.posture).toBe('ended');
    expect(alert.geometry).toBeNull();
    expect(alert.references).toEqual(['nws:synthetic-original']);
  });

  it('rejects a non-FeatureCollection payload with a first-class failure', () => {
    const outcome = parseNws({ type: 'Feature' }, CONTEXT);

    expect(outcome.messages).toEqual([]);
    expect(outcome.completeness).toBe('rejected');
    expect(outcome.failures).toEqual([expect.objectContaining({ code: 'invalid-nws-collection' })]);
  });
});
