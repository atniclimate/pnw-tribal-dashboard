// @ts-check
/**
 * Load orchestration (blueprint 3.7.6, 3.7.7, 10.2 scenarios 1 to 4 at the module level): snapshot first,
 * complete direct replaces, partial direct unions, truncation and malformed items degrade without hiding
 * alerts, a failed direct fetch falls back to the scheduled copy, and nothing at all is unavailable.
 * Network functions are replaced by in-memory answers built from dated captures; status derivation is the
 * real core/status.js.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { bcInScope, loadAllAlerts, mergeDirectWithSnapshot, LIVE_FILES } from '../../../site/static/js/alerts/service.js';
import { ecccInScope } from '../../../site/static/js/alerts/eccc.js';
import { summarizeForBanner, requiredSourcesFor } from '../../../site/static/js/alerts/banner.js';
import { normalizeNwsCollection } from '../../../site/static/js/alerts/nws.js';
import { toIndexEntry } from '../../../site/static/js/alerts/model.js';
import { footprintIndex } from '../../../site/static/js/alerts/footprint.js';
import { prepareAlerts } from '../../../site/static/js/alerts/relevance.js';
import { deriveStatus } from '../../../site/static/js/core/status.js';
import { ROOT, ctxOf, fixture, fixtureNation, testFootprintUgc } from './helpers.mjs';

const fpUgc = testFootprintUgc();
const fpIdx = footprintIndex(fpUgc, [-180, -90, 180, 90]);
const footprintCap = fixture('nws-alerts-active', 'footprint-active.json');
const topup = fixture('nws-alerts-active', 'topup-wa-or-id-pz.json');
const malformed = fixture('nws-alerts-active', 'topup-one-malformed-item.json');
const ecccQuiet = fixture('eccc-geomet-weather-alerts', 'bc-province-filter.json');
const NOW = new Date('2026-10-05T06:30:00Z');

/**
 * A snapshot envelope built from the footprint capture, as the alerts task writes it.
 * @param {{ asOf?: string, nwsItems?: any[] }} [o]
 */
function snapshotEnvelope(o = {}) {
  const alerts = o.nwsItems ?? prepareAlerts(normalizeNwsCollection(footprintCap.body, ctxOf(footprintCap.meta)).alerts, { now: NOW, footprint: fpIdx }).alerts;
  const asOf = o.asOf ?? '2026-10-05T06:23:38+00:00';
  return {
    schema: 'cthd.live.alerts/1', id: 'alerts', sourceIds: ['nws-alerts-active', 'eccc-geomet-weather-alerts'],
    generatedAt: asOf, observedAt: asOf, asOf, asOfBasis: 'issued', completeness: 'complete', carriedForward: false, failure: null,
    perSource: { 'nws-alerts-active': { ok: true, count: alerts.length, asOf }, 'eccc-geomet-weather-alerts': { ok: true, count: 0, asOf } },
    diagnostics: {}, items: alerts.map(toIndexEntry),
  };
}

/** @param {any} data @param {string} fetchedAt */
const ok = (data, fetchedAt = '2026-10-05T06:29:50Z') => ({ ok: true, data, status: 200, fetchedAt, lastModified: null, sourceId: 'x' });
/** @param {number} status */
const fail = (status) => ({ ok: false, error: { kind: 'http', status, message: `HTTP ${status}` }, fetchedAt: '2026-10-05T06:29:50Z', sourceId: 'x' });

/**
 * @param {{ local?: Record<string, any>, direct?: (sourceId: string, params: Record<string, any>) => any, log?: string[] }} o
 * @returns {any}
 */
function deps(o) {
  const log = o.log ?? [];
  return {
    now: () => NOW,
    isEnabled: () => true,
    deriveStatus,
    fetchLocal: async (/** @type {string} */ p) => {
      log.push(`local ${p}`);
      if (o.local && p in o.local) return o.local[p] === null ? fail(404) : ok(o.local[p]);
      if (p === LIVE_FILES.footprintUgc) return ok(fpUgc);
      if (p.startsWith('data/ref/')) return ok(JSON.parse(readFileSync(path.join(ROOT, 'site', p), 'utf8')));
      return fail(404);
    },
    fetchAllPages: async (/** @type {string} */ sourceId, /** @type {any} */ opts) => {
      log.push(`direct ${sourceId} ${JSON.stringify(opts.params)}`);
      const r = o.direct ? o.direct(sourceId, opts.params) : fail(503);
      return r.pages ? r : { ok: r.ok, pages: [r], truncated: false, ...(r.ok ? {} : { error: r.error }) };
    },
  };
}

test('snapshot first: the banner can paint from alerts.json before any direct request is made', async () => {
  /** @type {string[]} */
  const log = [];
  /** @type {any} */
  let painted = null;
  const result = await loadAllAlerts({
    scope: { kind: 'footprint' }, registry: { index: null }, page: 'dashboard',
    onSnapshot: (r) => { painted = { r, at: log.length }; },
    deps: deps({ local: { [LIVE_FILES.index]: snapshotEnvelope() }, direct: () => ok(topup.body), log }),
  });
  assert.ok(painted, 'onSnapshot was called');
  assert.ok(!log.slice(0, painted.at).some((l) => l.startsWith('direct')), 'no direct request before paint');
  assert.ok(painted.r.alerts.length > 0);
  assert.equal(painted.r.statuses.get('nws-alerts-active').origin, 'snapshot');
  assert.ok(result.statuses.get('nws-alerts-active'));
});

