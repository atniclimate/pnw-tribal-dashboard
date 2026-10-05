// @ts-check
/**
 * Golden outputs for every dated capture the alert engine reads (blueprint 12.3, L3 acceptance "golden
 * tests for every fixture"). Each normalizer runs on its capture at the capture instant; the output must
 * equal tests/fixtures/alerts/expected/<name>.json. See helpers.mjs for regeneration.
 */
import { test } from 'node:test';
import { XMLParser } from 'fast-xml-parser';
import { normalizeNwsCollection } from '../../../site/static/js/alerts/nws.js';
import { normalizeEcccCollection } from '../../../site/static/js/alerts/eccc.js';
import { NTWC_XML_OPTIONS, normalizeNtwcFeed } from '../../../site/static/js/alerts/ntwc.js';
import { resolveLifecycle } from '../../../site/static/js/alerts/lifecycle.js';
import { zoneGeometryFromResponse } from '../../../site/static/js/alerts/zones.js';
import { normalizeRfcAdvisories } from '../../../site/static/js/bc/rfc-advisories.js';
import { normalizeEvacuations } from '../../../site/static/js/bc/evacuations.js';
import { normalizeTsunamiNotifications } from '../../../site/static/js/bc/tsunami.js';
import { assertGolden, ctxOf, fixture, goldenAlerts, sha256 } from './helpers.mjs';

/** @param {any} body @returns {any} a single Feature wrapped as a collection */
const asCollection = (body) => (body.type === 'Feature' ? { type: 'FeatureCollection', features: [body] } : body);

const NWS = [
  'footprint-active', 'topup-wa-or-id-pz', 'topup-one-malformed-item', 'test-messages', 'cancel-collection-page-1',
  'cancel-collection-page-2', 'fire-zone-red-flag-warning', 'public-zone-code-shared-with-fire-zone', 'update-chain-current',
  'update-chain-ref-1', 'update-chain-ref-2', 'zone-param-20-ca-county-codes', 'zone-param-well-formed-unknown-code',
];
for (const name of NWS) {
  test(`golden: nws-alerts-active/${name}`, () => {
    const { body, meta } = fixture('nws-alerts-active', `${name}.json`);
    const out = normalizeNwsCollection(asCollection(body), ctxOf(meta));
    const life = resolveLifecycle(out.alerts, new Date(meta.capturedAt));
    assertGolden(`nws-${name}.json`, {
      capture: meta.file,
      diagnostics: out.diagnostics,
      failures: out.failures,
      current: life.current.map((a) => a.alertId),
      superseded: life.superseded,
      cancelled: life.cancelled,
      expired: life.expired,
      alerts: goldenAlerts(out.alerts),
    });
  });
}

const ECCC = ['bc-province-filter', 'canada-with-geometry', 'canada-skip-geometry', 'canada-truncated-limit-5'];
for (const name of ECCC) {
  test(`golden: eccc-geomet-weather-alerts/${name}`, () => {
    const { body, meta } = fixture('eccc-geomet-weather-alerts', `${name}.json`);
    const out = normalizeEcccCollection(body, ctxOf(meta));
    assertGolden(`eccc-${name}.json`, {
      capture: meta.file,
      diagnostics: out.diagnostics,
      failures: out.failures,
      alerts: goldenAlerts(out.alerts),
    });
  });
}

test('golden: ntwc-atom/paaq-atom (at capture, and one hour after issuance)', () => {
  const { text, meta } = fixture('ntwc-atom', 'paaq-atom.xml');
  const feed = new XMLParser({ ...NTWC_XML_OPTIONS }).parse(text);
  const atCapture = normalizeNtwcFeed(feed, ctxOf(meta));
  const atIssue = normalizeNtwcFeed(feed, { fetchedAt: meta.capturedAt, now: new Date('2026-09-29T22:09:56Z') });
  assertGolden('ntwc-paaq-atom.json', {
    capture: meta.file,
    atCapture: { diagnostics: atCapture.diagnostics, alerts: goldenAlerts(atCapture.alerts) },
    oneHourAfterIssue: { diagnostics: atIssue.diagnostics, alerts: goldenAlerts(atIssue.alerts) },
  });
});

test('golden: bc-rfc-flood-advisories (active query and all basins)', () => {
  const active = fixture('bc-rfc-flood-advisories', 'active-advisories.json');
  const all = fixture('bc-rfc-flood-advisories', 'all-basins-attributes.json');
  assertGolden('bc-rfc-flood-advisories.json', {
    active: normalizeRfcAdvisories(active.body, { fetchedAt: active.meta.capturedAt, ratified: false }),
    allBasins: normalizeRfcAdvisories(all.body, { fetchedAt: all.meta.capturedAt, ratified: false }),
  });
});

test('golden: bc-emcr-evacuations/all-orders-alerts', () => {
  const { body, meta } = fixture('bc-emcr-evacuations', 'all-orders-alerts.json');
  const out = normalizeEvacuations(body, ctxOf(meta));
  assertGolden('bc-emcr-evacuations.json', {
    diagnostics: out.diagnostics,
    items: out.items.map((i) => ({ ...i, geometry: i.geometry ? { type: i.geometry.type, sha256: sha256(i.geometry) } : null })),
  });
});

test('golden: bc-embc-tsunami/all-zones-attributes', () => {
  const { body, meta } = fixture('bc-embc-tsunami', 'all-zones-attributes.json');
  assertGolden('bc-embc-tsunami.json', normalizeTsunamiNotifications(body, { fetchedAt: meta.capturedAt }));
});

test('golden: nws-zones-api geometry extraction keeps fire and public CAZ503 distinct', () => {
  /** @type {Record<string, unknown>} */
  const out = {};
  for (const name of ['fire-caz503', 'forecast-caz503', 'fire-mtz123']) {
    const { body } = fixture('nws-zones-api', `${name}.json`);
    const g = zoneGeometryFromResponse(body);
    out[name] = g ? { type: g.type, sha256: sha256(g) } : null;
  }
  assertGolden('nws-zones-api.json', out);
});
