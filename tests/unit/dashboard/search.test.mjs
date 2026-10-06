import { test } from 'node:test';
import assert from 'node:assert/strict';
import { searchKey, searchNations, displayName } from '../../../site/static/js/data/nations.js';
import { activeAlerts } from '../../../site/static/js/pages/dashboard.js';

/**
 * @param {string} id
 * @param {string} name
 * @param {string[]} [aliases]
 * @param {string | null} [preferredName]
 * @returns {import('../../../site/static/js/types.js').NationIndexEntry}
 */
const nation = (id, name, aliases = [], preferredName = null) => ({ id, name, aliases, preferredName,
  jurisdictions: ['BC'], region: 'bc', kind: 'first-nation', hq: [50, -123], tz: 'America/Vancouver', hasBoundary: false });

test('Nation search folds accents and glottal variants without changing display names', () => {
  const entry = nation('ca-fn-602', 'ʔaq̓am', ['St. Mary’s Indian Band']);
  for (const query of ['ʔaqam', '7aqam', '?aqam', "'aqam"]) assert.equal(searchNations([entry], query)[0], entry);
  assert.deepEqual(displayName(entry), { primary: 'ʔaq̓am', secondary: null });
  assert.equal(searchKey('  Élan   Nation '), 'elan nation');
});

test('An exact alias ranks before a name prefix and a substring', () => {
  const exact = nation('ca-fn-1', 'Formal Government Name', ['River']);
  const prefix = nation('ca-fn-2', 'River Nation');
  const substring = nation('ca-fn-3', 'Downriver Nation');
  assert.deepEqual(searchNations([substring, prefix, exact], 'River'), [exact, prefix, substring]);
  assert.equal(displayName(exact).primary, 'Formal Government Name');
});

test('Every search token must match and the original registry order is untouched', () => {
  const list = [nation('ca-fn-2', 'West River First Nation'), nation('ca-fn-1', 'North Lake First Nation')];
  assert.deepEqual(searchNations(list, 'riv wes'), [list[0]]);
  assert.deepEqual(searchNations(list, 'river missing'), []);
  assert.equal(list[0]?.id, 'ca-fn-2');
});

test('Preferred names are secondary; aliases are never substituted for formal names', () => {
  assert.deepEqual(displayName(nation('ca-fn-1', 'Formal Nation', ['Old Name'], 'Preferred Name')),
    { primary: 'Formal Nation', secondary: 'Preferred Name' });
  assert.deepEqual(displayName(nation('ca-fn-2', 'Same Name', [], 'Same Name')), { primary: 'Same Name', secondary: null });
});

test('Dashboard lifecycle follows the later ends/expires date and preserves undated active alerts', () => {
  const now = new Date('2026-10-05T12:00:00Z');
  const base = /** @type {import('../../../site/static/js/types.js').DashboardAlert} */ ({ lifecycleState: 'active', messageType: 'alert', posture: 'monitor', ends: null, expires: null });
  const laterExpiry = { ...base, ends: '2026-10-05T11:00:00Z', expires: '2026-10-05T13:00:00Z' };
  const expired = { ...base, expires: '2026-10-05T11:00:00Z' };
  const cancelled = /** @type {import('../../../site/static/js/types.js').DashboardAlert} */ ({ ...base, messageType: 'cancel' });
  assert.deepEqual(activeAlerts([base, laterExpiry, expired, cancelled], now), [base, laterExpiry]);
});
