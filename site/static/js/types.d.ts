/**
 * Shared types for the Cascadia Tribal Hazard Dashboard (blueprint 2.2).
 *
 * Read by tsc only (`checkJs`); browsers never request this file. JavaScript files import types with
 * `/** @typedef {import('../types.js').Name} Name *\/`. The JSON Schemas in `schemas/` are the
 * normative form of every data file; these interfaces are their readable form, and
 * `tests/unit/contracts/schema-types.test.mjs` checks that required keys agree.
 *
 * Owner: lane L0. Changes go through L0's owner (blueprint 12.1).
 */

import type { Geometry, Feature, FeatureCollection, Point } from 'geojson';

// ---------------------------------------------------------------------------------------------
// Status (port of @ewm/core-status, extended; blueprint 3.3)
// ---------------------------------------------------------------------------------------------

export type StatusState = 'live' | 'cached' | 'stale' | 'degraded' | 'unavailable';
export type AsOfBasis = 'issued' | 'observed' | 'valid' | 'model-run' | 'retrieved';
export type DataOrigin = 'direct' | 'snapshot' | 'device';
export type Completeness = 'complete' | 'partial';

/** CAST StatusSnapshot plus dashboard fields. `asOf` is when the upstream produced the data. */
export interface StatusSnapshot {
  state: StatusState;
  asOf: string | null;
  detail?: string;
  asOfBasis: AsOfBasis | null;
  sourceIds: string[];
  origin: DataOrigin;
  completeness: Completeness;
  checkedAt: string;
}

export interface FreshnessPolicy {
  freshForMs: number;
  usableForMs: number;
}

export type StatusListener = (id: string, snapshot: StatusSnapshot) => void;

export interface StatusRegistry {
  register(id: string, initial?: StatusSnapshot): void;
  report(id: string, snapshot: StatusSnapshot): void;
  get(id: string): StatusSnapshot;
  has(id: string): boolean;
  ids(): string[];
  subscribe(listener: StatusListener): () => void;
}

/** Inputs to `deriveStatus` (blueprint 3.3 table). */
export interface StatusInputs {
  sourceIds: string[];
  policy: FreshnessPolicy;
  now: Date;
  snapshot?: { asOf: string | null; asOfBasis: AsOfBasis | null; carriedForward: boolean } | null;
  direct?: { ok: true; asOf: string | null; asOfBasis: AsOfBasis | null; completeness: Completeness; detail?: string }
    | { ok: false; error: NetError }
    | 'pending'
    | null;
  device?: { asOf: string; asOfBasis: AsOfBasis } | null;
  unavailableReason?: string;
}

// ---------------------------------------------------------------------------------------------
// Network (blueprint 3.2)
// ---------------------------------------------------------------------------------------------

export type NetErrorKind = 'offline' | 'timeout' | 'network' | 'http' | 'parse' | 'aborted' | 'rate-limited' | 'unregistered';
export type Priority = 0 | 1 | 2 | 3;

export interface NetError {
  kind: NetErrorKind;
  status?: number;
  message: string;
  retryAfterMs?: number;
}

export type NetResult<T = unknown> =
  | { ok: true; data: T; status: number; fetchedAt: string; lastModified: string | null; sourceId: string }
  | { ok: false; error: NetError; fetchedAt: string; sourceId: string };

export interface FetchOptions {
  params?: Record<string, string | number | string[]>;
  timeoutMs?: number;
  retries?: number;
  priority?: Priority;
  signal?: AbortSignal;
  cache?: RequestCache;
  ttlMs?: number;
}

export interface PagedResult<T = unknown> {
  ok: boolean;
  pages: NetResult<T>[];
  truncated: boolean;
  error?: NetError;
}

// ---------------------------------------------------------------------------------------------
// Sources registry (superset of CAST SourceRecord; blueprint 5.4)
// ---------------------------------------------------------------------------------------------

