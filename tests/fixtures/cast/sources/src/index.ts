/**
 * @ewm/sources — the verified source registry.
 *
 * Platform invariant #7: no ad-hoc fetch URLs in module code. Every external
 * endpoint is registered as a SourceRecord carrying its owner, license,
 * cadence, coverage region, and the date a human last verified all of that.
 *
 * The registry ships EMPTY except for the one documented development basemap.
 * Real endpoints are added through the verification process described in
 * docs/ARCHITECTURE.md ("Source verification").
 *
 * Framework-agnostic: vanilla TypeScript, zero dependencies.
 */

export type SourceRegion = 'us' | 'ca' | 'both';

export interface SourceRecord {
  /** Kebab-case, globally unique, e.g. "nws-alerts-cap". */
  id: string;
  /** The organization that operates the endpoint. */
  owner: string;
  /** Endpoint URL. Tile templates may contain {z}/{x}/{y} placeholders. */
  url: string;
  /** License or usage terms the data is provided under. */
  license: string;
  /** Human-readable update cadence, e.g. "hourly", "static", "event-driven". */
  cadence: string;
  /** Geographic coverage this platform cares about. */
  region: SourceRegion;
  /** ISO date (YYYY-MM-DD) a human last verified the URL, license, and cadence. */
  verifiedAt: string;
  notes?: string;
}

const ID_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const REGIONS: readonly SourceRegion[] = ['us', 'ca', 'both'];

/**
 * Validate a candidate source record. Returns a list of problems; empty means valid.
 */
export function validateSourceRecord(candidate: unknown): string[] {
  const problems: string[] = [];
  if (typeof candidate !== 'object' || candidate === null) {
    return ['record must be an object'];
  }
  const record = candidate as Partial<SourceRecord>;

  if (typeof record.id !== 'string' || !ID_PATTERN.test(record.id)) {
    problems.push('id must be a kebab-case string');
  }
  for (const field of ['owner', 'license', 'cadence'] as const) {
    if (typeof record[field] !== 'string' || record[field].trim() === '') {
      problems.push(`${field} must be a non-empty string`);
    }
  }
  if (typeof record.url !== 'string') {
    problems.push('url must be a string');
  } else {
    try {
      const parsed = new URL(record.url);
      if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
        problems.push('url must be http(s)');
      }
    } catch {
      problems.push(`url is not parseable: "${record.url}"`);
    }
  }
  if (!REGIONS.includes(record.region as SourceRegion)) {
    problems.push(`region must be one of ${REGIONS.join(', ')}`);
  }
  if (
    typeof record.verifiedAt !== 'string' ||
    !DATE_PATTERN.test(record.verifiedAt) ||
    Number.isNaN(Date.parse(record.verifiedAt))
  ) {
    problems.push('verifiedAt must be an ISO date (YYYY-MM-DD)');
  }
  return problems;
}

export interface SourceRegistry {
  /** Add a record. Throws on validation problems or duplicate ids. */
  add(record: SourceRecord): void;
  get(id: string): SourceRecord;
  has(id: string): boolean;
  /** List records, optionally by region. A region filter always includes 'both'. */
  list(filter?: { region?: Exclude<SourceRegion, 'both'> }): SourceRecord[];
}

export function createSourceRegistry(records: SourceRecord[] = []): SourceRegistry {
  const byId = new Map<string, SourceRecord>();

  const registry: SourceRegistry = {
    add(record) {
      const problems = validateSourceRecord(record);
      if (problems.length > 0) {
        throw new Error(`invalid source record: ${problems.join('; ')}`);
      }
      if (byId.has(record.id)) {
        throw new Error(`source id "${record.id}" is already registered`);
      }
      byId.set(record.id, record);
    },
    get(id) {
      const record = byId.get(id);
      if (record === undefined) {
        throw new Error(
          `source "${id}" is not registered — every endpoint must go through the verified source registry`,
        );
      }
      return record;
    },
    has: (id) => byId.has(id),
    list(filter) {
      const all = [...byId.values()];
      if (filter?.region === undefined) return all;
      return all.filter((r) => r.region === filter.region || r.region === 'both');
    },
  };

  for (const record of records) {
    registry.add(record);
  }
  return registry;
}

/**
 * The one source this repo ships: a development/proof-of-life basemap.
 *
 * OpenStreetMap raster tiles. Data is © OpenStreetMap contributors (ODbL 1.0);
 * the default tile service is run by the OSM Foundation under a usage policy
 * that PROHIBITS heavy production traffic. Production deployments must switch
 * to self-hosted PMTiles or a provider with appropriate terms before launch —
 * this is tracked in docs/ROADMAP.md.
 */
