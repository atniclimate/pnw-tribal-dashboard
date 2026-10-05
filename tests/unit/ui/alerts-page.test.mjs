// @ts-check
/**
 * Lane L11 alerts page logic that runs without a DOM: filters read registry fields and combine as OR within
 * a filter and AND across filters, URL state round-trips, chip counts, pinned tsunami notices, grouping,
 * combined status honesty, and the sovereignty text matching the map module.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  ALERT_URL_SCHEMA, COVERAGE_LEGEND, SOVEREIGNTY_BODY, SOVEREIGNTY_HEADLINE, combineStatuses, countsFor, curatedRegion,
  declarationTypeOf, filterAlerts, groupByJurisdiction, regionsOfAlert, splitPinned, summarizeByDesignation, tileLabel,
} from '../../../site/static/js/ui/alert-list.js';
import { parseQuery, serializeQuery } from '../../../site/static/js/core/url-state.js';
import { cardIdFor, endsAtOf } from '../../../site/static/js/ui/alert-card.js';
import { validateSnapshot } from '../../../site/static/js/core/status.js';
import { SOVEREIGNTY_BODY as MAP_BODY, SOVEREIGNTY_HEADLINE as MAP_HEAD } from '../../../site/static/js/map/sovereignty.js';

/** @param {Record<string, any>} o @returns {any} */
const alert = (o) => ({ alertId: 'a', agency: 'nws', jurisdictions: ['WA'], categories: ['flood'], designation: 'warning', band: 'severe', posture: 'act-now', zones: [], nationIds: [], ...o });

describe('filters', () => {
  const a = alert({ alertId: 'a' });
  const b = alert({ alertId: 'b', jurisdictions: ['OR'], categories: ['wind'], designation: 'watch', band: 'moderate', posture: 'prepare' });
  const m = alert({ alertId: 'm', jurisdictions: ['MARINE'], zones: ['marine:PKZ011'], categories: ['marine', 'wind'], designation: 'advisory', band: 'minor', posture: 'monitor' });
  const t = alert({ alertId: 't', agency: 'ntwc', jurisdictions: ['WA', 'BC'], categories: ['tsunami'] });
  const all = [a, b, m, t];
  test('OR within one filter, AND across filters', () => {
    assert.deepEqual(filterAlerts(all, { j: ['wa', 'or'] }, {}).map((x) => x.alertId), ['a', 'b', 't']);
    assert.deepEqual(filterAlerts(all, { j: ['wa', 'or'], des: ['watch'] }, {}).map((x) => x.alertId), ['b']);
    assert.deepEqual(filterAlerts(all, { src: ['ntwc'] }, {}).map((x) => x.alertId), ['t']);
  });
  test('a marine alert counts under its region through marineToRegion, never from area text', () => {
    assert.ok(regionsOfAlert(m, { PKZ011: 'ak-se' }).has('ak-se'));
    assert.deepEqual(filterAlerts(all, { j: ['ak-se'] }, { marineToRegion: { PKZ011: 'ak-se' } }).map((x) => x.alertId), ['m']);
    assert.deepEqual(filterAlerts(all, { j: ['ak-se'] }, {}).map((x) => x.alertId), []);
  });
  test('chip counts leave out the filter being counted', () => {
    const c = countsFor(all, { j: ['wa'], des: ['watch'] }, 'j', {});
    assert.deepEqual(c, { or: 1 });
  });
  test('tiles count by designation with a band breakdown', () => {
    const s = summarizeByDesignation(all);
    assert.equal(s.warning?.count, 2);
    assert.deepEqual(s.warning?.bands, { severe: 2 });
    assert.equal(s.emergency?.count, 0);
  });
  test('tsunami notices are pinned apart from the rest; grouping keeps one card per alert', () => {
    assert.deepEqual(splitPinned(all).pinned.map((x) => x.alertId), ['t']);
    const groups = groupByJurisdiction(splitPinned(all).rest);
    assert.equal(groups.flatMap((g) => g.alerts).length, 3);
    assert.deepEqual(groups.map((g) => g.label), ['Washington', 'Oregon', 'Marine Waters']);
  });
  test('the Nation filter keeps only that Nation', () => {
    const n = alert({ alertId: 'n', nationIds: ['us-wa-x'] });
    assert.deepEqual(filterAlerts([a, n], { only: true }, { nationId: 'us-wa-x' }).map((x) => x.alertId), ['n']);
  });
});