export type SourceRegion = 'us' | 'ca' | 'both';
export type AccessMode = 'direct' | 'snapshot' | 'direct+snapshot' | 'image' | 'video' | 'tiles' | 'link' | 'build';
export type SourceKind = 'api-json' | 'api-geojson' | 'ogc-features' | 'arcgis-featureserver' | 'wms' | 'xyz-tiles'
  | 'image' | 'video' | 'feed' | 'page' | 'file';
export type SourceStatus = 'active' | 'candidate' | 'active-pending-terms' | 'deprecated' | 'retired';
export type CorsStatus = 'verified-wildcard' | 'verified-reflect' | 'absent' | 'unverified';
export type PageId = 'dashboard' | 'alerts' | 'forecasts' | 'contacts' | 'resources' | 'safety' | 'news' | 'usage'
  | 'archive' | 'archive-event' | 'embed' | 'classic' | 'not-found' | 'offline';

/** CAST `SourceRecord` field for field. */
export interface CastSourceRecord {
  id: string;
  owner: string;
  url: string;
  license: string;
  cadence: string;
  region: SourceRegion;
  verifiedAt: string;
  notes?: string;
}

export interface SourceRecord {
  id: string;
  title: string;
  owner: string;
  url: string;
  urlTemplate?: string;
  humanUrl: string;
  license: string;
  attribution: string;
  cadence: string;
  region: SourceRegion;
  coverage: Jurisdiction[];
  kind: SourceKind;
  status: SourceStatus;
  deprecation: { date: string; replacement: string | null } | null;
  access: {
    mode: AccessMode;
    cors: { status: CorsStatus; acao: string | null; origin: string; checkedAt: string; evidence: string };
    headers?: Record<string, string>;
    timeoutMs?: number;
    retries?: number;
    priority?: Priority;
    poll?: { visibleMs: number; minMs: number };
    snapshot?: { task: string; files: string[]; cadenceMin: number };
  };
  freshness?: FreshnessPolicy;
  health?: { probe: string; expectStatus: number; expectAcao: string | null; expectType: string | null; minBytes: number | null; maxBytes: number | null };
  usedBy: PageId[];
  exports?: { castId?: string | null; ddmKey?: string | null };
  verifiedAt: string;
  notes?: string;
}

// ---------------------------------------------------------------------------------------------
// Geography and alerts (blueprint 3.7, 3.8)
// ---------------------------------------------------------------------------------------------

export type Jurisdiction = 'WA' | 'OR' | 'ID' | 'BC' | 'CA-N' | 'MT-W' | 'NV-N' | 'AK-SE' | 'MARINE';
/** Lowercase region codes used in URLs (`j=`) and registry `region`. */
export type RegionCode = 'wa' | 'or' | 'id' | 'bc' | 'ca-n' | 'mt-w' | 'nv-n' | 'ak-se';
export type ZoneType = 'forecast' | 'county' | 'fire' | 'marine';
export type ZoneKey = `${ZoneType}:${string}`;

export type Agency = 'nws' | 'eccc' | 'ntwc' | 'bc-rfc';
export type Designation = 'emergency' | 'warning' | 'watch' | 'advisory' | 'statement' | 'other';
export type SeverityBand = 'extreme' | 'severe' | 'moderate' | 'minor' | 'unstated';
export type ActionPosture = 'act-now' | 'prepare' | 'monitor' | 'ended';
export type AlertConfidence = 'observed' | 'likely' | 'possible' | 'unknown';
export type AlertLifecycleState = 'active' | 'superseded' | 'cancelled' | 'expired';
export type AlertMessageType = 'alert' | 'update' | 'cancel';
export type GeometryBasis = 'polygon' | 'zone' | 'point' | 'none';
export type HazardCategory = 'flood' | 'coastal' | 'rain-landslide' | 'wind' | 'winter' | 'cold' | 'heat' | 'fire'
  | 'smoke-air' | 'marine' | 'tsunami' | 'avalanche' | 'geologic' | 'evacuation' | 'other';

export interface AlertLanguageBlock {
  headline: string;
  description: string;
  instruction?: string;
}

export interface MappingApplied {
  name: string;
  version: string;
}

