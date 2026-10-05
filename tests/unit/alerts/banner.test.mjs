// @ts-check
/**
 * Banner (blueprint 3.8): rules 1 to 4, a property-based test of the all-clear rule over generated
 * source states, and the house-style copy.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bannerCopy, requiredSourcesFor, summarizeForBanner, NWS_ID, ECCC_ID, BC_RFC_ID } from '../../../site/static/js/alerts/banner.js';
import { fixtureNation, rng } from './helpers.mjs';

const NOW = new Date('2026-10-04T22:42:00Z');
const STATES = /** @type {const} */ (['live', 'cached', 'stale', 'degraded', 'unavailable']);
const POSTURES = /** @type {const} */ (['act-now', 'prepare', 'monitor', 'ended']);
const DESIGNATIONS = /** @type {const} */ (['emergency', 'warning', 'watch', 'advisory', 'statement', 'other']);

/** @param {string} id @param {any} [o] @returns {import('../../../site/static/js/types.js').StatusSnapshot} */
const status = (id, o = {}) => ({ state: 'live', asOf: '2026-10-04T22:40:00Z', asOfBasis: 'issued', sourceIds: [id], origin: 'direct', completeness: 'complete', checkedAt: NOW.toISOString(), ...o });
/** @param {any} o @returns {any} */
const alert = (o) => ({
  alertId: `nws:${o.id ?? 'x'}`, eventId: `nws:${o.id ?? 'x'}`, sourceId: NWS_ID, sent: '2026-10-04T20:00:00Z', messageType: 'alert', references: [],
  lifecycleState: 'active', event: 'Flood Watch', band: 'moderate', posture: 'prepare', designation: 'watch', effective: '2026-10-04T20:00:00Z',
  expires: '2026-10-05T20:00:00Z', agency: 'nws', nationIds: [], jurisdictions: ['WA'], zones: [], ...o,
});

test('required sources by scope', () => {
  assert.deepEqual(requiredSourcesFor({ kind: 'nation', nation: fixtureNation('us-wa-lummi-tribe-of-the-lummi-reservation') }), [NWS_ID]);
  assert.deepEqual(requiredSourcesFor({ kind: 'nation', nation: fixtureNation('ca-fn-602') }), [ECCC_ID]);
  assert.deepEqual(requiredSourcesFor({ kind: 'nation', nation: fixtureNation('ca-fn-602') }, { bcRfcActive: true }), [ECCC_ID, BC_RFC_ID]);
  assert.deepEqual(requiredSourcesFor({ kind: 'footprint' }), [NWS_ID, ECCC_ID]);
  assert.deepEqual(requiredSourcesFor({ kind: 'footprint', jurisdictions: ['WA'] }), [NWS_ID]);
  assert.deepEqual(requiredSourcesFor({ kind: 'footprint', jurisdictions: ['BC'] }), [ECCC_ID]);
});

test('rule 1: none only when every required source is live and complete', () => {
  const live = new Map([[NWS_ID, status(NWS_ID)], [ECCC_ID, status(ECCC_ID, { asOf: '2026-10-04T22:35:00Z' })]]);
  assert.deepEqual(summarizeForBanner([], live, [NWS_ID, ECCC_ID], NOW), { kind: 'none', asOf: '2026-10-04T22:35:00Z' });
  const partial = new Map([[NWS_ID, status(NWS_ID, { completeness: 'partial', state: 'degraded' })], [ECCC_ID, status(ECCC_ID)]]);
  assert.equal(summarizeForBanner([], partial, [NWS_ID, ECCC_ID], NOW).kind, 'unknown');
  assert.equal(summarizeForBanner([], live, [], NOW).kind, 'unknown', 'an empty requirement is never proof');
});

test('rule 2: zero alerts and a required source not current gives unknown with a reason', () => {
  assert.deepEqual(summarizeForBanner([], new Map(), [NWS_ID], NOW), { kind: 'unknown', reason: 'loading', lastConfirmedAt: null });
  const down = new Map([[NWS_ID, status(NWS_ID, { state: 'unavailable', asOf: null, asOfBasis: null })]]);
  assert.deepEqual(summarizeForBanner([], down, [NWS_ID], NOW), { kind: 'unknown', reason: 'unavailable', lastConfirmedAt: null });
  const stale = new Map([[NWS_ID, status(NWS_ID, { state: 'stale', asOf: '2026-10-04T22:17:00Z', origin: 'snapshot' })]]);
  assert.deepEqual(summarizeForBanner([], stale, [NWS_ID], NOW), { kind: 'unknown', reason: 'not-current', lastConfirmedAt: '2026-10-04T22:17:00Z' });
});

test('rule 3: alerts present are never hidden; a source not live adds a qualifier', () => {
  const b = summarizeForBanner([alert({ id: '1' })], new Map([[NWS_ID, status(NWS_ID, { state: 'stale' })]]), [NWS_ID], NOW);
  assert.equal(b.kind, 'prepare');
  assert.ok(b.kind === 'prepare' && b.qualifier === 'stale');
  const p = summarizeForBanner([alert({ id: '1' })], new Map(), [NWS_ID], NOW);
  assert.ok(p.kind === 'prepare' && p.qualifier === 'partial');
});