describe('URL state', () => {
  test('filters round-trip and unknown keys survive', () => {
    const state = parseQuery('?view=map&j=wa,ak-se&hz=flood&des=warning,watch&band=severe&posture=act-now&src=nws&lang=fr&only=1&zzz=1', ALERT_URL_SCHEMA);
    assert.deepEqual(state.j, ['wa', 'ak-se']);
    assert.equal(state.only, true);
    const back = serializeQuery(state, '?zzz=1');
    assert.deepEqual(parseQuery(back, ALERT_URL_SCHEMA), state);
    assert.match(back, /zzz=1/);
  });
  test('invalid values are dropped, not guessed', () => {
    const s = parseQuery('?j=wa,atlantis&view=nope&des=loud', ALERT_URL_SCHEMA);
    assert.deepEqual(s.j, ['wa']);
    assert.equal(s.view, undefined);
    assert.equal(s.des, undefined);
  });
});

describe('combined status', () => {
  const now = new Date('2026-10-05T10:00:00Z');
  const st = (/** @type {string} */ id, /** @type {any} */ o) => [id, { state: 'live', asOf: '2026-10-05T09:50:00Z', asOfBasis: 'issued', sourceIds: [id], origin: 'direct', completeness: 'complete', checkedAt: now.toISOString(), ...o }];
  test('one source down makes the panel degraded, never live; all down is unavailable', () => {
    const one = combineStatuses(new Map(/** @type {any} */ ([st('n', {}), st('e', { state: 'unavailable', asOf: null, asOfBasis: null, completeness: 'partial' })])), ['n', 'e'], ['n', 'e'], now);
    assert.equal(one.state, 'degraded');
    assert.equal(one.completeness, 'partial');
    assert.deepEqual(validateSnapshot(one), []);
    const none = combineStatuses(new Map(), ['n'], ['n'], now);
    assert.equal(none.state, 'unavailable');
    assert.deepEqual(validateSnapshot(none), []);
  });
  test('as-of is the oldest answering source', () => {
    const s = combineStatuses(new Map(/** @type {any} */ ([st('n', {}), st('e', { asOf: '2026-10-05T08:00:00Z' })])), ['n', 'e'], ['n', 'e'], now);
    assert.equal(s.asOf, '2026-10-05T08:00:00Z');
  });
});

describe('helpers', () => {
  test('declaration type and curated region', () => {
    assert.equal(declarationTypeOf({ fema: /** @type {any} */ ({ type: 'DR' }) }), 'dr');
    assert.equal(declarationTypeOf({ curated: /** @type {any} */ ({ kind: 'emergency-proclamation' }) }), 'proclamation');
    assert.equal(curatedRegion(/** @type {any} */ ({ issuer: { name: 'Washington Governor', nationId: null } }), new Map()), 'wa');
    assert.equal(curatedRegion(/** @type {any} */ ({ issuer: { name: 'X', nationId: 'n1' } }), new Map([['n1', 'or']])), 'or');
    assert.equal(curatedRegion(/** @type {any} */ ({ issuer: { name: 'Somewhere', nationId: null } }), new Map()), null);
  });
  test('tile labels are singular for one', () => {
    assert.equal(tileLabel('advisory', 1), 'Advisory');
    assert.equal(tileLabel('advisory', 2), 'Advisories');
  });
  test('card ids are stable and safe; expiry is the later of ends and expires', () => {
    assert.equal(cardIdFor('nws:urn:oid:1.2/3'), cardIdFor('nws:urn:oid:1.2/3'));
    assert.match(cardIdFor('nws:urn:oid:1.2/3'), /^[A-Za-z0-9_-]+$/);
    assert.equal(endsAtOf(/** @type {any} */ ({ ends: '2026-10-05T01:00:00Z', expires: '2026-10-05T03:00:00Z' })), '2026-10-05T03:00:00Z');
  });
  test('the sovereignty text equals the map module text; the coverage legend is the blueprint sentence', () => {
    assert.equal(SOVEREIGNTY_HEADLINE, MAP_HEAD);
    assert.equal(SOVEREIGNTY_BODY, MAP_BODY);
    assert.equal(COVERAGE_LEGEND, 'Dashed areas are forecast zones named in the alert; solid areas were drawn by the forecaster.');
  });
});