/** Superset of CAST `NormalizedAlert`; CAST fields keep CAST names and meanings. */
export interface DashboardAlert {
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
  sourceLanguage: Record<string, AlertLanguageBlock>;
  translationAuthority: string;
  provenance: {
    agency: string;
    originalId: string;
    fetchedAt: string;
    mappingApplied: MappingApplied;
    coverage: { geometryBasis: GeometryBasis; geocodes: readonly string[] };
  };
  agency: Agency;
  ends?: string | null;
  designation: Designation;
  categories: HazardCategory[];
  zones: ZoneKey[];
  jurisdictions: Jurisdiction[];
  marine: boolean;
  nationIds: string[];
  senderName: string;
  webUrl: string | null;
  urgency?: string;
  certainty?: string;
  severity?: string;
  parameters?: Record<string, readonly string[]>;
}

/** The index form in `alerts.json`: no text, no geometry (blueprint 5.10). */
export type DashboardAlertIndexEntry = Omit<DashboardAlert, 'sourceLanguage' | 'geometry'>;

export interface AlertDiagnostics {
  testOrExerciseExcluded: number;
  itemsFailed: number;
  unknownZoneKeys: number;
  truncated: boolean;
  [key: string]: number | boolean;
}

/** Where alerts are being shown: the whole footprint or one Nation. */
export type AlertScope =
  | { kind: 'footprint'; jurisdictions?: Jurisdiction[] }
  | { kind: 'nation'; nation: NationRecord };

export interface LoadAllAlertsResult {
  alerts: DashboardAlert[];
  statuses: Map<string, StatusSnapshot>;
  diagnostics: AlertDiagnostics;
}

export type Banner =
  | { kind: 'unknown'; reason: 'loading' | 'unavailable' | 'not-current'; lastConfirmedAt: string | null }
  | { kind: 'act-now' | 'prepare' | 'monitor'; counts: Record<Designation, number>; top: DashboardAlert;
      qualifier: null | 'stale' | 'partial' | 'cached' }
  | { kind: 'none'; asOf: string };

export interface BcHazardItem {
  id: string;
  sourceId: 'bc-rfc-flood-advisories' | 'bc-emcr-evacuations' | 'bc-embc-tsunami';
  kind: 'flood-advisory' | 'evacuation-order' | 'evacuation-alert' | 'tsunami-notification';
  title: string;
  status: string;
  issuedBy: string | null;
  updatedAt: string | null;
  band: SeverityBand;
  posture: ActionPosture;
  mappingApplied: MappingApplied;
  nationIds: string[];
  geometry: Geometry | null;
}

// ---------------------------------------------------------------------------------------------
// Nation registry (blueprint 5.2)
// ---------------------------------------------------------------------------------------------

export type NationId = `us-${'wa' | 'or' | 'id' | 'ca' | 'mt' | 'nv' | 'ak'}-${string}` | `ca-fn-${number}`;
export type NationKind = 'us-federally-recognized-tribe' | 'first-nation' | 'alaska-native-village';
export type NationFlag = 'name-orthography-needs-nation-source' | 'tz-needs-confirmation' | 'hq-moved';
export type ReviewStatus = 'draft' | 'reviewed' | 'nation-confirmed';

