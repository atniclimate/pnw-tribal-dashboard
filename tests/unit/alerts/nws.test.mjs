// @ts-check
/**
 * NWS normalizer and request plan (blueprint 3.7.3, 3.7.5, 3.7.7): regressions for every legacy alert
 * defect named in the L3 contract, on dated captures.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeNwsCollection, normalizeNwsFeature, nwsRequestPlan, nwsWebUrl, NWS_ZONE_CHUNK, NWS_ZONE_PARAM } from '../../../site/static/js/alerts/nws.js';
import { resolveLifecycle } from '../../../site/static/js/alerts/lifecycle.js';
import { ctxOf, fixture, fixtureNation } from './helpers.mjs';

const footprint = fixture('nws-alerts-active', 'footprint-active.json');
const fp = normalizeNwsCollection(footprint.body, ctxOf(footprint.meta));

test('the footprint capture normalizes every item with no failures', () => {
  assert.equal(fp.alerts.length, 180);
  assert.equal(fp.failures.length, 0);
  assert.equal(fp.diagnostics.truncated, false);
});

test('Update messages are kept (the legacy query dropped them)', () => {
  const { body, meta } = fixture('nws-alerts-active', 'update-chain-current.json');
  const a = normalizeNwsFeature(body, ctxOf(meta));
  assert.equal(a.messageType, 'update');
  assert.equal(a.lifecycleState, 'active');
  assert.equal(a.references.length, 2);
  assert.ok(a.references.every((r) => r.startsWith('nws:urn:oid:')));
  const updates = fp.alerts.filter((x) => x.messageType === 'update');
  assert.ok(updates.length > 0, 'the footprint capture contains Update messages');
  assert.equal(resolveLifecycle(fp.alerts, new Date(footprint.meta.capturedAt)).current.length, 180);
});

test('Cancel messages resolve: a Cancel is never shown and cancels the alert it references', () => {
  const { body, meta } = fixture('nws-alerts-active', 'cancel-collection-page-1.json');
  const out = normalizeNwsCollection(body, ctxOf(meta));
  assert.equal(out.alerts.length, 10);
  assert.ok(out.alerts.every((a) => a.messageType === 'cancel' && a.posture === 'ended'));
  const life = resolveLifecycle(out.alerts, new Date(meta.capturedAt));
  assert.equal(life.current.length, 0);
  assert.equal(life.cancelled.length, 10);
  // A Cancel in the same batch as the message it references removes that message too.
  const target = { ...fp.alerts[0], alertId: out.alerts[0]?.references[0] ?? 'x', references: [] };
  const both = resolveLifecycle([target, .../** @type {any[]} */ (out.alerts)], new Date(meta.capturedAt));
  assert.ok(both.cancelled.includes(target.alertId));
  assert.ok(!both.current.some((a) => a.alertId === target.alertId));
});

test('Test and Exercise messages are excluded and counted, never failures', () => {
  const { body, meta } = fixture('nws-alerts-active', 'test-messages.json');
  const out = normalizeNwsCollection(body, ctxOf(meta));
  assert.equal(out.alerts.length, 0);
  assert.equal(out.failures.length, 0);
  assert.equal(out.diagnostics.testOrExerciseExcluded, 5);
  const exercise = { type: 'FeatureCollection', features: [{ ...body.features[0], properties: { ...body.features[0].properties, status: 'Exercise' } }] };
  assert.equal(normalizeNwsCollection(exercise, ctxOf(meta)).diagnostics.testOrExerciseExcluded, 1);
});

test('marine alerts are included with typed marine keys and the MARINE jurisdiction', () => {
  const marine = fp.alerts.filter((a) => a.marine);
  assert.ok(marine.length >= 149, 'every Small Craft Advisory and Gale Warning is kept');
  for (const a of marine.filter((x) => x.zones.some((z) => z.startsWith('marine:')))) {
    assert.ok(a.jurisdictions.includes('MARINE'));
    assert.ok(a.zones.every((z) => z.startsWith('marine:')));
  }
  const gale = fp.alerts.find((a) => a.event === 'Gale Warning');
  assert.deepEqual(gale?.categories, ['marine', 'wind']);
});

