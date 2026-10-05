// @ts-check
/**
 * Lane L11 declarations: OpenFEMA grouping on the dated captures, the query, curated status per blueprint
 * 5.7, the loading service with injected network, and the snapshot task against the dated capture.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { femaQueryParams, femaStatusText, groupFema, groupFemaRows, usDate } from '../../../site/static/js/declarations/openfema.js';
import { curatedStatus, curatedStatusText } from '../../../site/static/js/declarations/curated.js';
import { loadDeclarations } from '../../../site/static/js/declarations/service.js';
import { deriveStatus } from '../../../site/static/js/core/status.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const cap = (/** @type {string} */ f) => JSON.parse(readFileSync(path.join(ROOT, 'tests', 'fixtures', 'upstream', 'openfema-declarations', `2026-10-05-${f}.json`), 'utf8'));
const nations = JSON.parse(readFileSync(path.join(ROOT, 'site', 'data', 'registry', 'nations-index.json'), 'utf8')).nations;
const dr4906 = cap('dr-4906-wa-multi-county').DisasterDeclarationsSummaries;
const tribal = cap('tribal-requests-footprint-states').DisasterDeclarationsSummaries;

describe('OpenFEMA grouping', () => {
  test('one disaster with 49 designated-area rows renders once with 49 areas', () => {
    const out = groupFemaRows(dr4906, { nations });
    assert.equal(out.length, 1);
    assert.equal(out[0]?.id, 'fema:DR-4906-WA');
    assert.equal(out[0]?.designatedAreas.length, 49);
  });
  test('thirty rows of that capture give one record with thirty areas', () => {
    const out = groupFemaRows(dr4906.slice(0, 30), { nations });
    assert.equal(out.length, 1);
    assert.equal(out[0]?.designatedAreas.length, 30);
  });
  test('Tribal reservations match registry Nations; counties do not', () => {
    const d = groupFemaRows(dr4906, { nations })[0];
    assert.ok(d?.nationIds.includes('us-wa-lummi-tribe-of-the-lummi-reservation'));
    assert.equal(d?.unmatchedTribalArea, null);
  });
  test('Tribal requests are flagged, and edge-state rows outside the footprint are dropped', () => {
    const out = groupFemaRows(tribal, { nations, footprintCountyCodes: new Set() });
    assert.ok(out.some((d) => d.id === 'fema:DR-4849-WA' && d.tribalRequest));
    assert.ok(!out.some((d) => d.id === 'fema:DR-4912-AK'), 'Kipnuk is outside the footprint');
  });
  test('rows with no valid declaration string are counted, not shown', () => {
    const r = groupFema([{ femaDeclarationString: 'nope' }, null], { nations });
    assert.deepEqual([r.items.length, r.skipped], [0, 2]);
  });
  test('status text never says active', () => {
    const d = groupFemaRows(dr4906, { nations })[0];
    assert.ok(d);
    const t = femaStatusText(d);
    assert.equal(t, 'Declared 04/07/2026; incident period 12/05/2025 to 12/19/2025; not closed out.');
    assert.doesNotMatch(t, /active/i);
    assert.equal(usDate('2026-04-07T00:00:00.000Z'), '04/07/2026');
  });
  test('the query pages with $skip over 730 days of the footprint states', () => {
    const q = femaQueryParams(new Date('2026-10-05T10:00:00Z'), 1000);
    assert.equal(q.$skip, '1000');
    assert.match(q.$filter ?? '', /declarationDate ge '2024-10-05T00:00:00.000Z'/);
    for (const s of ['WA', 'OR', 'ID', 'CA', 'NV', 'MT', 'AK']) assert.match(q.$filter ?? '', new RegExp(`state eq '${s}'`));
    assert.ok(q.$select && q.$orderby);
  });
});

