// @ts-check
/**
 * Lane L6 acceptance for contacts (blueprint 5.3, 12.3). Covers the three CSV files lane L6 owns
 * (agencies.csv, audit-tribal.csv, conflicts.csv) plus the compiler rules over synthetic rows. Other
 * lanes' CSVs are checked by the compiler itself at build time.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { ROOT } from '../../../scripts/check/lib/pages.mjs';
import { SCHEMA_BASE, loadAjv, parseCsv } from '../../../scripts/check/lib/data-files.mjs';
import { CONTACT_HEADER, compileRows, mapRow, mobileBeforeNumber } from '../../../scripts/compile/contacts.mjs';

/** @typedef {import('../../../scripts/compile/contacts.mjs').ContactRow} ContactRow */

const OWN = ['agencies', 'audit-tribal', 'conflicts'];
/** @param {string} n */
async function load(n) {
  const text = await readFile(path.join(ROOT, 'data', 'contacts', `${n}.csv`), 'utf8');
  return { file: `data/contacts/${n}.csv`, header: (text.split(/\r?\n/, 1)[0] ?? '').split(','), rows: /** @type {ContactRow[]} */ (parseCsv(text)) };
}
const files = await Promise.all(OWN.map(load));
const rows = files.flatMap((f) => f.rows);
const ajv = await loadAjv();
const vRow = /** @type {import('ajv').ValidateFunction} */ (ajv.getSchema(`${SCHEMA_BASE}contact-row.schema.json`));
const vItem = /** @type {import('ajv').ValidateFunction} */ (ajv.getSchema(`${SCHEMA_BASE}contact.schema.json`));
const errs = (/** @type {import('ajv').ValidateFunction} */ v) => (/** @type {unknown} */ x) => (v(x) ? [] : (v.errors ?? []).map((e) => `${e.instancePath} ${e.message}`));
const opts = { today: '2026-10-06', validateRow: errs(vRow), validateItem: errs(vItem) };
const digits = (/** @type {string} */ s) => s.replace(/\D/g, '');

/** A minimal valid row for the rule tests. @param {Record<string, string>} [over] */
function sample(over = {}) {
  return {
    id: 'ct-test-row', scope_level: 'state', region: 'WA', nation_id: '', agency_id: '', county_fips: '', org: 'Test Org', office: '', role: '',
    line_type: '24-7', phone_e164: '+18005550100', phone_display: '800-555-0100', ext: '', email: '', url: 'https://example.org/', hours: '',
    published_by_nation: 'false', person: '', source_url: 'https://example.org/', source_publisher: 'Test', source_kind: 'state-official',
    source_snippet: 'Call 800-555-0100', verified_at: '2026-10-05', verified_method: 'page-text-match', status: 'verified', preferred: '',
    review_due: '2027-04-03', notes: '', ...over,
  };
}
const one = (/** @type {ContactRow[]} */ r) => compileRows([{ file: 'x.csv', header: [...CONTACT_HEADER], rows: r }], opts);

test('L6: schema-valid contacts with source_url, verified_at, verified_method, and line_type', () => {
  assert.ok(rows.length >= 60, `expected at least sixty rows, got ${rows.length}`);
  for (const f of files) assert.equal(f.header.join(','), CONTACT_HEADER.join(','), `${f.file} header`);
  for (const r of rows) {
    assert.deepEqual(errs(vRow)(r), [], r.id);
    for (const k of /** @type {const} */ (['source_url', 'verified_at', 'verified_method', 'line_type', 'source_snippet'])) assert.ok(r[k], `${r.id} lacks ${k}`);
    assert.ok(r.verified_at >= '2026-10-05', `${r.id} verified before 10/05/2026`);
    assert.match(r.notes, /^draft: /, `${r.id} must be marked draft`);
    const key = r.phone_e164 ? digits(r.phone_e164).slice(-10) : r.email.toLowerCase();
    const hay = r.phone_e164 ? digits(r.source_snippet) : r.source_snippet.toLowerCase();
    assert.ok(hay.includes(key), `${r.id} snippet does not contain its number or mailbox`);
  }
  const ids = rows.map((r) => r.id);
  assert.equal(new Set(ids).size, ids.length, 'duplicate ids across the L6 files');
  assert.doesNotThrow(() => compileRows(files, opts));
});

