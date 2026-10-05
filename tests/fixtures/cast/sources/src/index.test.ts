import { describe, expect, it } from 'vitest';
import {
  createSourceRegistry,
  ECCC_DATAMART_CAP_FILES_SOURCE,
  ECCC_GEOMET_WEATHER_ALERTS_SOURCE,
  NWS_ALERTS_ACTIVE_SOURCE,
  OSM_RASTER_BASEMAP,
  validateSourceRecord,
  type SourceRecord,
} from './index.js';

const VALID: SourceRecord = {
  id: 'example-feed',
  owner: 'Example Agency',
  url: 'https://example.test/api/data',
  license: 'Public Domain',
  cadence: 'hourly',
  region: 'us',
  verifiedAt: '2026-07-14',
};

describe('validateSourceRecord', () => {
  it('accepts a fully specified record', () => {
    expect(validateSourceRecord(VALID)).toEqual([]);
  });

  it('accepts tile-template URLs with {z}/{x}/{y} placeholders', () => {
    expect(validateSourceRecord(OSM_RASTER_BASEMAP)).toEqual([]);
  });

  it('reports every missing or malformed field', () => {
    const problems = validateSourceRecord({
      id: 'Not Kebab',
      owner: '',
      url: 'file:///etc/passwd',
      license: 'MIT',
      cadence: 'hourly',
      region: 'europe',
      verifiedAt: 'last week',
    });
    expect(problems.some((p) => p.includes('id'))).toBe(true);
    expect(problems.some((p) => p.includes('owner'))).toBe(true);
    expect(problems.some((p) => p.includes('http(s)'))).toBe(true);
    expect(problems.some((p) => p.includes('region'))).toBe(true);
    expect(problems.some((p) => p.includes('verifiedAt'))).toBe(true);
  });

  it('rejects non-objects', () => {
    expect(validateSourceRecord(null)).toEqual(['record must be an object']);
  });
});

describe('createSourceRegistry', () => {
  it('adds and retrieves records', () => {
    const registry = createSourceRegistry();
    registry.add(VALID);
    expect(registry.get('example-feed')).toEqual(VALID);
    expect(registry.has('example-feed')).toBe(true);
  });

  it('rejects invalid records at the door', () => {
    const registry = createSourceRegistry();
    expect(() => registry.add({ ...VALID, region: 'mars' as never })).toThrow(/region/);
  });

  it('rejects duplicate ids', () => {
    const registry = createSourceRegistry([VALID]);
    expect(() => registry.add(VALID)).toThrow(/already registered/);
  });

  it('throws a pointed error for unregistered lookups', () => {
    const registry = createSourceRegistry();
    expect(() => registry.get('ad-hoc-url')).toThrow(/verified source registry/);
  });

  it('filters by region, always including "both"', () => {
    const usOnly: SourceRecord = { ...VALID, id: 'us-feed', region: 'us' };
    const caOnly: SourceRecord = { ...VALID, id: 'ca-feed', region: 'ca' };
    const registry = createSourceRegistry([usOnly, caOnly, OSM_RASTER_BASEMAP]);
    const ids = registry.list({ region: 'ca' }).map((r) => r.id);
    expect(ids).toContain('ca-feed');
    expect(ids).toContain('basemap-osm-raster');
    expect(ids).not.toContain('us-feed');
  });
});

describe('alert ingestion source records', () => {
  const RECORDS = [
    NWS_ALERTS_ACTIVE_SOURCE,
    ECCC_GEOMET_WEATHER_ALERTS_SOURCE,
    ECCC_DATAMART_CAP_FILES_SOURCE,
  ];

  it('every shipped ingestion record validates cleanly', () => {
    for (const record of RECORDS) {
      expect(validateSourceRecord(record), record.id).toEqual([]);
    }
  });

  it('registers all shipped records together without id collisions', () => {
    const registry = createSourceRegistry([...RECORDS, OSM_RASTER_BASEMAP]);
    expect(registry.get('nws-alerts-active').region).toBe('us');
    expect(registry.get('eccc-geomet-weather-alerts').region).toBe('ca');
    expect(registry.get('eccc-datamart-cap-files').notes).toMatch(/never used as the DS-004 runtime feed/i);
  });
});
