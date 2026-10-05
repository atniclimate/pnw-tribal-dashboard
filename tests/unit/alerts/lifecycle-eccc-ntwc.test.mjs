// @ts-check
/**
 * Lifecycle (blueprint 3.7.7), ECCC (3.7.4), and NTWC (3.7.2) behavior on dated captures.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { XMLParser } from 'fast-xml-parser';
import { normalizeNwsFeature, normalizeNwsCollection } from '../../../site/static/js/alerts/nws.js';
import { isExpired, resolveLifecycle } from '../../../site/static/js/alerts/lifecycle.js';
import { normalizeEcccCollection, ecccRequestParams, ecccInScope, ecccSkipGeometry, ecccNextPage, ecccWebUrl } from '../../../site/static/js/alerts/eccc.js';
import { languageBlockFor } from '../../../site/static/js/alerts/model.js';
import { assertSafeXml, normalizeNtwcFeed, NTWC_XML_OPTIONS, summaryText } from '../../../site/static/js/alerts/ntwc.js';
import { ctxOf, fixture, fixtureNation } from './helpers.mjs';

const chain = ['update-chain-ref-1', 'update-chain-ref-2', 'update-chain-current'].map((n) => {
  const f = fixture('nws-alerts-active', `${n}.json`);
  return normalizeNwsFeature(f.body, ctxOf(f.meta));
});
const at = new Date('2026-10-05T06:24:00Z');

test('an Update chain renders only its newest message, under the root event id', () => {
  const life = resolveLifecycle([...chain].reverse(), at);
  assert.deepEqual(life.current.map((a) => a.alertId), [chain[2]?.alertId]);
  assert.equal(life.superseded.length, 2);
  // The root is the earliest message referenced in the chain.
  assert.ok(life.current[0]?.eventId.startsWith('nws:urn:oid:'));
  assert.notEqual(life.current[0]?.eventId, chain[2]?.alertId);
});

test('two segments that reference the same earlier message both stay current', () => {
  const [a, b] = /** @type {any[]} */ (chain);
  const segment1 = { ...b, alertId: 'nws:segment-1', references: [a.alertId] };
  const segment2 = { ...b, alertId: 'nws:segment-2', references: [a.alertId] };
  const life = resolveLifecycle([a, segment1, segment2], at);
  assert.deepEqual(life.current.map((x) => x.alertId).sort(), ['nws:segment-1', 'nws:segment-2']);
  assert.deepEqual(life.superseded, [a.alertId]);
});

test('expiry uses the later of ends and expires', () => {
  const base = /** @type {any} */ ({ ...chain[2] });
  // This capture: ends 09:00 UTC, expires 14:00 UTC (the advisory resumes later in the same message).
  assert.equal(isExpired(base, new Date('2026-10-05T10:00:00Z')), false);
  assert.equal(isExpired(base, new Date('2026-10-05T14:00:00Z')), true);
  assert.equal(isExpired({ ...base, ends: '2026-10-07T00:00:00Z' }, new Date('2026-10-06T00:00:00Z')), false);
  assert.equal(isExpired({ ...base, ends: null, expires: null }, new Date('2030-01-01T00:00:00Z')), false);
  const life = resolveLifecycle([base], new Date('2026-10-05T15:00:00Z'));
  assert.deepEqual(life.expired, [base.alertId]);
});

test('a superseded, cancelled, or ended alert never renders', () => {
  const f = fixture('nws-alerts-active', 'topup-wa-or-id-pz.json');
  const alerts = normalizeNwsCollection(f.body, ctxOf(f.meta)).alerts;
  const ended = /** @type {any} */ ({ ...alerts[0], posture: 'ended' });
  const life = resolveLifecycle([ended, ...alerts.slice(1)], new Date(f.meta.capturedAt));
  assert.ok(!life.current.some((a) => a.alertId === ended.alertId));
});

const ecccFull = fixture('eccc-geomet-weather-alerts', 'canada-with-geometry.json');
const eccc = normalizeEcccCollection(ecccFull.body, ctxOf(ecccFull.meta));