test('a complete direct set replaces the NWS snapshot set and is live', async () => {
  const r = await loadAllAlerts({ scope: { kind: 'footprint' }, registry: { index: null }, page: 'dashboard',
    deps: deps({ local: { [LIVE_FILES.index]: snapshotEnvelope() }, direct: () => ok(topup.body) }) });
  const nws = r.statuses.get('nws-alerts-active');
  assert.equal(nws?.state, 'live');
  assert.equal(nws?.completeness, 'complete');
  const directIds = new Set(normalizeNwsCollection(topup.body, ctxOf(topup.meta)).alerts.map((a) => a.alertId));
  assert.ok(r.alerts.filter((a) => a.agency === 'nws').every((a) => directIds.has(a.alertId)));
});

test('a device-saved alert snapshot never becomes live or all-clear after a failed top-up', async () => {
  const env = snapshotEnvelope({ nwsItems: [] });
  const mock = deps({ local: { [LIVE_FILES.index]: env } });
  const fetchLocal = mock.fetchLocal;
  mock.fetchLocal = async (/** @type {string} */ path) => ({ ...(await fetchLocal(path)), fromCache: true });
  const result = await loadAllAlerts({ scope: { kind: 'footprint' }, registry: { index: null }, deps: mock });
  const nws = result.statuses.get('nws-alerts-active');
  assert.equal(nws?.state, 'cached');
  assert.equal(nws?.origin, 'device');
  assert.equal(nws?.asOf, env.asOf);
  assert.equal(summarizeForBanner([], result.statuses, ['nws-alerts-active'], NOW).kind, 'unknown');
});

test('a malformed item and a truncated collection: degraded, every valid alert shown, no all-clear', async () => {
  const pages = { ok: true, truncated: true, pages: [ok(malformed.body)] };
  const r = await loadAllAlerts({ scope: { kind: 'footprint' }, registry: { index: null }, page: 'dashboard',
    deps: deps({ local: { [LIVE_FILES.index]: snapshotEnvelope() }, direct: () => pages }) });
  const nws = r.statuses.get('nws-alerts-active');
  assert.equal(nws?.state, 'degraded');
  assert.equal(nws?.completeness, 'partial');
  assert.match(nws?.detail ?? '', /Partial|could not be displayed/);
  const valid = prepareAlerts(normalizeNwsCollection(malformed.body, ctxOf(malformed.meta)).alerts, { now: NOW, footprint: fpIdx }).alerts;
  for (const a of valid) assert.ok(r.alerts.some((x) => x.alertId === a.alertId), `valid alert ${a.alertId} shown`);
  const banner = summarizeForBanner(r.alerts, r.statuses, requiredSourcesFor({ kind: 'footprint' }), NOW);
  assert.notEqual(banner.kind, 'none');
  // Even with zero alerts, a partial source forbids the all-clear.
  assert.equal(summarizeForBanner([], r.statuses, ['nws-alerts-active'], NOW).kind, 'unknown');
});

test('NWS 503 with a 25-minute-old snapshot: stale, scheduled copy shown, never the zero message', async () => {
  const env = snapshotEnvelope({ asOf: '2026-10-05T06:05:00Z' });
  const r = await loadAllAlerts({ scope: { kind: 'footprint' }, registry: { index: null }, page: 'dashboard',
    deps: deps({ local: { [LIVE_FILES.index]: env }, direct: () => fail(503) }) });
  const nws = r.statuses.get('nws-alerts-active');
  assert.equal(nws?.state, 'stale');
  assert.equal(nws?.origin, 'snapshot');
  assert.match(nws?.detail ?? '', /scheduled copy/);
  assert.equal(r.alerts.filter((a) => a.agency === 'nws').length, env.items.length);
  const empty = await loadAllAlerts({ scope: { kind: 'footprint' }, registry: { index: null }, page: 'dashboard',
    deps: deps({ local: { [LIVE_FILES.index]: snapshotEnvelope({ asOf: '2026-10-05T06:05:00Z', nwsItems: [] }) }, direct: () => fail(503) }) });
  assert.equal(summarizeForBanner(empty.alerts, empty.statuses, ['nws-alerts-active'], NOW).kind, 'unknown');
});

test('all upstreams down and no snapshot: every source unavailable, the banner is unknown', async () => {
  const r = await loadAllAlerts({ scope: { kind: 'footprint' }, registry: { index: null }, page: 'alerts',
    deps: deps({ local: { [LIVE_FILES.index]: null, [LIVE_FILES.tsunami]: null }, direct: () => fail(503) }) });
  assert.equal(r.alerts.length, 0);
  for (const id of ['nws-alerts-active', 'eccc-geomet-weather-alerts', 'ntwc-atom']) assert.equal(r.statuses.get(id)?.state, 'unavailable', id);
  const b = summarizeForBanner(r.alerts, r.statuses, requiredSourcesFor({ kind: 'footprint' }), NOW);
  assert.deepEqual(b, { kind: 'unknown', reason: 'unavailable', lastConfirmedAt: null });
});

