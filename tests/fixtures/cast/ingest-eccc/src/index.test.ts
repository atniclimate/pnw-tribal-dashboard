import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { ECCC_MAPPING_TABLE } from '@ewm/alerts-schema';
import { replayCorpus, type CorpusFixture, type ParseContext } from '@ewm/ingest-core';
import { describe, expect, it } from 'vitest';

import {
  ECCC_MIXED_ACTIVE_COHORT_FAILURE,
  parseEcccCapCp,
  parseEcccGeoMet,
} from './index.js';

const FIXTURE_ROOT = fileURLToPath(new URL('../fixtures/', import.meta.url));
const encoder = new TextEncoder();

const geometContext: ParseContext = {
  source: {
    id: 'eccc-geomet-weather-alerts',
    owner: 'ECCC',
    url: 'https://api.weather.gc.ca/collections/weather-alerts/items',
    license: 'ECCC Data Servers End-use Licence v2.1',
    cadence: 'event-driven',
    region: 'ca',
    verifiedAt: '2026-07-17',
  },
  fetchedAt: '2026-07-17T21:45:00Z',
  mapping: { name: ECCC_MAPPING_TABLE.name, version: ECCC_MAPPING_TABLE.version },
};

const capContext: ParseContext = {
  ...geometContext,
  source: { ...geometContext.source, id: 'eccc-datamart-cap-files' },
};

function bytes(relativePath: string): Uint8Array {
  return new Uint8Array(readFileSync(fileURLToPath(new URL(`../fixtures/${relativePath}`, import.meta.url))));
}

function parseGeo(relativePath: string) {
  return parseEcccGeoMet(bytes(relativePath), geometContext);
}

function parseCap(relativePath: string) {
  return parseEcccCapCp(bytes(relativePath), capContext);
}

describe('@ewm/ingest-eccc corpus replay', () => {
  it('replays every vendored live and synthetic payload deterministically with valid provenance', async () => {
    const geoFixtures: readonly CorpusFixture<Uint8Array>[] = [
      {
        label: 'live GeoMet FeatureCollection (limit=10 page of 504 matched: truncated)',
        relativePath: 'live/weather-alerts-items-limit10.json',
        context: geometContext,
        decode: (input) => input,
        expectedCompleteness: 'rejected',
      },
      {
        label: 'synthetic impact precedence cases',
        relativePath: 'synthetic/impact-precedence.json',
        context: geometContext,
        decode: (input) => input,
        expectedCompleteness: 'complete',
      },
      {
        label: 'synthetic ended statement',
        relativePath: 'synthetic/ended-statement.json',
        context: geometContext,
        decode: (input) => input,
        expectedCompleteness: 'complete',
      },
      {
        label: 'synthetic malformed feature with valid neighbour',
        relativePath: 'synthetic/malformed-feature.json',
        context: geometContext,
        decode: (input) => input,
        expectedCompleteness: 'rejected',
      },
      {
        label: 'synthetic GeoMet parity alert',
        relativePath: 'synthetic/parity-geomet.json',
        context: geometContext,
        decode: (input) => input,
        expectedCompleteness: 'complete',
      },
    ];
    const capFixtures: readonly CorpusFixture<Uint8Array>[] = [
      {
        label: 'live bilingual CAP-CP alert',
        relativePath: 'live/T_WWCN13_C_CWVR_202607170903_2092774527.cap',
        context: capContext,
        decode: (input) => input,
        expectedCompleteness: 'complete',
      },
      {
        label: 'synthetic CAP-CP parity alert',
        relativePath: 'synthetic/parity.cap',
        context: capContext,
        decode: (input) => input,
        expectedCompleteness: 'complete',
      },
    ];
    const reader = async (absolutePath: string): Promise<Uint8Array> =>
      new Uint8Array(await readFile(absolutePath));

    const geoReport = await replayCorpus(FIXTURE_ROOT, geoFixtures, parseEcccGeoMet, reader);
    const capReport = await replayCorpus(FIXTURE_ROOT, capFixtures, parseEcccCapCp, reader);

    expect(geoReport).toMatchObject({ fixtureCount: 5, completeCount: 3, rejectedCount: 2 });
    expect(capReport).toMatchObject({ fixtureCount: 2, completeCount: 2, rejectedCount: 0 });
    expect([...geoReport.fixtures, ...capReport.fixtures]).toHaveLength(7);
    expect([...geoReport.fixtures, ...capReport.fixtures].every((item) => /^[a-f0-9]{64}$/.test(item.inputSha256))).toBe(true);
  });
});