test('watches, advisories, and statements are counted, not dropped', () => {
  const designations = new Set(fp.alerts.map((a) => a.designation));
  for (const d of ['warning', 'watch', 'advisory', 'statement']) assert.ok(designations.has(/** @type {any} */ (d)), d);
  const watch = fp.alerts.find((a) => a.event === 'Extreme Heat Watch');
  assert.equal(watch?.posture, 'prepare');
});

test('zone alerts resolve by typed keys from affectedZones', () => {
  const { body, meta } = fixture('nws-alerts-active', 'fire-zone-red-flag-warning.json');
  const a = normalizeNwsFeature(body, ctxOf(meta));
  assert.deepEqual(a.zones, ['fire:MTZ123', 'fire:MTZ124']);
  assert.equal(a.provenance.coverage.geometryBasis, 'zone');
  assert.equal(a.geometry, null);
  assert.deepEqual(a.jurisdictions, ['MT-W']);
});

test('fire and public zones with the same code stay distinct', () => {
  const { body, meta } = fixture('nws-alerts-active', 'public-zone-code-shared-with-fire-zone.json');
  const a = normalizeNwsFeature(body, ctxOf(meta));
  assert.ok(a.zones.includes('forecast:CAZ503'));
  assert.ok(!a.zones.includes(/** @type {any} */ ('fire:CAZ503')));
  // A Nation whose fire zone is CAZ503 is not matched by the public-zone alert, and the reverse.
  assert.equal(a.zones.filter((z) => z === 'fire:CAZ503').length, 0);
});

test('jurisdiction comes from the UGC prefix, never from areaDesc ("WATERS" is not WA, "North" is not OR)', () => {
  const watersCa = fp.alerts.filter((a) => /waters/i.test(a.areaDesc ?? '') && a.zones.every((z) => /^marine:PZZ[3-5]/.test(z)));
  assert.ok(watersCa.length > 0, 'the capture has California coastal-water alerts whose area text says Waters');
  for (const a of watersCa) assert.ok(!a.jurisdictions.includes('WA'), a.areaDesc);
  const north = fp.alerts.filter((a) => /\bnorth/i.test(a.areaDesc ?? '') && a.zones.every((z) => !z.includes(':OR')));
  assert.ok(north.length > 0);
  for (const a of north) assert.ok(!a.jurisdictions.includes('OR'), a.areaDesc);
  // Changing areaDesc never changes jurisdictions.
  const raw = footprint.body.features[0];
  const edited = { ...raw, properties: { ...raw.properties, areaDesc: 'WATERS NORTH OF OREGON, WASHINGTON' } };
  const b = normalizeNwsFeature(edited, ctxOf(footprint.meta));
  assert.deepEqual(b.jurisdictions, normalizeNwsFeature(raw, ctxOf(footprint.meta)).jurisdictions);
});

test('a malformed item fails alone: every valid alert is kept and the failure is counted', () => {
  const { body, meta } = fixture('nws-alerts-active', 'topup-one-malformed-item.json');
  const out = normalizeNwsCollection(body, ctxOf(meta));
  assert.equal(out.alerts.length, body.features.length - 1);
  assert.equal(out.diagnostics.itemsFailed, 1);
  assert.match(out.failures[0]?.reason ?? '', /properties\.event/);
  assert.ok(out.failures[0]?.id?.startsWith('urn:oid:'));
});

test('a collection with pagination.next is reported truncated, with every item kept', () => {
  const { body, meta } = fixture('nws-alerts-active', 'cancel-collection-page-1.json');
  const out = normalizeNwsCollection(body, ctxOf(meta));
  assert.equal(out.diagnostics.truncated, true);
  assert.equal(out.alerts.length, body.features.length);
});

test('a payload that is not a FeatureCollection is one failure and no alerts', () => {
  const out = normalizeNwsCollection({ type: 'Feature' }, { fetchedAt: '2026-10-05T00:00:00Z', now: new Date() });
  assert.equal(out.alerts.length, 0);
  assert.equal(out.failures.length, 1);
});