export interface NationRecord {
  id: string;
  castId: string | null;
  name: string;
  nameSource: { kind: 'federal-register' | 'bia-tld' | 'bia-anv' | 'isc-registered-name' | 'names-override';
    citation: string; url: string; retrievedAt: string };
  preferredName: string | null;
  preferredNameSource: { url: string; verifiedAt: string } | null;
  aliases: string[];
  kind: NationKind;
  country: 'US' | 'CA';
  jurisdictions: Jurisdiction[];
  region: RegionCode;
  hq: { lat: number; lon: number; precision: 'office' | 'community' | 'centroid'; sourceId: string;
    sourceRecordId: string; retrievedAt: string; reviewed: boolean };
  samples: [number, number][];
  bbox: [number, number, number, number];
  boundary: {
    status: 'polygon' | 'point-only';
    detailRef: string | null;
    parts: { sourceId: string; featureId: string;
      kind: 'land-area-representation' | 'reservation' | 'off-reservation-trust-land' | 'indian-reserve' | 'census-aiannh-legal';
      vintage: string }[];
  };
  timeZone: string;
  timeZoneSource: 'tz-lookup' | 'override';
  units: 'us' | 'metric';
  nws: { wfo: string[]; point: [number, number]; forecastZones: ZoneKey[]; countyZones: ZoneKey[];
    fireZones: ZoneKey[]; marineZones: ZoneKey[] } | null;
  eccc: { citypageId: string; citypageName: string; distanceKm: number; forecastZones: string[] } | null;
  radar: { nexrad: string | null; ridgeLoop: string | null; eccc: string | null };
  gauges: string[];
  contactIds: string[];
  website: { url: string; verifiedAt: string } | null;
  isc: { bandNumber: number; tribalCouncil: string | null } | null;
  codes: { biaLarIds: string[]; censusAiannhce: string[]; censusGeoid: string | null; biaTldObjectId: number | null;
    biaAnvObjectId: number | null; iscBandNumber: number | null };
  review: { status: ReviewStatus; reviewedAt: string | null; notes: string };
  flags: NationFlag[];
}

export interface NationIndexEntry {
  id: string;
  name: string;
  preferredName: string | null;
  aliases: string[];
  jurisdictions: Jurisdiction[];
  region: RegionCode;
  kind: NationKind;
  hq: [number, number];
  tz: string;
  hasBoundary: boolean;
}

export interface NationsIndex {
  schema: 'cthd.nations-index/1';
  generatedAt: string;
  nations: NationIndexEntry[];
}

export interface IdsLockEntry {
  id: string;
  key: string;
  name: string;
  mintedAt: string;
}

export interface IdsLock {
  schema: 'cthd.ids-lock/1';
  entries: IdsLockEntry[];
}

export interface IdRedirects {
  schema: 'cthd.id-redirects/1';
  redirects: Record<string, { to: string; since: string; reason: string }>;
}

// ---------------------------------------------------------------------------------------------
// Contacts, agencies, resources, declarations, news, imagery, events (blueprint 5.3 to 5.11)
// ---------------------------------------------------------------------------------------------

export type ContactScopeLevel = 'nation' | 'county' | 'regional-district' | 'state' | 'province' | 'federal' | 'regional';
export type LineType = '24-7' | 'emergency-management' | 'government-main' | 'band-office' | 'duty-officer'
  | 'non-emergency' | 'public-information' | 'tty' | 'tribal-liaison' | 'flood-hotline' | 'email' | 'web';
export type ContactSourceKind = 'nation-official' | 'state-official' | 'provincial-official' | 'county-official'
  | 'agency-official' | 'federal-directory';
export type VerificationMethod = 'page-text-match' | 'official-pdf' | 'phone-confirmed' | 'nation-confirmed' | 'federal-directory';
export type ContactStatus = 'verified' | 'needs-reverification' | 'conflict' | 'retired';

export interface Contact {
  id: string;
  scope: { level: ContactScopeLevel; region: string | null; nationId: string | null; agencyId: string | null; countyFips: string | null };
  org: string;
  office: string | null;
  lineType: LineType;
  phone: { e164: string; display: string; ext: string | null } | null;
  email: string | null;
  url: string | null;
  hours: string | null;
  publishedByNation: boolean;
  person: string | null;
  source: { url: string; publisher: string; kind: ContactSourceKind; snippet: string };
  verification: { verifiedAt: string; method: VerificationMethod; reviewDue: string };
  status: ContactStatus;
  sortWeight: number;
}

/** An organization in data/agencies.yaml (distinct from the alert `Agency` code). */
export interface AgencyRecord {
  id: string;
  name: string;
  kind: 'state' | 'province' | 'federal' | 'county' | 'regional-district' | 'nation' | 'ngo' | 'other';
  jurisdiction: string | null;
  url: string | null;
  parentId: string | null;
}

