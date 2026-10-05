// @ts-check
/**
 * CAST parity for the NWS and ECCC normalizers (blueprint 10.1) on CAST's own fixtures
 * (tests/fixtures/cast/ingest-nws and ingest-eccc). Each assertion is a CAST test expectation from
 * ingest-nws/src/index.test.ts or ingest-eccc/src/index.test.ts; where the dashboard deliberately differs
 * (ADR 0007: keep every valid item instead of rejecting the batch), the test states CAST's outcome and
 * the dashboard's side by side.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { normalizeNwsCollection } from '../../site/static/js/alerts/nws.js';
import { normalizeEcccCollection } from '../../site/static/js/alerts/eccc.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
/** @param {string} pkg @param {string} rel @returns {any} */
const load = (pkg, rel) => JSON.parse(readFileSync(path.join(ROOT, 'tests', 'fixtures', 'cast', pkg, 'fixtures', rel), 'utf8'));
const CTX = { fetchedAt: '2026-07-17T18:10:00Z', now: new Date('2026-07-17T18:10:00Z') };
/** @param {any} f */
const coll = (f) => (f.type === 'Feature' ? { type: 'FeatureCollection', features: [f] } : f);
const polygonRaw = load('ingest-nws', 'live/alert-flood-warning-polygon-LAC019.json');
const zoneRaw = load('ingest-nws', 'live/alert-red-flag-warning-zone-ORZ691.json');

test('NWS: polygon coverage versus zone-only coverage (CAST)', () => {
  const polygon = normalizeNwsCollection(coll(polygonRaw), CTX).alerts[0];
  const zone = normalizeNwsCollection(coll(zoneRaw), CTX).alerts[0];
  assert.equal(polygon?.geometry?.type, 'Polygon');
  assert.equal(polygon?.provenance.coverage.geometryBasis, 'polygon');
  assert.ok(polygon?.provenance.coverage.geocodes.includes('LAC019'));
  assert.equal(zone?.geometry, null);
  assert.equal(zone?.provenance.coverage.geometryBasis, 'zone');
  assert.ok(zone?.provenance.coverage.geocodes.includes('ORZ691'));
  assert.ok(zone?.provenance.coverage.geocodes.includes('041021'));
});

test('NWS: a malformed item is isolated (CAST rejects the batch; the dashboard keeps the valid sibling and counts the failure)', () => {
  const malformed = load('ingest-nws', 'synthetic/malformed-feature.json').features[0];
  const out = normalizeNwsCollection({ type: 'FeatureCollection', features: [zoneRaw, malformed] }, CTX);
  assert.equal(out.alerts.length, 1);
  assert.equal(out.alerts[0]?.originalDesignation, 'Red Flag Warning');
  assert.equal(out.failures.length, 1);
  assert.equal(out.failures[0]?.id, 'synthetic-malformed');
  assert.equal(out.diagnostics.itemsFailed, 1);
});

test('NWS: an item with neither polygon nor geocodes is a failure, never an alert (CAST missing-coverage)', () => {
  const out = normalizeNwsCollection(coll(load('ingest-nws', 'synthetic/missing-coverage.json')), CTX);
  assert.equal(out.alerts.length, 0);
  assert.match(out.failures[0]?.reason ?? '', /missing-nws-coverage/);
});

test('NWS: Test and Exercise messages are countable exclusions, never failures (CAST)', () => {
  const testMessage = load('ingest-nws', 'synthetic/test-message.json').features[0];
  const out = normalizeNwsCollection({ type: 'FeatureCollection', features: [testMessage, zoneRaw] }, CTX);
  assert.equal(out.alerts.length, 1);
  assert.equal(out.failures.length, 0);
  assert.equal(out.diagnostics.testOrExerciseExcluded, 1);
  const exercise = structuredClone(testMessage);
  exercise.properties.status = 'Exercise';
  assert.equal(normalizeNwsCollection({ type: 'FeatureCollection', features: [exercise] }, CTX).diagnostics.testOrExerciseExcluded, 1);
  const actual = structuredClone(zoneRaw);
  actual.properties.status = 'Actual';
  const a = normalizeNwsCollection({ type: 'FeatureCollection', features: [actual] }, CTX);
  assert.equal(a.alerts.length, 1);
  assert.equal(a.diagnostics.testOrExerciseExcluded, 0);
});

test('NWS: a paginated collection is flagged (CAST rejects; the dashboard keeps items and reports truncated)', () => {
  const out = normalizeNwsCollection({ type: 'FeatureCollection', features: [zoneRaw], pagination: { next: 'https://api.weather.gov/alerts/active?cursor=synthetic' } }, CTX);
  assert.equal(out.diagnostics.truncated, true);
  assert.equal(out.alerts.length, 1);
  assert.equal(normalizeNwsCollection({ type: 'FeatureCollection', features: [zoneRaw], pagination: {} }, CTX).diagnostics.truncated, false);
});

