// @ts-check
/**
 * Model helpers, mapping tables, designation, and hazard categories (blueprint 3.7.1, 3.8, 3.9).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { XMLParser } from 'fast-xml-parser';
import { createAlertId, compareSeverityBands, highestSeverityBand, typedZoneKey, sortAlerts, toIndexEntry, joinAlert } from '../../../site/static/js/alerts/model.js';
import { MAPPING_TABLES, mapNwsDimensions, mapEcccDimensions, mapBcRfc, mapEmcr, mapNtwc } from '../../../site/static/js/alerts/mapping.js';
import { designationOf, designationShape } from '../../../site/static/js/alerts/designation.js';
import { ALLOWED_OTHER, categorize, categorizeByRules, normalizeName, tableFromReference, withTextCategories } from '../../../site/static/js/alerts/categories.js';
import { normalizeNwsCollection } from '../../../site/static/js/alerts/nws.js';
import { normalizeEcccCollection } from '../../../site/static/js/alerts/eccc.js';
import { NTWC_XML_OPTIONS, normalizeNtwcFeed } from '../../../site/static/js/alerts/ntwc.js';
import { buildHazardReference } from '../../../scripts/reference/80-hazards.mjs';
import { ROOT, ctxOf, fixture } from './helpers.mjs';

test('createAlertId namespaces and rejects empty parts (CAST)', () => {
  assert.equal(createAlertId('nws', 'urn:oid:1'), 'nws:urn:oid:1');
  assert.throws(() => createAlertId(' ', 'x'));
  assert.throws(() => createAlertId('nws', ''));
});

test('unstated is never ranked; highest band ignores unstated (CAST)', () => {
  assert.equal(compareSeverityBands('unstated', 'minor'), null);
  assert.ok(/** @type {number} */ (compareSeverityBands('severe', 'moderate')) > 0);
  assert.equal(highestSeverityBand(['unstated', 'minor', 'severe']), 'severe');
  assert.equal(highestSeverityBand(['unstated', 'unstated']), 'unstated');
});

test('typedZoneKey reads the type from the URL path; PZZ and PKZ are marine', () => {
  assert.equal(typedZoneKey('https://api.weather.gov/zones/forecast/WAZ558'), 'forecast:WAZ558');
  assert.equal(typedZoneKey('https://api.weather.gov/zones/county/WAC033'), 'county:WAC033');
  assert.equal(typedZoneKey('https://api.weather.gov/zones/fire/WAZ658'), 'fire:WAZ658');
  assert.equal(typedZoneKey('https://api.weather.gov/zones/forecast/PZZ135'), 'marine:PZZ135');
  assert.equal(typedZoneKey('https://api.weather.gov/zones/forecast/PKZ671'), 'marine:PKZ671');
  assert.equal(typedZoneKey('https://api.weather.gov/zones/county/WAZ033'), null);
  assert.equal(typedZoneKey('not a url'), null);
});

test('sort: posture, then band (unstated last), then onset or effective, then expiry; NTWC pinned', () => {
  const base = { agency: 'nws', effective: '2026-10-05T00:00:00Z', expires: null };
  const mk = (/** @type {string} */ id, /** @type {any} */ o) => /** @type {any} */ ({ ...base, alertId: id, ...o });
  const sorted = sortAlerts([
    mk('a', { posture: 'monitor', band: 'extreme' }),
    mk('b', { posture: 'act-now', band: 'unstated' }),
    mk('c', { posture: 'act-now', band: 'minor' }),
    mk('d', { posture: 'prepare', band: 'severe' }),
    mk('e', { posture: 'act-now', band: 'minor', onset: '2026-10-04T00:00:00Z' }),
    mk('f', { posture: 'monitor', band: 'unstated', agency: 'ntwc' }),
  ]);
  assert.deepEqual(sorted.map((a) => a.alertId), ['f', 'e', 'c', 'b', 'd', 'a']);
});

test('the snapshot split drops text and geometry and joins back losslessly', () => {
  const { body, meta } = fixture('nws-alerts-active', 'topup-wa-or-id-pz.json');
  const [a] = normalizeNwsCollection(body, ctxOf(meta)).alerts;
  assert.ok(a);
  const entry = toIndexEntry(a);
  assert.ok(!('sourceLanguage' in entry) && !('geometry' in entry));
  assert.deepEqual(joinAlert(entry, a.sourceLanguage, a.geometry), a);
  assert.deepEqual(joinAlert(entry, null, null).sourceLanguage, {});
});