/** The twenty phone numbers the 10/04/2026 link audit found to differ (blueprint 5.3). @type {[string, string | null, string][]} */
const AUDIT = [
  ['Thurston EM', '360-867-2800', '360-704-2740'], ['Clallam EM', '360-417-2305', '360-417-2459'], ['Grays Harbor EM', '360-249-3911', '360-249-4705'],
  ['Pacific County EMA', '360-875-9338', '360-875-9397'], ['Clackamas', '503-655-8378', '503-655-8224'], ['Clatsop EM', '503-325-8645', '503-325-8635'],
  ['Lincoln EM', '541-265-4199', '541-265-0701'], ['Curry EM', '541-247-3275', '541-247-3242'], ['Idaho OEM main', '208-258-6500', '208-422-3040'],
  ['Idaho 24/7 StateComm', '800-632-8000', '208-422-3030'], ['Tulalip', '360-716-4000', '360-651-4000'], ['Lummi', '360-312-2000', '360-384-1489'],
  ['Nooksack', '360-592-5176', '360-966-7704'], ['Puyallup', '253-573-7800', '253-597-6200'], ['Siletz', '541-444-2532', '541-444-8200'],
  ['Sauk-Suiattle', '360-436-0131', '360-436-0132'], ['Siskiyou OES', '530-841-2155', '530-841-2900'], ['BIA Pacific Region', '916-426-9093', '916-978-6000'],
  ['Mendocino OES', '707-234-6398', '707-234-6600'],
  // Washington County, Oregon (page lists 503-846-7575) sits behind a bot gate that blocked every automated fetch on 10/05/2026.
  ['Washington County Oregon EM', null, '503-629-0111'],
];

test('L6: all twenty audit corrections applied and re-verified', () => {
  assert.equal(AUDIT.length, 20);
  const live = new Set(rows.filter((r) => r.status === 'verified').map((r) => digits(r.phone_e164).slice(-10)));
  const missing = [];
  for (const [label, now, legacy] of AUDIT) {
    if (legacy && live.has(digits(legacy))) assert.fail(`${label}: legacy number ${legacy} is still published`);
    if (now === null) continue; // not re-verifiable; must stay unpublished rather than guessed
    if (!live.has(digits(now))) missing.push(label);
  }
  assert.deepEqual(missing, [], 'corrections with no verified row');
  assert.ok(!live.has('5038467575'), 'the unverified Washington County number must not be published until re-verified');
});

test('L6: Washington duty-officer conflict recorded in conflicts.csv', async () => {
  const c = (await load('conflicts')).rows;
  assert.deepEqual(c.map((r) => r.phone_e164).sort(), ['+12535124901', '+12539124901']);
  for (const r of c) { assert.equal(r.status, 'conflict'); assert.notEqual(r.preferred, 'true'); assert.match(r.notes, /800-258-5990/); }
  const preferred = rows.find((r) => r.id === 'ct-wa-emd-alert-warning-center-24-7');
  assert.equal(preferred?.preferred, 'true');
  const { items, held } = compileRows(files, opts);
  assert.equal(held.length, 2);
  assert.ok(!items.some((i) => ['+12535124901', '+12539124901'].includes(i.phone?.e164)), 'conflicting numbers must not render');
});

test('L6: no personal mobile numbers; no person names unless Nation-published on the Nation domain', () => {
  for (const r of rows) {
    assert.equal(r.person, '', `${r.id} carries a person value`);
    assert.equal(mobileBeforeNumber(r), false, r.id);
    assert.doesNotMatch(`${r.office} ${r.role}`, /\b(cell|mobile)\b/i, r.id);
  }
  assert.throws(() => one([sample({ person: 'Someone', published_by_nation: 'false' })]), /person/);
  assert.throws(() => one([sample({ source_snippet: 'Cell: 800-555-0100' })]), /personal mobile/);
  assert.equal(mobileBeforeNumber(sample({ source_snippet: 'Duty officer 800-555-0100 Cell: 206-555-0199' })), false);
});