describe('GeoMet production wire', () => {
  it('preserves both live language blocks, polygon geometry, and province coverage', () => {
    const outcome = parseGeo('live/weather-alerts-items-limit10.json');
    const alert = outcome.messages[0];

    // This live capture is a deliberate limit=10 page of 504 matched alerts:
    // items still normalize faithfully, but the truncated page rejects the
    // batch so a partial collection can never publish as complete.
    expect(outcome.completeness).toBe('rejected');
    expect(outcome.failures).toEqual([
      expect.objectContaining({ code: 'eccc-truncated-collection' }),
    ]);
    expect(outcome.messages).toHaveLength(10);
    expect(Object.keys(alert?.sourceLanguage ?? {})).toEqual(['en-CA', 'fr-CA']);
    expect(alert?.sourceLanguage['en-CA']?.description).toContain('Conditions are favourable');
    expect(alert?.sourceLanguage['fr-CA']?.description).toContain('Les conditions sont propices');
    expect(alert?.translationAuthority).toBe('ECCC');
    expect(alert?.geometry?.type).toBe('Polygon');
    expect(alert?.provenance.coverage).toEqual({ geometryBasis: 'polygon', geocodes: ['province:BC'] });
  });

  it('never synthesizes a missing language block', () => {
    const outcome = parseGeo('synthetic/impact-precedence.json');

    expect(Object.keys(outcome.messages[1]?.sourceLanguage ?? {})).toEqual(['en-CA']);
    expect(Object.keys(outcome.messages[2]?.sourceLanguage ?? {})).toEqual(['fr-CA']);
  });

  it('applies impact over colour over base CAP severity', () => {
    const outcome = parseGeo('synthetic/impact-precedence.json');
    expect(outcome.messages.map(({ band }) => band)).toEqual(['minor', 'severe', 'moderate']);
  });

  it('does not infer severity from a scary product title', () => {
    const alert = parseGeo('synthetic/impact-precedence.json').messages[0];
    expect(alert?.originalDesignation).toBe('Catastrophic Red Emergency Warning');
    expect(alert?.band).toBe('minor');
  });

  it('maps an ended statement to ended posture', () => {
    const alert = parseGeo('synthetic/ended-statement.json').messages[0];
    expect(alert).toMatchObject({ band: 'minor', posture: 'ended' });
  });

  it('isolates a malformed item while rejecting the candidate batch', () => {
    const outcome = parseGeo('synthetic/malformed-feature.json');
    expect(outcome).toMatchObject({ completeness: 'rejected' });
    expect(outcome.messages.map(({ alertId }) => alertId)).toEqual(['eccc:synthetic-valid-neighbour']);
    expect(outcome.failures).toHaveLength(1);
    expect(outcome.failures[0]).toMatchObject({ code: 'eccc-geomet-invalid-feature', itemIndex: 1 });
  });
});

describe('CAP-CP conformance wire', () => {
  it('matches equivalent GeoMet identity and dimensions while preserving CAP references', () => {
    const geo = parseGeo('synthetic/parity-geomet.json').messages[0];
    const cap = parseCap('synthetic/parity.cap').messages[0];

    expect(cap).toBeDefined();
    expect({ alertId: cap?.alertId, eventId: cap?.eventId, band: cap?.band, posture: cap?.posture, confidence: cap?.confidence }).toEqual({
      alertId: geo?.alertId,
      eventId: geo?.eventId,
      band: geo?.band,
      posture: geo?.posture,
      confidence: geo?.confidence,
    });
    expect(Object.keys(cap?.sourceLanguage ?? {})).toEqual(['en-CA', 'fr-CA']);
    expect(cap?.references).toEqual(['eccc:synthetic-eccc-prior-001']);
  });

  it('rejects DTD-bearing XML before parsing or entity processing', () => {
    const xml = new TextDecoder().decode(bytes('synthetic/parity.cap'));
    const hostile = xml.replace('?>', '?><!DOCTYPE alert [<!ENTITY x "expanded">]>');
    const outcome = parseEcccCapCp(encoder.encode(hostile), capContext);

    expect(outcome).toMatchObject({ completeness: 'rejected', messages: [] });
    expect(outcome.failures[0]?.message).toContain('must not contain DOCTYPE or ENTITY');
  });

  it('uses the exported arbitration category for incompatible active cohorts', () => {
    const xml = new TextDecoder().decode(bytes('synthetic/parity.cap'));
    const mixed = xml.replace(
      '<effective>2026-07-17T21:00:00Z</effective>',
      '<effective>2026-07-17T21:01:00Z</effective>',
    );
    const outcome = parseEcccCapCp(encoder.encode(mixed), capContext);

    expect(outcome).toMatchObject({ completeness: 'rejected', messages: [] });
    expect(outcome.failures[0]?.code).toBe(ECCC_MIXED_ACTIVE_COHORT_FAILURE);
  });
});