test('NWS mapping atni-cast-nws-cap 1.0.0: severity to band, suffix then urgency to posture, certainty to confidence', () => {
  assert.deepEqual(mapNwsDimensions({ severity: 'Severe', urgency: 'Expected', certainty: 'Likely', event: 'Flood Warning' }),
    { band: 'severe', posture: 'act-now', confidence: 'likely' });
  assert.equal(mapNwsDimensions({ event: 'Flood Watch', urgency: 'Immediate' }).posture, 'prepare');
  assert.equal(mapNwsDimensions({ event: 'Small Craft Advisory', urgency: 'Immediate' }).posture, 'monitor');
  assert.equal(mapNwsDimensions({ event: 'Air Quality Alert', urgency: 'Immediate' }).posture, 'act-now');
  assert.equal(mapNwsDimensions({ event: 'Flood Warning', ended: true }).posture, 'ended');
  assert.equal(mapNwsDimensions({ event: 'Catastrophic Flood Warning' }).band, 'unstated');
  assert.equal(mapNwsDimensions({ certainty: 'Unlikely' }).confidence, 'unknown');
  assert.equal(mapNwsDimensions({ severity: 'constructor' }).band, 'unstated');
});

test('ECCC mapping atni-cast-eccc-cap 1.0.0: MSC_Impact, then colour, then CAP severity; French values', () => {
  assert.equal(mapEcccDimensions({ mscImpact: 'High', colour: 'Yellow', severity: 'Minor' }).band, 'severe');
  assert.equal(mapEcccDimensions({ colour: 'Orange', severity: 'Minor' }).band, 'severe');
  assert.equal(mapEcccDimensions({ severity: 'Moderate' }).band, 'moderate');
  assert.equal(mapEcccDimensions({ mscImpact: 'modéré', colour: 'jaune' }).band, 'moderate');
  assert.equal(mapEcccDimensions({ colour: 'Red' }).band, 'extreme');
});

test('provisional BC and NTWC tables: band unstated until ratified; posture follows designation', () => {
  assert.deepEqual(mapBcRfc('Flood Warning', { ratified: false }), { band: 'unstated', posture: 'act-now' });
  assert.deepEqual(mapBcRfc('Flood Warning', { ratified: true }), { band: 'severe', posture: 'act-now' });
  assert.deepEqual(mapBcRfc('Flood Watch', { ratified: true }), { band: 'moderate', posture: 'prepare' });
  assert.deepEqual(mapBcRfc('High Streamflow Advisory', { ratified: false }), { band: 'unstated', posture: 'monitor' });
  assert.equal(mapBcRfc('No Advisory', { ratified: true }).posture, 'ended');
  assert.equal(mapEmcr('Order').posture, 'act-now');
  assert.equal(mapEmcr('Alert').posture, 'prepare');
  assert.equal(mapEmcr('Rescinded').posture, 'ended');
  assert.equal(mapNtwc('Warning')?.posture, 'act-now');
  assert.equal(mapNtwc('Advisory')?.posture, 'prepare');
  assert.equal(mapNtwc('Watch')?.posture, 'prepare');
  assert.equal(mapNtwc('Information')?.posture, 'monitor');
  assert.equal(mapNtwc('Cancellation')?.posture, 'ended');
  assert.equal(mapNtwc('Unknown thing'), null);
  assert.deepEqual(Object.keys(MAPPING_TABLES).sort(), ['bc-rfc', 'eccc', 'emcr', 'ntwc', 'nws']);
});

test('designation from the event as issued, and its shape', () => {
  assert.equal(designationOf('Flood Watch', 'nws'), 'watch');
  assert.equal(designationOf('Child Abduction Emergency', 'nws'), 'emergency');
  assert.equal(designationOf('Special Weather Statement', 'nws'), 'statement');
  assert.equal(designationOf('Air Quality Alert', 'nws'), 'other');
  assert.equal(designationOf('warning', 'eccc'), 'warning');
  assert.equal(designationOf("veille d'orages violents", 'eccc'), 'watch');
  assert.equal(designationOf('bulletin météorologique spécial', 'eccc'), 'statement');
  assert.equal(designationShape('warning'), 'solid');
  assert.equal(designationShape('emergency'), 'solid');
  assert.equal(designationShape('watch'), 'outline');
  assert.equal(designationShape('advisory'), 'bar');
  assert.equal(designationShape('statement'), 'text');
  assert.equal(designationShape('other'), 'text');
});

