// @ts-check
/**
 * Schema acceptance (L0): every schema compiles under Ajv (JSON Schema 2020-12), closes every object
 * (additionalProperties false), is listed in schemas/catalog.json, and validates the fixtures it covers.
 * Negative cases prove the guards that matter most.
 */
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, test } from 'node:test';
import { SCHEMA_BASE, SCHEMA_DIR, expand, loadAjv, loadCatalog, parseDataFile, personKeyHits } from '../../scripts/check/lib/data-files.mjs';

const ajv = await loadAjv();
const names = (await readdir(SCHEMA_DIR)).filter((n) => n.endsWith('.schema.json')).sort();
const catalog = await loadCatalog();
/** @param {string} name */
const v = (name) => {
  const f = ajv.getSchema(SCHEMA_BASE + name);
  if (!f) throw new Error(`no schema ${name}`);
  return f;
};
/** @param {string} rel */
const fixture = async (rel) => JSON.parse(await readFile(new URL(`../fixtures/${rel}`, import.meta.url), 'utf8'));

/**
 * Every object schema that declares properties must set additionalProperties to false or to a schema.
 * @param {unknown} node
 * @param {string} at
 * @param {string[]} out
 */
function openObjects(node, at, out) {
  if (Array.isArray(node)) { node.forEach((n, i) => openObjects(n, `${at}/${i}`, out)); return; }
  if (!node || typeof node !== 'object') return;
  const o = /** @type {Record<string, unknown>} */ (node);
  if (o.properties && o.additionalProperties !== false && typeof o.additionalProperties !== 'object') out.push(at);
  if (o.type === 'object' && !o.properties && o.additionalProperties === undefined && !o.$ref) out.push(at);
  for (const [k, val] of Object.entries(o)) {
    // Conditional subschemas (if, then, else, not) constrain an object that is already closed; skip them.
    if (['if', 'then', 'else', 'not'].includes(k)) continue;
    if ((k === 'properties' || k === '$defs') && val && typeof val === 'object') {
      // A map of property names (or definitions) to subschemas: check each subschema, not the map.
      for (const [name, sub] of Object.entries(val)) openObjects(sub, `${at}/${k}/${name}`, out);
    } else openObjects(val, `${at}/${k}`, out);
  }
}

describe('schemas', () => {
  test('every schema is JSON Schema 2020-12 with an $id under the site base', async () => {
    for (const n of names) {
      const s = JSON.parse(await readFile(path.join(SCHEMA_DIR, n), 'utf8'));
      assert.equal(s.$schema, 'https://json-schema.org/draft/2020-12/schema', n);
      assert.equal(s.$id, SCHEMA_BASE + n, n);
    }
  });

  test('every schema compiles under Ajv in strict mode', () => {
    for (const n of names) assert.equal(typeof v(n), 'function', n);
  });

  test('every object is closed (additionalProperties false or a schema)', async () => {
    for (const n of names) {
      /** @type {string[]} */
      const open = [];
      openObjects(JSON.parse(await readFile(path.join(SCHEMA_DIR, n), 'utf8')), n, open);
      assert.deepEqual(open, [], `open objects in ${n}`);
    }
  });

  test('the catalog lists every schema exactly once', () => {
    const listed = catalog.map((e) => e.schema).sort();
    assert.deepEqual(listed, names);
  });

  test('every catalog file that exists validates (registry fixture, fixture metadata)', async () => {
    let count = 0;
    for (const entry of catalog) {
      const validate = v(entry.schema);
      for (const pattern of entry.files) {
        for (const rel of await expand(pattern)) {
          count += 1;
          const value = await parseDataFile(rel);
          const rows = entry.format === 'csv-rows' && Array.isArray(value) ? value : [value];
          for (const row of rows) assert.ok(validate(row), `${rel}: ${JSON.stringify(validate.errors)}`);
        }
      }
    }
    assert.ok(count >= 40, `expected the fixtures to be covered, validated ${count}`);
  });
});