test('rule 4: counts every designation; kind is the strongest posture; ended and expired never count', () => {
  const alerts = [
    alert({ id: 'w1', designation: 'warning', posture: 'act-now', event: 'Flood Warning', band: 'severe' }),
    alert({ id: 'w2', designation: 'warning', posture: 'act-now', event: 'High Wind Warning', band: 'moderate' }),
    alert({ id: 'h', designation: 'watch' }),
    alert({ id: 'a1', designation: 'advisory', posture: 'monitor' }),
    alert({ id: 'a2', designation: 'advisory', posture: 'monitor' }),
    alert({ id: 'a3', designation: 'advisory', posture: 'monitor' }),
    alert({ id: 'old', designation: 'warning', posture: 'act-now', expires: '2026-10-04T21:00:00Z', ends: null }),
    alert({ id: 'end', designation: 'warning', posture: 'ended' }),
  ];
  const b = summarizeForBanner(alerts, new Map([[NWS_ID, status(NWS_ID)]]), [NWS_ID], NOW);
  assert.equal(b.kind, 'act-now');
  if (b.kind !== 'act-now') return;
  assert.deepEqual(b.counts, { emergency: 0, warning: 2, watch: 1, advisory: 3, statement: 0, other: 0 });
  assert.equal(b.top.alertId, 'nws:w1');
  assert.equal(b.qualifier, null);
  const copy = bannerCopy(b, { scopeName: 'Cascadia', timeZone: 'America/Los_Angeles' });
  assert.deepEqual(copy, { headline: '2 warnings in effect for Cascadia.', detail: '1 watch and 3 advisories also in effect.' });
});

test('property: the banner is none only with no showable alert and every required source live and complete', () => {
  const r = rng(20261005);
  const pick = (/** @type {readonly any[]} */ xs) => xs[Math.floor(r() * xs.length)];
  const ids = [NWS_ID, ECCC_ID, BC_RFC_ID];
  let nones = 0;
  for (let i = 0; i < 20000; i += 1) {
    const required = ids.filter(() => r() < 0.6);
    /** @type {Map<string, any>} */
    const statuses = new Map();
    for (const id of ids) {
      if (r() < 0.1) continue;
      const state = pick(STATES);
      statuses.set(id, status(id, { state, completeness: r() < 0.8 ? 'complete' : 'partial', asOf: state === 'unavailable' ? null : '2026-10-04T22:30:00Z' }));
    }
    const n = Math.floor(r() * 4);
    const alerts = Array.from({ length: n }, (_, k) => alert({
      id: `${i}-${k}`, posture: pick(POSTURES), designation: pick(DESIGNATIONS), sourceId: pick(ids),
      expires: r() < 0.2 ? '2026-10-04T20:00:00Z' : '2026-10-05T20:00:00Z', ends: null,
      lifecycleState: r() < 0.1 ? 'superseded' : 'active', messageType: r() < 0.1 ? 'cancel' : 'alert',
    }));
    const b = summarizeForBanner(alerts, statuses, required, NOW);
    const showable = alerts.filter((a) => a.lifecycleState === 'active' && a.messageType !== 'cancel' && a.posture !== 'ended' && a.expires > NOW.toISOString());
    if (b.kind === 'none') {
      nones += 1;
      assert.equal(showable.length, 0);
      assert.ok(required.length > 0);
      for (const id of required) {
        const s = statuses.get(id);
        assert.ok(s && s.state === 'live' && s.completeness === 'complete', `required ${id} not live and complete`);
      }
    }
    if (showable.length > 0) {
      assert.ok(b.kind === 'act-now' || b.kind === 'prepare' || b.kind === 'monitor', 'alerts are never hidden');
      if (b.kind === 'act-now' || b.kind === 'prepare' || b.kind === 'monitor') {
        assert.equal(Object.values(b.counts).reduce((x, y) => x + y, 0), showable.length);
      }
    } else {
      assert.ok(b.kind === 'none' || b.kind === 'unknown');
    }
  }
  assert.ok(nones > 0, 'the generator reached the all-clear branch');
});

test('copy: unknown, none, monitor, extreme, and the qualifier', () => {
  const tz = 'America/Los_Angeles';
  assert.deepEqual(bannerCopy({ kind: 'unknown', reason: 'not-current', lastConfirmedAt: null }, { scopeName: 'Cascadia', timeZone: tz, requiredSourceIds: [NWS_ID], now: new Date('2026-10-04T22:17:00Z') }),
    { headline: 'Alert status unknown.', detail: 'National Weather Service alerts could not be confirmed as of 3:17 PM PDT. This is not an all-clear.' });
  const none = bannerCopy({ kind: 'none', asOf: '2026-10-04T22:42:00Z' }, { scopeName: 'Cascadia', timeZone: tz });
  assert.equal(none.headline, 'No active NWS or ECCC alerts for Cascadia as of 3:42 PM PDT.');
  assert.equal(none.detail, 'Absence of an alert is not a guarantee of safety.');
  const counts = { emergency: 0, warning: 0, watch: 0, advisory: 3, statement: 1, other: 0 };
  const monitor = bannerCopy({ kind: 'monitor', counts, top: alert({ posture: 'monitor', designation: 'advisory' }), qualifier: 'stale' }, { scopeName: 'Cascadia', timeZone: tz });
  assert.equal(monitor.headline, '3 advisories and 1 statement in effect for Cascadia.');
  assert.equal(monitor.detail, 'Some sources are not current; see the status below.');
  const ext = bannerCopy({ kind: 'act-now', counts: { ...counts, advisory: 0, statement: 0, warning: 1 }, top: alert({ band: 'extreme', event: 'Extreme Wind Warning', areaDesc: 'Western Whatcom County' }), qualifier: null }, { scopeName: 'Lummi', timeZone: tz });
  assert.equal(ext.headline, 'Extreme Wind Warning for Western Whatcom County. 1 warning in effect for Lummi.');
  for (const c of [none, monitor, ext]) assert.ok(!/—/.test(`${c.headline}${c.detail}`), 'no em dashes');
});