export type ResourceCategory = 'alerts-signup' | 'shelter' | 'evacuation' | 'roads' | 'rivers' | 'tribal-government'
  | 'recovery' | 'financial-assistance' | 'health' | 'volunteer' | 'preparedness' | 'forecast-office';

export interface Resource {
  id: string;
  title: string;
  url: string;
  publisher: string;
  description: string;
  category: ResourceCategory;
  hazards: HazardCategory[];
  scope: { level: ContactScopeLevel; region: string | null };
  nationId: string | null;
  phone: string | null;
  status: 'evergreen' | 'seasonal';
  validFrom?: string;
  validUntil?: string;
  verifiedAt: string;
  sourceUrl: string;
}

export interface CuratedDeclaration {
  id: string;
  issuer: { type: 'tribal' | 'first-nation' | 'state' | 'provincial' | 'county' | 'regional-district'; name: string; nationId: string | null };
  kind: 'disaster-declaration' | 'emergency-declaration' | 'emergency-proclamation' | 'state-of-local-emergency';
  title: string;
  issuedOn: string;
  effectiveUntil: string | null;
  source: { url: string; title: string; publisher: string };
  verifiedAt: string;
  reviewBy: string;
  eventId: string | null;
  femaDisasterNumber: number | null;
}

export interface FemaDeclaration {
  id: string;
  disasterNumber: number;
  type: 'DR' | 'EM' | 'FM';
  state: string;
  region: RegionCode | null;
  tribalRequest: boolean;
  title: string;
  incidentType: string;
  declaredOn: string;
  incidentBegin: string | null;
  incidentEnd: string | null;
  closedOn: string | null;
  designatedAreas: string[];
  programs: { ih: boolean; ia: boolean; pa: boolean; hm: boolean };
  nationIds: string[];
  unmatchedTribalArea: string | null;
  inFootprint: boolean;
  sourceUrl: string;
}

export interface NewsSource {
  id: string;
  name: string;
  kind: 'official' | 'media' | 'video' | 'community';
  regions: string[];
  homepage: string;
  feed: string | null;
  feedFormat: 'rss' | 'atom' | 'youtube-atom' | 'none';
  maxItems?: number;
  maxAgeDays?: number;
  verifiedAt: string;
}

export interface NewsItem {
  id: string;
  sourceId: string;
  title: string;
  url: string;
  published: string;
  summary: string;
  kind: NewsSource['kind'];
  regions: string[];
}

export interface ImageryProduct {
  id: string;
  sourceId: string;
  title?: string;
  url: string;
  still?: string;
  kind: 'still' | 'loop-gif' | 'video';
  typicalBytes: number;
  loadPolicy: 'auto' | 'tap' | 'link';
  larger?: string;
  animation?: string;
  stamp?: 'last-modified' | 'cycle' | 'none';
}

export interface EventArchive {
  id: string;
  title: string;
  period: { start: string; end: string };
  summary: string;
  archivedAt: string;
  compiledFrom: string;
  entries: {
    date: string;
    kind: 'tribal-declaration' | 'state-declaration' | 'county-notice' | 'resolution' | 'shelter' | 'river-crest' | 'news' | 'resource';
    title: string;
    issuedBy: string;
    url: string;
    verifiedAt: string;
    linkStatus: 'ok' | 'dead';
    archiveUrl: string | null;
  }[];
  femaDisasterNumbers: number[];
  notes: string[];
}

// ---------------------------------------------------------------------------------------------
// Forecasts (blueprint 3.14, 7.3)
// ---------------------------------------------------------------------------------------------

/** One NWS point-forecast period, as published (14 per forecast, labeled "7-Day Forecast"). */
export interface ForecastPeriod {
  name: string;
  startTime: string;
  endTime: string;
  isDaytime: boolean;
  temperature: number | null;
  temperatureUnit: 'F' | 'C';
  windSpeed: string | null;
  windDirection: string | null;
  shortForecast: string;
  detailedForecast: string;
  probabilityOfPrecipitation: number | null;
}

