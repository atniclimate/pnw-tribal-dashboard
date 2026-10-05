// @ts-check
/**
 * British Columbia provincial streams (blueprint 3.7.2, 3.8 provisional tables, Q8): BC River Forecast
 * Centre advisories, EMCR evacuation orders and alerts, and EMBC tsunami notifications.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeRfcAdvisories, ADVISORY_CODES, arcgisDate } from '../../../site/static/js/bc/rfc-advisories.js';
import { normalizeEvacuations } from '../../../site/static/js/bc/evacuations.js';
import { normalizeTsunamiNotifications, STATUS_CODES } from '../../../site/static/js/bc/tsunami.js';
import { fixture } from '../alerts/helpers.mjs';

test('RFC: the coded Advisory domain matches the layer metadata captured 10/05/2026', () => {
  const meta = fixture('bc-rfc-flood-advisories', 'layer-metadata.json').body;
  const field = meta.fields.find((/** @type {any} */ f) => f.name === 'Advisory');
  for (const { name, code } of field.domain.codedValues) assert.equal(ADVISORY_CODES[code], name);
});

test('RFC: every basin at No Advisory is counted, never listed; the empty active query is honest', () => {
  const all = fixture('bc-rfc-flood-advisories', 'all-basins-attributes.json');
  const out = normalizeRfcAdvisories(all.body, { fetchedAt: all.meta.capturedAt, ratified: false });
  assert.equal(out.items.length, 0);
  assert.equal(out.diagnostics.noAdvisory, 286);
  const active = fixture('bc-rfc-flood-advisories', 'active-advisories.json');
  const quiet = normalizeRfcAdvisories(active.body, { fetchedAt: active.meta.capturedAt, ratified: false });
  assert.deepEqual(quiet, { items: [], diagnostics: { itemsFailed: 0, noAdvisory: 0, exceededTransferLimit: 0 } });
});

test('RFC: a Flood Warning basin (minimal recorded edit of a captured basin) is act-now with band unstated until ratified', () => {
  const all = fixture('bc-rfc-flood-advisories', 'all-basins-attributes.json');
  const basin = structuredClone(all.body.features[0]);
  basin.properties.Advisory = 4;
  const edited = { type: 'FeatureCollection', features: [basin], exceededTransferLimit: true };
  const out = normalizeRfcAdvisories(edited, { fetchedAt: all.meta.capturedAt, ratified: false });
  assert.equal(out.items.length, 1);
  assert.equal(out.items[0]?.title, `Flood Warning: ${basin.properties.Major_Basin}`);
  assert.equal(out.items[0]?.band, 'unstated');
  assert.equal(out.items[0]?.posture, 'act-now');
  assert.equal(out.items[0]?.updatedAt, arcgisDate(basin.properties.Date_Modified));
  assert.equal(out.diagnostics.exceededTransferLimit, 1);
  assert.equal(normalizeRfcAdvisories(edited, { fetchedAt: all.meta.capturedAt, ratified: true }).items[0]?.band, 'severe');
});

test('EMCR: orders act now and alerts prepare; names and agencies kept as published', () => {
  const { body, meta } = fixture('bc-emcr-evacuations', 'all-orders-alerts.json');
  const out = normalizeEvacuations(body, { fetchedAt: meta.capturedAt, now: new Date(meta.capturedAt) });
  assert.equal(out.items.length, 16);
  assert.equal(out.items.filter((i) => i.kind === 'evacuation-order').length, 8);
  for (const i of out.items) {
    const src = body.features.find((/** @type {any} */ f) => `bc-emcr:${f.properties.EMRG_OAA_SYSID}` === i.id).properties;
    assert.equal(i.title, src.ORDER_ALERT_NAME);
    assert.equal(i.issuedBy, src.ISSUING_AGENCY);
    assert.equal(i.posture, src.ORDER_ALERT_STATUS === 'Order' ? 'act-now' : 'prepare');
    assert.equal(i.band, 'unstated');
    assert.ok(i.geometry && i.geometry.type === 'Polygon');
  }
  const rescinded = structuredClone(body.features[0]);
  rescinded.properties.ORDER_ALERT_STATUS = 'Rescinded';
  assert.equal(normalizeEvacuations({ type: 'FeatureCollection', features: [rescinded] }, { fetchedAt: meta.capturedAt, now: new Date() }).diagnostics.notActive, 1);
});

test('EMBC tsunami: STATUS codes match the layer metadata; No Notification zones are not listed', () => {
  const meta = fixture('bc-embc-tsunami', 'layer-metadata.json').body;
  const field = meta.fields.find((/** @type {any} */ f) => f.name === 'STATUS');
  for (const { name, code } of field.domain.codedValues) assert.equal(STATUS_CODES[code], name);
  const { body, meta: m } = fixture('bc-embc-tsunami', 'all-zones-attributes.json');
  const out = normalizeTsunamiNotifications(body, { fetchedAt: m.capturedAt });
  assert.equal(out.items.length, 0);
  assert.equal(out.diagnostics.noNotification, 5);
  const warned = structuredClone(body);
  warned.features[0].attributes.STATUS = '1';
  const w = normalizeTsunamiNotifications(warned, { fetchedAt: m.capturedAt });
  assert.equal(w.items[0]?.title, 'Tsunami Warning: Tsunami Zone A');
  assert.equal(w.items[0]?.posture, 'act-now');
  assert.equal(w.items[0]?.geometry, null);
});