test('Nation scope: one zone= request; results post-filtered by typed key; ECCC not fetched for a U.S. Nation', async () => {
  const lummi = fixtureNation('us-wa-lummi-tribe-of-the-lummi-reservation');
  /** @type {string[]} */
  const log = [];
  const zoneAlert = structuredClone(topup.body.features[1]);
  zoneAlert.properties.affectedZones = ['https://api.weather.gov/zones/forecast/WAZ310'];
  zoneAlert.properties.geocode.UGC = ['WAZ310'];
  const otherType = structuredClone(topup.body.features[2]);
  otherType.properties.affectedZones = ['https://api.weather.gov/zones/fire/WAZ310'];
  otherType.properties.geocode.UGC = ['WAZ310'];
  const coll = { ...topup.body, features: [zoneAlert, otherType] };
  const r = await loadAllAlerts({ scope: { kind: 'nation', nation: lummi }, registry: { index: null }, page: 'dashboard',
    deps: deps({ local: { [LIVE_FILES.index]: snapshotEnvelope({ nwsItems: [] }) }, direct: () => ok(coll), log }) });
  const directs = log.filter((l) => l.startsWith('direct'));
  assert.equal(directs.length, 1);
  assert.match(directs[0] ?? '', /"zone":"[A-Z0-9,]*WAZ310/);
  assert.deepEqual(r.alerts.map((a) => a.alertId), [`nws:${zoneAlert.properties.id}`], 'fire:WAZ310 is not Lummi\'s forecast:WAZ310');
  assert.deepEqual(r.alerts[0]?.nationIds, [lummi.id]);
});

test('ECCC tops up only when British Columbia is in scope', async () => {
  /** @type {string[]} */
  const log = [];
  const direct = (/** @type {string} */ id) => (id === 'eccc-geomet-weather-alerts' ? ok(ecccQuiet.body) : ok(topup.body));
  await loadAllAlerts({ scope: { kind: 'footprint' }, registry: { index: null }, page: 'dashboard', deps: deps({ local: { [LIVE_FILES.index]: snapshotEnvelope() }, direct, log }) });
  assert.ok(!log.some((l) => l.includes('eccc-geomet-weather-alerts')));
  const bc = fixtureNation('ca-fn-602');
  const r = await loadAllAlerts({ scope: { kind: 'nation', nation: bc }, registry: { index: null }, page: 'dashboard', deps: deps({ local: { [LIVE_FILES.index]: snapshotEnvelope() }, direct, log }) });
  assert.ok(log.some((l) => l.includes('eccc-geomet-weather-alerts') && l.includes(bc.bbox.join(','))));
  assert.equal(r.statuses.get('eccc-geomet-weather-alerts')?.state, 'live');
  const b = summarizeForBanner(r.alerts.filter((a) => a.nationIds.includes(bc.id)), r.statuses, requiredSourcesFor({ kind: 'nation', nation: bc }), NOW);
  assert.equal(b.kind, 'none', 'ECCC live and complete with no BC alert is a proven absence');
});

test('mergeDirectWithSnapshot: complete replaces; partial unions without superseded, cancelled, or expired items', () => {
  const all = normalizeNwsCollection(topup.body, ctxOf(topup.meta)).alerts;
  const [a, b, c] = /** @type {any[]} */ (all);
  assert.deepEqual(mergeDirectWithSnapshot([a], [b, c], 'complete', NOW).map((x) => x.alertId), [a.alertId]);
  const superseding = { ...a, alertId: 'nws:new', references: [b.alertId] };
  const expired = { ...c, alertId: 'nws:old', expires: '2026-10-05T00:00:00Z', ends: null };
  const merged = mergeDirectWithSnapshot([superseding], [b, c, expired], 'partial', NOW).map((x) => x.alertId);
  assert.deepEqual(merged, ['nws:new', c.alertId]);
});

test('the pre-paint BC scope rule in service.js agrees with ecccInScope', () => {
  const nations = ['ca-fn-602', 'us-wa-lummi-tribe-of-the-lummi-reservation', 'us-ak-organized-village-of-kasaan'].map(fixtureNation);
  /** @type {any[]} */
  const scopes = [{ kind: 'footprint' }, { kind: 'footprint', jurisdictions: ['BC'] }, { kind: 'footprint', jurisdictions: ['WA', 'MARINE'] },
    ...nations.map((nation) => ({ kind: 'nation', nation }))];
  for (const scope of scopes) for (const page of /** @type {const} */ (['dashboard', 'alerts', 'safety'])) {
    assert.equal(bcInScope(scope, page), ecccInScope(scope, page), JSON.stringify({ kind: scope.kind, page }));
  }
});