test('L6: the 5.3 coverage floor met', () => {
  const has = (/** @type {(r: ContactRow) => boolean} */ f) => rows.some((r) => r.status === 'verified' && f(r));
  for (const region of ['WA', 'OR', 'ID', 'CA', 'MT', 'NV', 'AK', 'BC']) {
    assert.ok(has((r) => r.region === region && r.line_type === '24-7' && ['state', 'province'].includes(r.scope_level)), `no 24/7 line for ${region}`);
  }
  assert.ok(has((r) => r.agency_id === 'nv-oem' && r.phone_e164 === '+17756870498'), 'Nevada 24/7 line');
  assert.ok(has((r) => r.id === 'ct-us-fema-region-10-government-main'), 'FEMA Region 10');
  assert.ok(has((r) => r.id === 'ct-us-fema-region-9-government-main'), 'FEMA Region 9');
  assert.ok(has((r) => r.agency_id === 'psc' && r.line_type === '24-7'), 'Public Safety Canada Government Operations Centre');
  assert.ok(has((r) => r.agency_id === 'fness' && r.line_type === '24-7'), 'FNESS after-hours line');
});

test('L6: compiler rules (duplicate ids, stale rows, reverification, header, conflicts)', () => {
  assert.throws(() => one([sample(), sample()]), /duplicate id/);
  assert.throws(() => one([sample({ verified_at: '2025-09-01', review_due: '2026-02-28' })]), /365 days/);
  assert.throws(() => compileRows([{ file: 'x.csv', header: ['id'], rows: [sample()] }], opts), /header/);
  assert.equal(one([sample({ verified_at: '2026-01-01', review_due: '2026-06-30' })]).items[0]?.status, 'needs-reverification');
  assert.equal(mapRow(sample({ review_due: '' }), '2026-10-05').verification.reviewDue, '2027-04-03');
  assert.equal(one([sample({ status: 'conflict', preferred: 'false' })]).held.length, 1);
  assert.equal(one([sample({ status: 'conflict', preferred: 'true' })]).items.length, 1);
  const order = one([
    sample({ id: 'ct-b-federal', scope_level: 'federal' }), sample({ id: 'ct-c-state', scope_level: 'state' }),
    sample({ id: 'ct-d-county', scope_level: 'county', line_type: 'emergency-management' }), sample({ id: 'ct-e-nation', scope_level: 'nation', line_type: '24-7', published_by_nation: 'true' }),
  ]).items.map((i) => i.id);
  assert.deepEqual(order, ['ct-e-nation', 'ct-d-county', 'ct-c-state', 'ct-b-federal']);
});

test('L6: independent verifier re-matches every phone number (live, opt-in)', { skip: process.env.CTHD_LIVE_VERIFY ? false : 'set CTHD_LIVE_VERIFY=1 to re-fetch every source page' }, async () => {
  const mismatches = [];
  for (const r of rows.filter((x) => x.phone_e164)) {
    // Opt-in live check run by the independent verifier; not part of the default suite.
    // eslint-disable-next-line no-restricted-globals
    const res = await fetch(r.source_url, { headers: { 'user-agent': 'Mozilla/5.0' } }).catch(() => null);
    const text = res ? (await res.text()).replace(/<[^>]+>/g, ' ') : '';
    const d = digits(r.phone_e164).slice(-10);
    const found = text.replace(/\D+/g, ' ').includes(`${d.slice(0, 3)} ${d.slice(3, 6)} ${d.slice(6)}`) || digits(text).includes(d);
    if (!found) mismatches.push(`${r.id} ${r.phone_display} ${r.source_url}`);
  }
  assert.deepEqual(mismatches, []);
});