describe('curated status (blueprint 5.7)', () => {
  const base = /** @type {any} */ ({ issuedOn: '2025-12-10', effectiveUntil: null, verifiedAt: '2025-12-12', reviewBy: '2026-01-11' });
  test('in effect until reviewBy, then not re-confirmed, and ended once effectiveUntil passes', () => {
    assert.deepEqual(curatedStatus(base, new Date('2025-12-20T20:00:00Z')), { kind: 'in-effect', since: '2025-12-12' });
    assert.equal(curatedStatusText(curatedStatus(base, new Date('2025-12-20T20:00:00Z'))), 'In effect (confirmed 12/12/2025)');
    const late = curatedStatus(base, new Date('2026-02-01T20:00:00Z'));
    assert.equal(curatedStatusText(late), 'Status not re-confirmed since 01/11/2026');
    const ended = curatedStatus({ ...base, effectiveUntil: '2026-01-20' }, new Date('2026-02-01T20:00:00Z'));
    assert.equal(curatedStatusText(ended), 'Ended 01/20/2026');
  });
});

describe('loadDeclarations', () => {
  const now = new Date('2026-10-05T10:00:00Z');
  /** @param {Record<string, unknown>} files */
  const deps = (files) => ({
    now: () => now,
    deriveStatus,
    fetchLocal: async (/** @type {string} */ p) => (p in files
      ? { ok: /** @type {const} */ (true), data: files[p], status: 200, fetchedAt: now.toISOString(), lastModified: null, sourceId: p }
      : { ok: /** @type {const} */ (false), error: { kind: /** @type {const} */ ('http'), status: 404, message: 'HTTP 404' }, fetchedAt: now.toISOString(), sourceId: p }),
    fetchJson: async () => ({ ok: /** @type {const} */ (false), error: { kind: /** @type {const} */ ('network'), message: 'down' }, fetchedAt: now.toISOString(), sourceId: 'x' }),
  });
  test('with nothing readable, both lists are empty and both statuses are unavailable (no invented rows)', async () => {
    const r = await loadDeclarations({ scope: { kind: 'footprint' }, deps: deps({}) });
    assert.deepEqual([r.fema.length, r.curated.length], [0, 0]);
    assert.equal(r.statuses.get('openfema-declarations')?.state, 'unavailable');
    assert.equal(r.statuses.get('cthd-curated-declarations')?.state, 'unavailable');
  });
  test('a fresh scheduled copy is used as is', async () => {
    const items = groupFemaRows(dr4906, { nations });
    const env = { items, completeness: 'complete', carriedForward: false, asOf: '2026-10-05T06:00:00Z', asOfBasis: 'issued' };
    const r = await loadDeclarations({ scope: { kind: 'footprint' }, deps: deps({ 'data/live/declarations-fema.json': env }) });
    assert.equal(r.fema.length, 1);
    assert.equal(r.statuses.get('openfema-declarations')?.state, 'live');
  });
});

describe('snapshot task', () => {
  test('writes a schema-shaped envelope from the dated capture, with Tribal matching', async () => {
    const { default: task } = await import('../../../scripts/snapshot/tasks/declarations.mjs');
    const { createFixtureHttp } = await import('../../../scripts/lib/http.mjs');
    const http = await createFixtureHttp(path.join(ROOT, 'tests', 'fixtures', 'upstream'));
    const footprint = JSON.parse(readFileSync(path.join(ROOT, 'site', 'data', 'geo', 'footprint-ugc.json'), 'utf8'));
    const out = await task.run(/** @type {any} */ ({
      now: new Date('2026-10-05T10:00:00Z'), http, previous: async () => null, log() {},
      registry: { index: { nations }, nation: async () => null }, reference: async () => footprint,
    }));
    const env = out['declarations-fema.json'];
    assert.ok(env);
    assert.equal(env.completeness, 'complete');
    assert.equal(env.asOfBasis, 'issued');
    assert.ok(env.items.length > 0);
    assert.ok(env.items.some((i) => /** @type {any} */ (i).id === 'fema:DR-4906-WA'));
  });
  test('a failed request rejects the file so the runner carries the previous copy forward', async () => {
    const { default: task } = await import('../../../scripts/snapshot/tasks/declarations.mjs');
    const http = { getJson: async () => ({ ok: false, error: { kind: 'network', message: 'down' }, fetchedAt: '2026-10-05T10:00:00Z', sourceId: 'openfema-declarations' }) };
    const out = await task.run(/** @type {any} */ ({ now: new Date('2026-10-05T10:00:00Z'), http, previous: async () => null, log() {}, registry: { index: { nations: [] } }, reference: async () => null }));
    assert.equal(out['declarations-fema.json']?.completeness, 'rejected');
    assert.deepEqual(out['declarations-fema.json']?.items, []);
  });
});