/** One day of gridpoint QPF in the Nation's time zone (the May 2026 aggregator, ported). */
export interface QpfDay {
  dayKey: string;
  label: string;
  partial: boolean;
  amountIn: number;
  amountMm: number;
  maxPop: number | null;
}

export type QpfState =
  | { state: 'idle' }
  | { state: 'loading' }
  | { state: 'ready'; days: QpfDay[]; updateTime: string; timeZone: string }
  | { state: 'error'; message: string };

// ---------------------------------------------------------------------------------------------
// Hydrology (blueprint 5.5)
// ---------------------------------------------------------------------------------------------

export type FloodCategory = 'no_flooding' | 'action' | 'minor' | 'moderate' | 'major' | 'not_defined';

/** Flood thresholds copied verbatim in the published unit: stage basis in ft or m, flow basis in cfs or kcfs. */
export type GaugeThresholds =
  | { unit: 'ft' | 'm'; basis: 'stage'; action: number | null; minor: number | null; moderate: number | null;
      major: number | null; sourceId: string; retrievedAt: string }
  | { unit: 'cfs' | 'kcfs'; basis: 'flow'; action: number | null; minor: number | null; moderate: number | null;
      major: number | null; sourceId: string; retrievedAt: string };

export interface Gauge {
  id: string;
  country: 'US' | 'CA';
  agency: 'NWS' | 'WSC';
  lid: string | null;
  usgsId: string | null;
  wscId: string | null;
  name: string;
  river: string | null;
  region: RegionCode;
  wfo: string | null;
  rfc: string | null;
  lat: number;
  lon: number;
  timeZone: string;
  stages: GaugeThresholds | null;
  isForecastPoint: boolean;
  hydrographImage: string | null;
  links: Record<string, string>;
  nationIds: string[];
  selection: 'auto' | 'curated';
}

export interface GaugeStatus {
  id: string;
  observed: { stage: number | null; unit: string | null; flow: number | null; flowUnit: string | null;
    category: FloodCategory | 'out_of_service' | null; validTime: string | null } | null;
  forecast: { stage: number | null; unit: string | null; category: FloodCategory | null; validTime: string | null;
    crestStage: number | null; crestTime: string | null } | null;
  /** WSC stations only (blueprint 7.3 view=rivers: level and discharge with trend); absent or null when not computed. */
  trend?: 'rising' | 'falling' | 'steady' | null;
}

// ---------------------------------------------------------------------------------------------
// Live snapshots (blueprint 5.10, 6.4)
// ---------------------------------------------------------------------------------------------

export interface LiveEnvelope<T> {
  schema: `cthd.live.${string}/1`;
  id: string;
  sourceIds: string[];
  generatedAt: string;
  observedAt: string;
  asOf: string | null;
  asOfBasis: AsOfBasis | null;
  completeness: 'complete' | 'partial' | 'rejected';
  carriedForward: boolean;
  failure: { code: string; message: string; at: string } | null;
  perSource: Record<string, LivePerSource>;
  diagnostics: Record<string, number>;
  items: T[];
}

/**
 * One source's facts inside an envelope. `completeness` and `carriedForward` are optional per-source
 * refinements of the envelope fields (integration ruling, Wave 1); a writer that omits them leaves the
 * envelope-level values in force.
 */
export interface LivePerSource {
  ok: boolean;
  count: number;
  asOf: string | null;
  completeness?: 'complete' | 'partial' | 'rejected';
  carriedForward?: boolean;
}

export interface LiveManifest {
  schema: 'cthd.live.manifest/1';
  generatedAt: string;
  buildSha: string;
  files: { path: string; sha256: string; bytes: number; observedAt: string; carriedForward: boolean }[];
}

export interface BuildInfo {
  sha: string;
  sha12: string;
  builtAt: string;
  swDisabled: boolean;
}

/** HTTP helper available to snapshot tasks (implemented by L9 in scripts/lib/http.mjs). */
export interface SnapshotHttp {
  getJson(sourceId: string, url: string, opts?: { timeoutMs?: number; headers?: Record<string, string> }): Promise<NetResult>;
  getText(sourceId: string, url: string, opts?: { timeoutMs?: number; headers?: Record<string, string> }): Promise<NetResult<string>>;
  head(sourceId: string, url: string, opts?: { timeoutMs?: number }): Promise<NetResult<null>>;
}

