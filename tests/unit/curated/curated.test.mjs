// @ts-check
/** Lane L6 acceptance for agencies, resources, curated declarations, and the event archive (blueprint 5.6, 5.7, 5.11, 6.6). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { ROOT } from '../../../scripts/check/lib/pages.mjs';
import { SCHEMA_BASE, loadAjv, parseCsv, parseDataFile } from '../../../scripts/check/lib/data-files.mjs';
import { honestyProblems } from '../../../scripts/compile/curated.mjs';

const ajv = await loadAjv();
/** @param {string} schema @param {unknown} value */
function schemaErrors(schema, value) {
  const v = /** @type {import('ajv').ValidateFunction} */ (ajv.getSchema(SCHEMA_BASE + schema));
  return v(value) ? [] : (v.errors ?? []).map((e) => `${e.instancePath} ${e.message}`);
}
/** @type {any[]} */
const resources = /** @type {any} */ (await parseDataFile('data/resources.yaml'));
/** @type {any[]} */
const declarations = /** @type {any} */ (await parseDataFile('data/declarations/curated.yaml'));
/** @type {any[]} */
const agencies = /** @type {any} */ (await parseDataFile('data/agencies.yaml'));
/** @type {any} */
const event = await parseDataFile('data/events/2025-12-atmospheric-river.yaml');
const ledger = JSON.parse(await readFile(path.join(ROOT, 'tests/unit/curated/links-checked.json'), 'utf8')).links;

test('L6: every resource has status and verifiedAt', () => {
  assert.deepEqual(schemaErrors('resources.schema.json', resources), []);
  assert.ok(resources.length >= 15);
  for (const r of resources) {
    assert.ok(['evergreen', 'seasonal'].includes(r.status), r.id);
    assert.match(r.verifiedAt, /^\d{4}-\d{2}-\d{2}$/, r.id);
    assert.ok(r.sourceUrl, `${r.id} has no source`);
  }
  assert.deepEqual(honestyProblems('resources', resources), []);
});

test('L6: event items are rejected from resources and live in the archive file with original dates', () => {
  const bad = [{ ...resources[0], id: 'res-x', title: 'Tribe Emergency Declaration', description: 'State of emergency issued 12/11/2025.' }];
  assert.match(honestyProblems('resources', bad).join(), /event item/);
  assert.deepEqual(schemaErrors('event.schema.json', event), []);
  assert.deepEqual(honestyProblems('events', [event]), []);
  const dates = event.entries.map((/** @type {any} */ e) => e.date);
  assert.ok(dates.includes('2025-12-10') && dates.includes('2025-12-11') && dates.includes('2025-12-16'), 'original December 2025 dates kept');
  assert.deepEqual(dates, [...dates].sort(), 'entries are in date order');
  assert.ok(event.femaDisasterNumbers.includes(3629));
  assert.match(JSON.stringify(event.notes), /Nooksack/, 'held item is recorded');
});

test('L6: zero DecTool simulated rows', async () => {
  assert.deepEqual(schemaErrors('declarations-curated.schema.json', declarations), []);
  assert.deepEqual(honestyProblems('declarations', declarations), []);
  const dump = JSON.stringify([declarations, resources, event.entries]);
  for (const legacy of ['FEMA-3601-DR', 'Proclamation 25-12', 'Simulating', 'governor.wa.gov"', 'caloes.ca.gov"']) assert.ok(!dump.includes(legacy), `legacy simulated row survives: ${legacy}`);
  for (const d of declarations) {
    assert.ok(d.source.url.startsWith('https://') && !d.source.url.endsWith('#'), d.id);
    assert.ok(Date.parse(d.reviewBy) - Date.parse(d.verifiedAt) <= 30 * 86400000, `${d.id} reviewBy more than thirty days after verification`);
  }
  assert.match(honestyProblems('declarations', [{ ...declarations[0], id: 'decl-x', title: 'Simulated order' }]).join(), /simulated/);
});

test('L6: agencies are schema-valid, unique, and cover every agency_id used by the L6 contact files', async () => {
  assert.deepEqual(schemaErrors('agencies.schema.json', agencies), []);
  assert.deepEqual(honestyProblems('agencies', agencies), []);
  const ids = new Set(agencies.map((a) => a.id));
  for (const n of ['agencies', 'audit-tribal', 'conflicts']) {
    for (const r of parseCsv(await readFile(path.join(ROOT, 'data/contacts', `${n}.csv`), 'utf8'))) if (r.agency_id) assert.ok(ids.has(r.agency_id), `${r.id} names unknown agency ${r.agency_id}`);
  }
  assert.match(honestyProblems('agencies', [{ id: 'a', parentId: 'zz' }]).join(), /unknown parentId/);
});

test('L6: every curated URL passes the link check or is labeled dead with an archived copy', () => {
  /** @type {Set<string>} */
  const urls = new Set();
  for (const r of resources) { urls.add(r.url); urls.add(r.sourceUrl); }
  for (const d of declarations) urls.add(d.source.url);
  for (const a of agencies) if (a.url) urls.add(a.url);
  const byUrl = new Map(ledger.map((/** @type {any} */ l) => [l.url, l]));
  const deadOk = new Map(event.entries.filter((/** @type {any} */ e) => e.linkStatus === 'dead').map((/** @type {any} */ e) => [e.url, e.archiveUrl]));
  for (const e of event.entries) urls.add(e.url);
  for (const u of urls) {
    const l = byUrl.get(u);
    assert.ok(l, `no link-check record for ${u}`);
    if (deadOk.has(u)) assert.ok(deadOk.get(u), `${u} is dead and has no archived copy`);
    else assert.ok(l.status === 200 || (l.status === 403 && /disasterassistance\.gov/.test(u)), `${u} returned ${l.status}`);
    assert.ok(l.checkedAt >= '2026-10-05', u);
  }
  for (const e of event.entries) assert.ok(e.linkStatus === 'ok' ? byUrl.get(e.url)?.status === 200 : e.archiveUrl, e.url);
});