test('category regression cases (blueprint 3.9), specific rules before general', () => {
  const t = { nws: {}, eccc: {} };
  /** @type {[string, 'nws' | 'eccc', string[]][]} */
  const cases = [
    ['Winter Storm Warning', 'nws', ['winter']],
    ['Wind Chill Warning', 'nws', ['cold']],
    ['Extreme Cold Warning', 'nws', ['cold']],
    ['Ice Storm Warning', 'nws', ['winter']],
    ['Coastal Flood Advisory', 'nws', ['coastal', 'flood']],
    ['Gale Warning', 'nws', ['marine', 'wind']],
    ['Small Craft Advisory', 'nws', ['marine', 'wind']],
    ['Red Flag Warning', 'nws', ['fire']],
    ['Air Quality Alert', 'nws', ['smoke-air']],
    ['Dense Smoke Advisory', 'nws', ['smoke-air']],
    ['Tsunami Warning', 'nws', ['tsunami']],
    ['Avalanche Warning', 'nws', ['avalanche']],
    ['Storm Warning', 'nws', ['marine', 'wind']],
    ['Storm Surge Warning', 'nws', ['coastal', 'flood']],
    ['Flood Watch', 'nws', ['flood']],
    ['rainfall warning', 'eccc', ['rain-landslide']],
    ['avertissement de pluie', 'eccc', ['rain-landslide']],
    ['wind warning', 'eccc', ['wind']],
  ];
  for (const [event, agency, expected] of cases) assert.deepEqual(categorize(event, agency, t), expected, event);
  assert.deepEqual(withTextCategories(['flood'], 'Debris flows are possible near burn scars.'), ['flood', 'rain-landslide']);
  assert.deepEqual(withTextCategories(['other'], 'A landslide closed the road.'), ['rain-landslide']);
  assert.deepEqual(categorize('Flood Warning', 'nws', { nws: { 'flood warning': ['coastal'] }, eccc: {} }), ['coastal'], 'exact table wins');
});

test('every NWS event type maps outside other unless allowed, and every captured event does', () => {
  const types = fixture('nws-alert-types', 'alert-types.json').body.eventTypes;
  assert.equal(types.length, 111);
  for (const e of types) {
    if (categorizeByRules(e)[0] === 'other') assert.ok(ALLOWED_OTHER.has(normalizeName(e)), `${e} maps to other`);
  }
  /** @type {string[]} */
  const captured = [];
  for (const name of ['footprint-active', 'topup-wa-or-id-pz', 'cancel-collection-page-1', 'cancel-collection-page-2', 'zone-param-20-ca-county-codes']) {
    const f = fixture('nws-alerts-active', `${name}.json`);
    captured.push(...normalizeNwsCollection(f.body, ctxOf(f.meta)).alerts.map((a) => a.event));
  }
  const ec = fixture('eccc-geomet-weather-alerts', 'canada-with-geometry.json');
  captured.push(...normalizeEcccCollection(ec.body, ctxOf(ec.meta)).alerts.map((a) => a.originalDesignation));
  const nt = fixture('ntwc-atom', 'paaq-atom.xml');
  captured.push(...normalizeNtwcFeed(new XMLParser({ ...NTWC_XML_OPTIONS }).parse(nt.text), { fetchedAt: nt.meta.capturedAt, now: new Date('2026-09-29T22:00:00Z') }).alerts.map((a) => a.event));
  for (const e of new Set(captured)) {
    if (categorizeByRules(e)[0] === 'other') assert.ok(ALLOWED_OTHER.has(normalizeName(e)), `captured event ${e} maps to other`);
  }
});

test('the committed reference tables equal what 80-hazards.mjs builds from the dated alerts/types capture', () => {
  const types = fixture('nws-alert-types', 'alert-types.json');
  const built = buildHazardReference({ typesDoc: types.body, typesAt: types.meta.capturedAt });
  for (const [name, doc] of Object.entries(built)) {
    const committed = JSON.parse(readFileSync(path.join(ROOT, 'site', 'data', 'ref', name), 'utf8'));
    assert.deepEqual(committed, doc, name);
  }
  const table = tableFromReference(built['nws-event-categories.json']);
  assert.deepEqual(table['Red Flag Warning'], ['fire']);
});