/**
 * Alert ingestion sources (wave 1c lane 0, 07/17/2026). Endpoint, CORS
 * behavior, and payload shape verified live the same day (see the corpus
 * manifest); license and cadence per the source-profile research. The
 * maintainer's source-verification eyeball is tracked as a follow-up.
 */

/** Canonical NWS current-alert collection, for snapshots and direct top-up. */
export const NWS_ALERTS_ACTIVE_SOURCE: SourceRecord = {
  id: 'nws-alerts-active',
  owner: 'NOAA National Weather Service',
  url: 'https://api.weather.gov/alerts/active',
  license:
    'U.S. public domain unless otherwise noted; acknowledge NWS, do not imply endorsement, and do not present modified content as official.',
  cadence: 'Event-driven; NWS asks clients to poll alerts no more often than every 30 seconds.',
  region: 'us',
  verifiedAt: '2026-07-17',
  notes:
    'No API key today. Distinctive User-Agent required for API clients (browsers cannot set one; ' +
    'direct browser top-up is feature-gated, the snapshot spine is primary). ' +
    'Access-Control-Allow-Origin: * observed 2026-07-17. Alert geometry may be absent; retain UGC/SAME codes. ' +
    'Canadian counterpart: eccc-geomet-weather-alerts.',
};

/** Canonical ECCC current-alert collection (GeoMet OGC API), for snapshots and candidate direct top-up. */
export const ECCC_GEOMET_WEATHER_ALERTS_SOURCE: SourceRecord = {
  id: 'eccc-geomet-weather-alerts',
  owner: 'Environment and Climate Change Canada, Meteorological Service of Canada',
  url: 'https://api.weather.gc.ca/collections/weather-alerts/items?filter=properties.province=BC&limit=500',
  license:
    'ECCC Data Servers End-use Licence v2.1; attribution required; weather-alert content or intent must not be altered.',
  cadence: 'Event-driven; ATNI polling policy 60 to 120 seconds. Contact ECCC before 86400 requests/day or more.',
  region: 'ca',
  verifiedAt: '2026-07-17',
  notes:
    'Anonymous OGC API - Features endpoint; collection id is "weather-alerts" (no -realtime variant). ' +
    'Bilingual properties (alert_name_en/fr, impact_en/fr, confidence_en/fr) confirmed in a live capture 2026-07-17; ' +
    'Access-Control-Allow-Origin: * observed the same day. The server pages at a 500-item cap ' +
    '(verified live 2026-07-17: unfiltered 535 matched / 500 returned with a next link), so the ' +
    'registered URL carries the BC province filter and an explicit limit=500; parsers reject any ' +
    'page whose numberMatched exceeds its feature count rather than publish a partial collection. ' +
    'U.S. counterpart: nws-alerts-active.',
};

/** ECCC Datamart CAP-CP files: conformance and corpus provenance only, never a runtime feed. */
export const ECCC_DATAMART_CAP_FILES_SOURCE: SourceRecord = {
  id: 'eccc-datamart-cap-files',
  owner: 'Environment and Climate Change Canada, Meteorological Service of Canada',
  url: 'https://dd.weather.gc.ca/today/alerts/cap/',
  license:
    'ECCC Data Servers End-use Licence v2.1; attribution required; weather-alert content or intent must not be altered.',
  cadence: 'Alert files may appear at any time; recurring HTTPS directory polling is prohibited by ECCC.',
  region: 'ca',
  verifiedAt: '2026-07-17',
  notes:
    'Individually addressed CAP-file retrieval and corpus provenance only. Moving retention window. ' +
    'Never used as the DS-004 runtime feed; the sanctioned real-time channel (AMQPS) needs an always-on ' +
    'subscriber and is out of scope for the serverless-static architecture.',
};

export const OSM_RASTER_BASEMAP: SourceRecord = {
  id: 'basemap-osm-raster',
  owner: 'OpenStreetMap Foundation',
  url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
  license: 'Data: ODbL 1.0 (© OpenStreetMap contributors). Tiles: OSMF Tile Usage Policy.',
  cadence: 'continuous (community-maintained)',
  region: 'both',
  verifiedAt: '2026-07-14',
  notes:
    'Development basemap only. OSMF tile policy (operations.osmfoundation.org/policies/tiles) ' +
    'disallows heavy use; replace with self-hosted PMTiles before production. ' +
    'Attribution "© OpenStreetMap contributors" is mandatory and wired in @ewm/map-core.',
};
