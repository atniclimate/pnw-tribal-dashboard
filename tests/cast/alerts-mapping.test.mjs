// @ts-check
/**
 * CAST parity (blueprint 10.1): the JavaScript ports in site/static/js/alerts/ reproduce CAST's outputs.
 * CAST's own TypeScript (tests/fixtures/cast/alerts-schema/src/*.ts, byte-for-byte copies at the commit
 * in UPSTREAM.json) runs beside the ports through Node 24's type stripping, so every comparison is against
 * CAST itself, not a transcription of it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ECCC_MAPPING_TABLE, NWS_MAPPING_TABLE, mapEcccDimensions, mapNwsDimensions, MAPPING_TABLES } from '../../site/static/js/alerts/mapping.js';
import { compareSeverityBands, createAlertId, highestSeverityBand } from '../../site/static/js/alerts/model.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CAST = path.join(ROOT, 'tests', 'fixtures', 'cast', 'alerts-schema', 'src');
/** @param {string} name */
const castModule = (name) => import(pathToFileURL(path.join(CAST, name)).href);
const cast = { mappings: await castModule('mappings.ts'), model: await castModule('model.ts') };

const SEVERITY = ['Extreme', 'Severe', 'Moderate', 'Minor', 'Unknown', ' severe ', 'SEVERE', 'bogus', '', null, undefined];
const URGENCY = ['Immediate', 'Expected', 'Future', 'Past', 'Unknown', 'immediate', 'bogus', '', null, undefined];
const CERTAINTY = ['Observed', 'Likely', 'Possible', 'Unlikely', 'Unknown', 'bogus', null, undefined];
const ENDED = [true, false, undefined];
const EVENTS = ['Flood Warning', 'Flood Watch', 'Small Craft Advisory', 'Special Weather Statement', 'Child Abduction Emergency',
  'Air Quality Alert', 'Catastrophic Flood Warning', ' Wind Advisory ', 'warning', 'statement', '', null, undefined];
const NWS_TYPES = JSON.parse(readFileSync(path.join(ROOT, 'tests', 'fixtures', 'upstream', 'nws-alert-types', '2026-10-05-alert-types.json'), 'utf8')).eventTypes;

/** @param {Record<string, unknown>} o @returns {Record<string, unknown>} keys with undefined values dropped */
const defined = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));

test('table names and versions equal CAST', () => {
  assert.deepEqual(MAPPING_TABLES.nws, { name: cast.mappings.NWS_MAPPING_TABLE.name, version: cast.mappings.NWS_MAPPING_TABLE.version });
  assert.deepEqual(MAPPING_TABLES.eccc, { name: cast.mappings.ECCC_MAPPING_TABLE.name, version: cast.mappings.ECCC_MAPPING_TABLE.version });
  assert.deepEqual(JSON.parse(JSON.stringify(NWS_MAPPING_TABLE)), JSON.parse(JSON.stringify(cast.mappings.NWS_MAPPING_TABLE)));
  assert.deepEqual(JSON.parse(JSON.stringify(ECCC_MAPPING_TABLE)), JSON.parse(JSON.stringify(cast.mappings.ECCC_MAPPING_TABLE)));
});

test('NWS band, posture, and confidence equal CAST mapNwsAlert over every input combination', () => {
  let n = 0;
  for (const severity of SEVERITY) for (const urgency of URGENCY) for (const certainty of CERTAINTY) for (const ended of ENDED) for (const event of EVENTS) {
    const input = defined({ severity, urgency, certainty, ended, event });
    assert.deepEqual(mapNwsDimensions(input), cast.mappings.mapNwsAlert(input), JSON.stringify(input));
    n += 1;
  }
  for (const event of NWS_TYPES) for (const urgency of URGENCY) for (const ended of ENDED) {
    const input = defined({ event, urgency, ended, severity: 'Moderate', certainty: 'Likely' });
    assert.deepEqual(mapNwsDimensions(input), cast.mappings.mapNwsAlert(input), JSON.stringify(input));
    n += 1;
  }
  assert.ok(n > 30000);
});

test('ECCC band precedence equals CAST mapEcccAlert over every input combination', () => {
  const IMPACT = ['Extreme', 'High', 'Severe', 'Medium', 'Moderate', 'modéré', 'Low', 'Minor', 'bogus', null, undefined];
  const COLOUR = ['Red', 'Orange', 'Yellow', 'jaune', 'Green', 'bogus', null, undefined];
  const TYPES = ['warning', 'watch', 'advisory', 'statement', 'cancel', null];
  for (const mscImpact of IMPACT) for (const colour of COLOUR) for (const severity of SEVERITY) for (const event of TYPES) for (const ended of ENDED) {
    const input = defined({ mscImpact, colour, severity, event, ended, urgency: 'Expected', certainty: 'Likely' });
    assert.deepEqual(mapEcccDimensions(input), cast.mappings.mapEcccAlert(input), JSON.stringify(input));
  }
});

test('CAST alerts-schema test cases hold for the ports', () => {
  assert.equal(compareSeverityBands('unstated', 'minor'), null);
  assert.equal(compareSeverityBands('extreme', 'unstated'), null);
  assert.ok(/** @type {number} */ (compareSeverityBands('severe', 'moderate')) > 0);
  assert.equal(mapEcccDimensions({ mscImpact: 'High', colour: 'Yellow', severity: 'Minor' }).band, 'severe');
  assert.equal(mapEcccDimensions({ colour: 'Orange', severity: 'Minor' }).band, 'severe');
  assert.equal(mapEcccDimensions({ severity: 'Moderate' }).band, 'moderate');
  assert.equal(mapEcccDimensions({ mscImpact: 'modéré', colour: 'jaune' }).band, 'moderate');
  const mapped = mapNwsDimensions({ event: 'Catastrophic Flood Warning' });
  assert.equal(mapped.band, 'unstated');
  assert.equal(mapped.posture, 'act-now');
});

test('band ordering helpers and alert ids equal CAST', () => {
  const BANDS = /** @type {const} */ (['extreme', 'severe', 'moderate', 'minor', 'unstated']);
  for (const a of BANDS) for (const b of BANDS) assert.equal(compareSeverityBands(a, b), cast.model.compareSeverityBands(a, b));
  for (const a of BANDS) for (const b of BANDS) for (const c of BANDS) {
    assert.equal(highestSeverityBand([a, b, c]), cast.model.highestSeverityBand([a, b, c]));
  }
  assert.equal(highestSeverityBand([]), cast.model.highestSeverityBand([]));
  assert.equal(createAlertId('nws', 'urn:oid:1'), cast.model.createAlertId('nws', 'urn:oid:1'));
  for (const [ag, id] of /** @type {[string, string][]} */ ([['', 'x'], ['nws', ' ']])) {
    assert.throws(() => createAlertId(ag, id));
    assert.throws(() => cast.model.createAlertId(ag, id));
  }
});