describe('guards', () => {
  test('a person key cannot enter a Nation record', async () => {
    const rec = await fixture('registry/nations/us-wa-lummi-tribe-of-the-lummi-reservation.json');
    assert.ok(v('nation.schema.json')(rec));
    assert.ok(!v('nation.schema.json')({ ...rec, firstname: 'x' }));
    assert.ok(!v('nation.schema.json')({ ...rec, hq: { ...rec.hq, jobtitle: 'x' } }));
    assert.deepEqual(personKeyHits({ a: [{ LastName: 'x' }] }), ['$.a[0].LastName']);
  });

  test('a name with the ? placeholder cannot be marked reviewed', async () => {
    const rec = await fixture('registry/nations/ca-fn-602.json');
    assert.ok(v('nation.schema.json')(rec), 'draft with placeholder is valid');
    assert.ok(!v('nation.schema.json')({ ...rec, review: { status: 'reviewed', reviewedAt: '2026-10-05', notes: '' } }));
    const fixedName = String.fromCodePoint(0x294) + 'aq' + String.fromCodePoint(0x313) + 'am';
    assert.ok(!v('nation.schema.json')({ ...rec, name: fixedName, review: { status: 'reviewed', reviewedAt: '2026-10-05', notes: '' } }), 'flag must be cleared too');
    assert.ok(v('nation.schema.json')({ ...rec, name: fixedName, flags: ['tz-needs-confirmation'], review: { status: 'reviewed', reviewedAt: '2026-10-05', notes: '' } }));
  });

  test('a contact may name a person only when the Nation published it', () => {
    const contact = {
      id: 'ct-wa-emd-alert-warning-center-24-7',
      scope: { level: 'state', region: 'WA', nationId: null, agencyId: 'wa-emd', countyFips: null },
      org: 'Washington Military Department, Emergency Management Division', office: 'State Alert and Warning Center', lineType: '24-7',
      phone: { e164: '+18002585990', display: '800-258-5990', ext: null }, email: null, url: 'https://mil.wa.gov/emd-contact-us', hours: '24 hours, 7 days',
      publishedByNation: false, person: null,
      source: { url: 'https://mil.wa.gov/emd-contact-us', publisher: 'Washington Military Department', kind: 'state-official', snippet: '24-hour State Alert & Warning Center: 800-258-5990' },
      verification: { verifiedAt: '2026-10-04', method: 'page-text-match', reviewDue: '2027-04-02' }, status: 'verified', sortWeight: 10,
    };
    assert.ok(v('contact.schema.json')(contact), JSON.stringify(v('contact.schema.json').errors));
    assert.ok(!v('contact.schema.json')({ ...contact, person: 'A Name' }));
    assert.ok(!v('contact.schema.json')({ ...contact, phone: { ...contact.phone, e164: '800-258-5990' } }));
  });

  test('a seasonal resource needs its season', () => {
    const r = { id: 'res-wa-211', title: 'Washington 211', url: 'https://wa211.org/', publisher: 'Washington 211', description: 'Statewide referral line.', category: 'shelter', hazards: ['flood'], scope: { level: 'state', region: 'WA' }, nationId: null, phone: '211', status: 'evergreen', verifiedAt: '2026-10-04', sourceUrl: 'https://wa211.org/' };
    assert.ok(v('resources.schema.json')([r]), JSON.stringify(v('resources.schema.json').errors));
    assert.ok(!v('resources.schema.json')([{ ...r, status: 'seasonal' }]));
  });

  test('typed zone keys are required in Nation records and alerts', async () => {
    const rec = await fixture('registry/nations/us-wa-lummi-tribe-of-the-lummi-reservation.json');
    assert.ok(!v('nation.schema.json')({ ...rec, nws: { ...rec.nws, forecastZones: ['WAZ310'] } }));
    assert.ok(!v('nation.schema.json')({ ...rec, nws: { ...rec.nws, fireZones: ['forecast:WAZ653'] } }));
  });

  test('a rejected live envelope with no items is valid, and an unknown field is not', () => {
    const env = { schema: 'cthd.live.alerts/1', id: 'alerts', sourceIds: ['nws-alerts-active'], generatedAt: '2026-10-05T06:30:00Z', observedAt: '2026-10-05T06:29:00Z', asOf: null, asOfBasis: null, completeness: 'rejected', carriedForward: false, failure: { code: 'http-503', message: 'upstream unavailable', at: '2026-10-05T06:29:00Z' }, perSource: { 'nws-alerts-active': { ok: false, count: 0, asOf: null } }, diagnostics: {}, items: [] };
    assert.ok(v('live-alerts.schema.json')(env), JSON.stringify(v('live-alerts.schema.json').errors));
    assert.ok(!v('live-alerts.schema.json')({ ...env, status: 'none' }));
    assert.ok(!v('live-alerts.schema.json')({ ...env, schema: 'cthd.live.news/1' }));
  });
});