export interface SnapshotContext {
  /** The run's clock; tasks never call Date.now() directly. */
  now: Date;
  http: SnapshotHttp;
  /** The previously deployed envelope for an output file, or null. */
  previous(file: string): Promise<LiveEnvelope<unknown> | null>;
  registry: { index: NationsIndex; nation(id: string): Promise<NationRecord | null> };
  /** Committed reference data (site/data/ref and site/data/geo), read lazily by file name. */
  reference(file: string): Promise<unknown>;
  log(message: string): void;
}

/**
 * Contract for `scripts/snapshot/tasks/*.mjs` (blueprint 6.4). `run` must not throw for upstream
 * failures; it returns envelopes with completeness 'rejected' instead. Keys of the returned record are
 * output file names and must equal `outputs`. Every live file is a LiveEnvelope, including
 * alerts-text.json (items `{ alertId, sourceLanguage }`) and alerts-geometry.json (items
 * `{ alertId, geometry }`); clients index them by alertId. Each envelope validates against
 * `schemas/live-<file stem>.schema.json`.
 */
export interface SnapshotTask {
  id: string;
  sourceIds: string[];
  cadenceMin: number;
  outputs: string[];
  run(ctx: SnapshotContext): Promise<Record<string, LiveEnvelope<unknown>>>;
}

export interface AlertTextItem {
  alertId: string;
  sourceLanguage: Record<string, AlertLanguageBlock>;
}

export interface AlertGeometryItem {
  alertId: string;
  geometry: Geometry;
}

// ---------------------------------------------------------------------------------------------
// Panels (blueprint 3.3)
// ---------------------------------------------------------------------------------------------

export interface PanelLoadResult<T = unknown> {
  data: T;
  status: StatusSnapshot;
}

export interface PanelSpec<T = unknown> {
  title: string;
  sourceIds: string[];
  statusId: string;
  load: (signal: AbortSignal) => Promise<PanelLoadResult<T>>;
  render: (body: HTMLElement, data: T, status: StatusSnapshot) => void;
  renderUnavailable?: (body: HTMLElement, status: StatusSnapshot) => void;
  poll?: { visibleMs: number; minMs: number };
  heavy?: boolean;
}

export interface PanelHandle {
  refresh: () => Promise<void>;
  dispose: () => void;
}

// ---------------------------------------------------------------------------------------------
// Maps (blueprint 4)
// ---------------------------------------------------------------------------------------------

export type MapMode = 'interactive' | 'outline';
export type MapSupport = 'full' | 'caveat' | 'none';
export type MapLayerId = 'basemap' | 'outlines' | 'hq' | 'boundaries' | 'zones' | 'alerts' | 'radar' | 'gauges' | 'bc';

export interface LegendItem {
  id: string;
  label: string;
  /** CSS class from map.css that draws the swatch; never a color value. */
  swatchClass: string;
  note?: string;
}

export interface FeatureItem {
  kind: 'nation' | 'gauge' | 'alert' | 'bc-hazard';
  id: string;
  /** Accessible name that matches the drawn feature, for example "Skagit River near Mount Vernon, minor flooding". */
  name: string;
  lngLat: [number, number];
}

/** Handed to each layer's `add`. `map` is the MapLibre map in interactive mode and null in outline mode. */
export interface LayerContext {
  mode: MapMode;
  map: import('maplibre-gl').Map | null;
  maplibregl: typeof import('maplibre-gl') | null;
  /** Fetch a same-origin data file through core/net.js fetchLocal. */
  fetchLocal: (path: string, opts?: FetchOptions) => Promise<NetResult>;
  /** Read a design token from tokens.css, for example token('--tribal-magenta'). */
  token: (name: string) => string;
  status: (snapshot: StatusSnapshot) => void;
  lowData: boolean;
  signal: AbortSignal;
}