test('webUrl is the product page from AWIPS and VTEC, never alerts.weather.gov', () => {
  for (const a of fp.alerts) {
    assert.ok(a.webUrl === null || a.webUrl.startsWith('https://forecast.weather.gov/product.php?') || a.webUrl.startsWith('https://www.weather.gov/'));
    assert.ok(!(a.webUrl ?? '').includes('alerts.weather.gov'));
  }
  assert.equal(nwsWebUrl({ parameters: { AWIPSidentifier: ['MWWSEW'], VTEC: ['/O.CON.KSEW.SC.Y.0123.000000T0000Z-261005T1200Z/'] } }),
    'https://forecast.weather.gov/product.php?site=SEW&issuedby=SEW&product=MWW');
  assert.equal(nwsWebUrl({ parameters: { AWIPSidentifier: ['NPWAER'] } }), 'https://forecast.weather.gov/product.php?site=NWS&issuedby=AER&product=NPW');
  assert.equal(nwsWebUrl({ parameters: { VTEC: ['/O.NEW.PAFC.FG.Y.0014.261005T0603Z-261005T1800Z/'] } }), 'https://www.weather.gov/afc/');
  assert.equal(nwsWebUrl({}), null);
});

test('request plan, footprint scope: area=WA,OR,ID,PZ then zone= chunks of 50, malformed codes dropped', () => {
  const edge = Array.from({ length: 120 }, (_, i) => `CAZ${String(100 + i).padStart(3, '0')}`);
  const plan = nwsRequestPlan({ kind: 'footprint' }, { edgeCodes: [...edge, 'XXZ001', 'waz558', 'CAZ100'] });
  assert.deepEqual(plan[0], { sourceId: 'nws-alerts-active', params: { area: 'WA,OR,ID,PZ', status: 'actual' } });
  assert.equal(plan.length, 1 + Math.ceil(120 / NWS_ZONE_CHUNK));
  const codes = plan.slice(1).flatMap((p) => (p.params.zone ?? '').split(','));
  assert.equal(codes.length, 120);
  assert.ok(codes.every((c) => NWS_ZONE_PARAM.test(c)));
  assert.ok(plan.every((p) => !('message_type' in p.params) && p.params.status === 'actual'));
});

test('request plan, Nation scope: one zone= list of the Nation\'s zones (bare codes; results are post-filtered)', () => {
  const lummi = fixtureNation('us-wa-lummi-tribe-of-the-lummi-reservation');
  const plan = nwsRequestPlan({ kind: 'nation', nation: lummi }, { edgeCodes: [] });
  assert.equal(plan.length, 1);
  const zones = (plan[0]?.params.zone ?? '').split(',');
  const nws = /** @type {NonNullable<typeof lummi.nws>} */ (lummi.nws);
  const expected = [...new Set([...nws.forecastZones, ...nws.countyZones, ...nws.fireZones, ...nws.marineZones].map((k) => k.split(':')[1]))];
  assert.deepEqual(zones.sort(), expected.sort());
  const bc = fixtureNation('ca-fn-602');
  assert.deepEqual(nwsRequestPlan({ kind: 'nation', nation: bc }, { edgeCodes: [] }), []);
});

test('NWS_ZONE_PARAM matches the pattern api.weather.gov enforced on 10/05/2026', () => {
  for (const ok of ['WAZ558', 'WAC033', 'PKZ022', 'PZZ135', 'CAC001', 'AKZ318']) assert.ok(NWS_ZONE_PARAM.test(ok), ok);
  for (const bad of ['XXZ001', 'waz558', 'WAX001', 'WAZ12']) assert.ok(!NWS_ZONE_PARAM.test(bad), bad);
});

test('the zone= captures normalize; county codes return alerts naming only forecast zones (post-filter required)', () => {
  const { body, meta } = fixture('nws-alerts-active', 'zone-param-20-ca-county-codes.json');
  const out = normalizeNwsCollection(body, ctxOf(meta));
  assert.ok(out.alerts.length > 0);
  assert.ok(out.alerts.every((a) => a.zones.every((z) => !z.startsWith('county:'))));
  const unknown = fixture('nws-alerts-active', 'zone-param-well-formed-unknown-code.json');
  assert.equal(normalizeNwsCollection(unknown.body, ctxOf(unknown.meta)).failures.length, 0);
});