test('ECCC: English and French kept verbatim under en-CA and fr-CA; ECCC is the translation authority', () => {
  assert.equal(eccc.alerts.length, 24);
  for (const a of eccc.alerts) {
    assert.deepEqual(Object.keys(a.sourceLanguage), ['en-CA', 'fr-CA']);
    assert.equal(a.translationAuthority, 'ECCC');
    const p = ecccFull.body.features.find((/** @type {any} */ f) => `eccc:${f.properties.id ?? f.id}` === a.alertId).properties;
    assert.equal(a.sourceLanguage['fr-CA']?.description, p.alert_text_fr.trim());
    assert.equal(a.sourceLanguage['en-CA']?.headline, p.alert_name_en.trim());
  }
});

test('ECCC French is never synthesized; lang=fr selects the source block', () => {
  const f = structuredClone(ecccFull.body.features[0]);
  f.properties.alert_name_fr = null;
  f.properties.alert_text_fr = null;
  const out = normalizeEcccCollection({ type: 'FeatureCollection', features: [f] }, ctxOf(ecccFull.meta));
  assert.deepEqual(Object.keys(out.alerts[0]?.sourceLanguage ?? {}), ['en-CA']);
  const en = languageBlockFor(/** @type {any} */ (out.alerts[0]).sourceLanguage, 'fr');
  assert.equal(en?.tag, 'en-CA');
  assert.equal(en?.requestedAvailable, false);
  const fr = languageBlockFor(/** @type {any} */ (eccc.alerts[0]).sourceLanguage, 'fr');
  assert.equal(fr?.tag, 'fr-CA');
  assert.equal(fr?.requestedAvailable, true);
  assert.equal(fr?.block.description, eccc.alerts[0]?.sourceLanguage['fr-CA']?.description);
  // A half language block is a malformed item, not a synthesized one.
  const half = structuredClone(ecccFull.body.features[0]);
  half.properties.alert_text_fr = null;
  const bad = normalizeEcccCollection({ type: 'FeatureCollection', features: [half] }, ctxOf(ecccFull.meta));
  assert.equal(bad.failures.length, 1);
});

test('ECCC: band from impact then colour; ended status leaves the active list; designation from alert_type', () => {
  const wind = eccc.alerts.find((a) => a.originalDesignation === 'wind warning');
  assert.equal(wind?.band, 'moderate');
  assert.equal(wind?.designation, 'warning');
  assert.equal(wind?.posture, 'act-now');
  const f = structuredClone(ecccFull.body.features[0]);
  f.properties.status_en = 'ended';
  const out = normalizeEcccCollection({ type: 'FeatureCollection', features: [f] }, ctxOf(ecccFull.meta));
  assert.equal(out.alerts[0]?.posture, 'ended');
  assert.equal(resolveLifecycle(out.alerts, new Date(ecccFull.meta.capturedAt)).current.length, 0);
});