export interface MapLayer {
  id: MapLayerId | string;
  sourceIds: string[];
  add(ctx: LayerContext): Promise<void>;
  setData?(data: unknown): void;
  setVisible(on: boolean): void;
  legendItems(): LegendItem[];
  featureItems?(): FeatureItem[];
  remove(): void;
}

export interface CreateMapOptions {
  sovereignty: { sourceIds: string[] };
  label: string;
  view?: { lat: number; lon: number; zoom: number };
  layers: (MapLayerId | string)[];
  mode?: 'auto' | 'outline';
  onSelect?: (sel: { kind: string; id: string }) => void;
}

export interface CthdMap {
  mode: MapMode;
  setAlerts(a: DashboardAlert[]): void;
  setGauges(g: GaugeStatus[]): void;
  focusNation(id: string | null): void;
  setLayer(id: string, on: boolean): void;
  onModeChange(fn: (mode: MapMode, reason: string) => void): () => void;
  destroy(): void;
  // Additive, optional members (Wave 2 finisher for L0, at the request of L8 and L11). Pages feature-detect them.
  /** The "Load Interactive Map" offer from outline mode; resolves true when the interactive map is live. */
  loadInteractive?(): Promise<boolean>;
  /** British Columbia hazard polygons (EMCR evacuations, River Forecast Centre) as a FeatureCollection. */
  setBcHazards?(collection: unknown): void;
  /** Selects one alert and frames its area; null clears the selection. Not yet implemented by map/ (L8). */
  focusAlert?(alertId: string | null): void;
}

// ---------------------------------------------------------------------------------------------
// URL state, store, poller, config (blueprint 3.5, 3.13)
// ---------------------------------------------------------------------------------------------

export type UrlValueType = 'string' | 'list' | 'enum' | 'enum-list' | 'nation-id' | 'flag' | 'int' | 'latlonzoom';

export interface UrlKeySpec {
  type: UrlValueType;
  values?: readonly string[];
  min?: number;
  max?: number;
}

export type UrlStateSchema = Record<string, UrlKeySpec>;
export type UrlState = Record<string, string | string[] | number | boolean | [number, number, number] | undefined>;

export interface Store<T extends object> {
  get(): T;
  set(patch: Partial<T>): void;
  subscribe(fn: (state: T, prev: T) => void): () => void;
}

export interface Poller {
  start(): void;
  stop(): void;
  runNow(): Promise<void>;
  readonly intervalMs: number;
}

export interface PollerOptions {
  statusId: string;
  visibleMs: number;
  minMs: number;
  run: (signal: AbortSignal) => Promise<boolean>;
  jitter?: number;
}

export interface PageConfig {
  id: PageId;
  path: string;
  title: string;
  navLabel: string | null;
  views: readonly string[];
  embeddable: boolean;
  defaultEmbedHeight: number | null;
}

export interface AppConfig {
  storagePrefix: 'cthd:v1:';
  freshness: { alerts: FreshnessPolicy; gauges: FreshnessPolicy; forecasts: FreshnessPolicy };
  poll: Record<'nwsTopUp' | 'nwsTopUpActNow' | 'nwsMin' | 'eccc' | 'bcStreams' | 'snapshotReread' | 'gauges' | 'forecasts' | 'radarTiles', number>;
  net: { maxConcurrent: number; timeoutMs: number; retries: number; backoffMs: readonly number[]; jitter: number;
    retryAfterCapMs: number; pointsTtlMs: number };
  map: { firstLoadLabelBytes: number; interactiveLabelBytes: number; loadTimeoutMs: number; contextRestoreMs: number;
    tileFailureWindowMs: number; featureListCap: number; phoneMaxZoom: number; desktopMaxZoom: number };
  flags: { enableCandidateSources: boolean; serviceWorker: boolean };
  contactReviewDays: number;
  alertMaxZoneFallbackFetches: number;
}

// Re-exported GeoJSON helpers so modules need only one import path.
export type { Geometry, Feature, FeatureCollection, Point };
