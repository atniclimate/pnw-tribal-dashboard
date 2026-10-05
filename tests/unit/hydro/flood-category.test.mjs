// @ts-check
/** Category words and freshness (blueprint 5.5). Owner: lane L7. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  categoryLabel, highestCategory, isObservationCurrent, observedDisplay, NOT_CURRENT_TEXT, NOT_DEFINED_TEXT,
} from '../../../site/static/js/hydro/flood-category.js';

const NOW = new Date('2026-10-05T12:00:00Z');
const H = 3600 * 1000;
const ago = (/** @type {number} */ ms) => new Date(NOW.getTime() - ms).toISOString();

test('null thresholds yield not_defined wording, never normal', () => {
  assert.equal(categoryLabel('not_defined'), 'No flood categories defined for this gauge');
  assert.equal(NOT_DEFINED_TEXT, categoryLabel('not_defined'));
  for (const c of /** @type {const} */ (['no_flooding', 'action', 'minor', 'moderate', 'major', 'not_defined', 'out_of_service', null])) {
    assert.ok(!/normal/i.test(categoryLabel(c)), `${c} must not read as normal`);
  }
});

test('the NWS categories read as the NWS words', () => {
  assert.equal(categoryLabel('no_flooding'), 'No Flooding');
  assert.equal(categoryLabel('action'), 'Action Stage');
  assert.equal(categoryLabel('minor'), 'Minor Flood');
  assert.equal(categoryLabel('moderate'), 'Moderate Flood');
  assert.equal(categoryLabel('major'), 'Major Flood');
  assert.equal(categoryLabel('out_of_service'), 'Out of Service');
  assert.equal(categoryLabel(null), 'No category available');
});

test('observations older than six hours read "Observation not current"', () => {
  assert.equal(isObservationCurrent(ago(5 * H + 59 * 60 * 1000), NOW), true);
  assert.equal(isObservationCurrent(ago(6 * H), NOW), true, 'exactly six hours is still current');
  assert.equal(isObservationCurrent(ago(6 * H + 1000), NOW), false);
  assert.equal(isObservationCurrent(null, NOW), false);
  assert.equal(isObservationCurrent('', NOW), false);
  assert.equal(isObservationCurrent('not a date', NOW), false);
  assert.equal(isObservationCurrent('0001-01-01T00:00:00Z', NOW), false);
  const stale = { id: 'nwps:AAAA1', observed: { stage: 3, unit: 'ft', flow: null, flowUnit: null, category: /** @type {const} */ ('no_flooding'), validTime: ago(7 * H) }, forecast: null };
  assert.equal(observedDisplay(stale, NOW).label, NOT_CURRENT_TEXT);
  assert.equal(observedDisplay(stale, NOW).current, false);
  assert.equal(NOT_CURRENT_TEXT, 'Observation not current');
});

test('a current observation shows the NWS category; out of service wins over staleness', () => {
  const fresh = { id: 'nwps:AAAA1', observed: { stage: 0, unit: 'ft', flow: null, flowUnit: null, category: /** @type {const} */ ('minor'), validTime: ago(H) }, forecast: null };
  assert.deepEqual(observedDisplay(fresh, NOW), { label: 'Minor Flood', category: 'minor', current: true });
  const oos = { id: 'nwps:AAAA2', observed: { stage: null, unit: null, flow: null, flowUnit: null, category: /** @type {const} */ ('out_of_service'), validTime: ago(40 * H) }, forecast: null };
  assert.equal(observedDisplay(oos, NOW).label, 'Out of Service');
  assert.equal(observedDisplay(null, NOW).label, 'No category available');
  assert.equal(observedDisplay({ id: 'x', observed: null, forecast: null }, NOW).current, false);
});

test('highest category ignores stale, not_defined, and out of service gauges', () => {
  const mk = (/** @type {string} */ id, /** @type {any} */ category, /** @type {string} */ t) => ({
    id, observed: { stage: 1, unit: 'ft', flow: null, flowUnit: null, category, validTime: t }, forecast: null });
  const statuses = [mk('a', 'action', ago(H)), mk('b', 'moderate', ago(2 * H)), mk('c', 'major', ago(9 * H)), mk('d', 'not_defined', ago(H)), mk('e', 'out_of_service', ago(H))];
  assert.equal(highestCategory(statuses, NOW), 'moderate');
  assert.equal(highestCategory([mk('d', 'not_defined', ago(H))], NOW), null);
  assert.equal(highestCategory([], NOW), null);
});