test('ECCC truncated collection: every returned alert kept, truncated flagged, next link found', () => {
  const t = fixture('eccc-geomet-weather-alerts', 'canada-truncated-limit-5.json');
  const out = normalizeEcccCollection(t.body, ctxOf(t.meta));
  assert.equal(out.alerts.length, 5);
  assert.equal(out.diagnostics.truncated, true);
  assert.equal(out.diagnostics.numberMatched, 24);
  assert.match(ecccNextPage(t.body) ?? '', /^https:\/\/api\.weather\.gc\.ca\//);
});

test('ECCC skipGeometry responses normalize with null geometry; BC quiet capture is an honest empty set', () => {
  const s = fixture('eccc-geomet-weather-alerts', 'canada-skip-geometry.json');
  const out = normalizeEcccCollection(s.body, ctxOf(s.meta));
  assert.equal(out.alerts.length, 24);
  assert.ok(out.alerts.every((a) => a.geometry === null && a.provenance.coverage.geometryBasis === 'none'));
  const bc = fixture('eccc-geomet-weather-alerts', 'bc-province-filter.json');
  const quiet = normalizeEcccCollection(bc.body, ctxOf(bc.meta));
  assert.equal(quiet.alerts.length, 0);
  assert.equal(quiet.failures.length, 0);
  assert.equal(quiet.diagnostics.truncated, false);
});

test('ECCC request parameters, BC scope, and the 300 KB geometry rule', () => {
  const bcNation = fixtureNation('ca-fn-602');
  const usNation = fixtureNation('us-wa-lummi-tribe-of-the-lummi-reservation');
  assert.deepEqual(ecccRequestParams({ kind: 'footprint' }), { filter: 'properties.province=BC', limit: '500' });
  assert.equal(ecccRequestParams({ kind: 'nation', nation: bcNation }).bbox, bcNation.bbox.join(','));
  assert.equal(ecccRequestParams({ kind: 'footprint' }, { skipGeometry: true }).skipGeometry, 'true');
  assert.equal(ecccInScope({ kind: 'nation', nation: bcNation }, 'dashboard'), true);
  assert.equal(ecccInScope({ kind: 'nation', nation: usNation }, 'dashboard'), false);
  assert.equal(ecccInScope({ kind: 'footprint' }, 'dashboard'), false);
  assert.equal(ecccInScope({ kind: 'footprint', jurisdictions: ['BC'] }, 'dashboard'), true);
  assert.equal(ecccInScope({ kind: 'footprint' }, 'alerts'), true);
  assert.equal(ecccSkipGeometry(38), false);
  assert.equal(ecccSkipGeometry(39), true);
  assert.equal(ecccWebUrl('BC'), 'https://weather.gc.ca/index_e.html?alertTableFilterProv=BC#alerttable');
});

const ntwc = fixture('ntwc-atom', 'paaq-atom.xml');
const feed = new XMLParser({ ...NTWC_XML_OPTIONS }).parse(ntwc.text);

test('NTWC: an Information Statement is current for 24 hours after issue, then counted as not current', () => {
  const later = normalizeNtwcFeed(feed, ctxOf(ntwc.meta));
  assert.equal(later.alerts.length, 0);
  assert.equal(later.diagnostics.notCurrent, 1);
  const soon = normalizeNtwcFeed(feed, { fetchedAt: ntwc.meta.capturedAt, now: new Date('2026-09-29T22:09:56Z') });
  assert.equal(soon.alerts.length, 1);
  const a = /** @type {any} */ (soon.alerts[0]);
  assert.equal(a.event, 'Tsunami Information Statement');
  assert.equal(a.designation, 'statement');
  assert.equal(a.posture, 'monitor');
  assert.deepEqual(a.categories, ['tsunami']);
  assert.match(a.sourceLanguage['en-US'].description, /There is NO tsunami danger from this earthquake/);
  assert.ok(!/[<>]/.test(a.sourceLanguage['en-US'].description), 'summary is plain text');
  assert.match(a.webUrl, /^https:\/\/www\.tsunami\.gov\/events\//);
});

test('NTWC: a Warning entry stays current and acts now; DOCTYPE and ENTITY are rejected', () => {
  const warned = ntwc.text.replace('<strong>Category:</strong> Information', '<strong>Category:</strong> Warning');
  const out = normalizeNtwcFeed(new XMLParser({ ...NTWC_XML_OPTIONS }).parse(warned), ctxOf(ntwc.meta));
  assert.equal(out.alerts[0]?.event, 'Tsunami Warning');
  assert.equal(out.alerts[0]?.posture, 'act-now');
  assert.equal(out.alerts[0]?.band, 'extreme');
  assert.throws(() => assertSafeXml('<?xml version="1.0"?><!DOCTYPE x [<!ENTITY a "b">]><feed/>'));
  assert.equal(summaryText('A&amp;B<br/>C &lt;D&gt;'), 'A&B\nC <D>');
});