test('NWS: complete provenance, the CAST mapping stamp, VTEC, references, timestamps, and text (CAST)', () => {
  const alerts = normalizeNwsCollection({ type: 'FeatureCollection', features: [polygonRaw, zoneRaw, load('ingest-nws', 'synthetic/cancel.json').features[0]] }, CTX).alerts;
  assert.equal(alerts.length, 3);
  for (const a of alerts) {
    assert.equal(a.sourceId, 'nws-alerts-active');
    assert.deepEqual(a.provenance.mappingApplied, { name: 'atni-cast-nws-cap', version: '1.0.0' });
    assert.equal(a.provenance.fetchedAt, CTX.fetchedAt);
    assert.equal(a.alertId, `nws:${a.provenance.originalId}`);
  }
  const p = /** @type {any} */ (alerts[0]);
  assert.equal(p.originalDesignation, 'Flood Warning');
  assert.deepEqual(p.parameters?.VTEC, ['/O.EXT.KLCH.FL.W.0034.000000T0000Z-260722T0600Z/']);
  assert.deepEqual(p.references, [
    'nws:urn:oid:2.49.0.1.840.0.68d4016ff85029b1d21ce6630bb0208931dc1592.001.1',
    'nws:urn:oid:2.49.0.1.840.0.3752dff805703714b4e03889cc4183a849a365f4.001.1',
  ]);
  assert.equal(p.sent, '2026-07-17T11:02:00-05:00');
  assert.equal(p.effective, '2026-07-17T11:02:00-05:00');
  assert.equal(p.onset, '2026-07-17T11:02:00-05:00');
  assert.equal(p.expires, '2026-07-18T11:15:00-05:00');
  assert.equal(typeof p.sourceLanguage['en-US'].headline, 'string');
  const cancel = /** @type {any} */ (alerts[2]);
  assert.equal(cancel.messageType, 'cancel');
  assert.equal(cancel.posture, 'ended');
  assert.equal(cancel.geometry, null);
  assert.deepEqual(cancel.references, ['nws:synthetic-original']);
});

test('NWS: two decodes of the same bytes are identical (CAST determinism)', () => {
  const a = normalizeNwsCollection(coll(structuredClone(polygonRaw)), CTX);
  const b = normalizeNwsCollection(coll(structuredClone(polygonRaw)), CTX);
  assert.equal(JSON.stringify(a), JSON.stringify(b));
});

test('ECCC: both live language blocks, polygon geometry, province coverage; truncated page flagged (CAST)', () => {
  const out = normalizeEcccCollection(load('ingest-eccc', 'live/weather-alerts-items-limit10.json'), CTX);
  assert.equal(out.alerts.length, 10);
  assert.equal(out.diagnostics.truncated, true);
  const a = /** @type {any} */ (out.alerts[0]);
  assert.deepEqual(Object.keys(a.sourceLanguage), ['en-CA', 'fr-CA']);
  assert.match(a.sourceLanguage['en-CA'].description, /Conditions are favourable/);
  assert.match(a.sourceLanguage['fr-CA'].description, /Les conditions sont propices/);
  assert.equal(a.translationAuthority, 'ECCC');
  assert.equal(a.geometry.type, 'Polygon');
  assert.deepEqual(a.provenance.coverage, { geometryBasis: 'polygon', geocodes: ['province:BC'] });
});

test('ECCC: no synthesized language; impact over colour over CAP severity; no band from a title (CAST)', () => {
  const out = normalizeEcccCollection(load('ingest-eccc', 'synthetic/impact-precedence.json'), CTX);
  assert.deepEqual(Object.keys(out.alerts[1]?.sourceLanguage ?? {}), ['en-CA']);
  assert.deepEqual(Object.keys(out.alerts[2]?.sourceLanguage ?? {}), ['fr-CA']);
  assert.deepEqual(out.alerts.map(({ band }) => band), ['minor', 'severe', 'moderate']);
  assert.equal(out.alerts[0]?.originalDesignation, 'Catastrophic Red Emergency Warning');
  assert.equal(out.alerts[0]?.band, 'minor');
});

test('ECCC: an ended statement maps to ended posture (CAST)', () => {
  const a = normalizeEcccCollection(load('ingest-eccc', 'synthetic/ended-statement.json'), CTX).alerts[0];
  assert.equal(a?.band, 'minor');
  assert.equal(a?.posture, 'ended');
});

test('ECCC: a malformed item is isolated; the valid neighbour is kept (CAST)', () => {
  const out = normalizeEcccCollection(load('ingest-eccc', 'synthetic/malformed-feature.json'), CTX);
  assert.deepEqual(out.alerts.map(({ alertId }) => alertId), ['eccc:synthetic-valid-neighbour']);
  assert.equal(out.failures.length, 1);
  assert.match(out.failures[0]?.reason ?? '', /eccc-geomet-invalid-feature/);
});
