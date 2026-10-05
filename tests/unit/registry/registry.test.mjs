// @ts-check
/**
 * Lane L5 wave 1: the draft Nation registry (blueprint 5.2, 6.2, 6.6, 12.3). Parser tests use real entries
 * from the pinned Federal Register notice and the BIA and ISC downloads of 10/04/2026; the corpus tests read
 * the committed registry files. Owner: lane L5.
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { load as loadYaml, CORE_SCHEMA } from 'js-yaml';
import { ROOT } from '../../../scripts/check/lib/pages.mjs';
import { PERSON_KEYS, loadAjv, personKeyHits } from '../../../scripts/check/lib/data-files.mjs';
import {
  BC_TOLERANCE_KM, CENSUS_LEGAL_MTFCC, TLD_ALLOW, applyApproval, decodeEntities, distanceToOutlineKm, normName, parseFederalRegister, pointInGeometry, readApproval, splitFrEntry, tzConsistent,
} from '../../../scripts/reference/50-registry.mjs';
import { compact, hqBbox, project } from '../../../scripts/reference/70-joins.mjs';
import { COUNT_GATES, countRegistry, registryGates } from '../../../scripts/reference/90-validate.mjs';
import { assignNationId, hasNamePlaceholder } from '../../../site/static/js/data/ids.js';

const SCHEMA = 'https://atniclimate.github.io/pnw-tribal-dashboard/schemas/';
/** @param {string} rel */
const readJson = (rel) => JSON.parse(readFileSync(path.join(ROOT, rel), 'utf8'));
/** @param {string} rel */
const readYaml = (rel) => /** @type {any} */ (loadYaml(readFileSync(path.join(ROOT, rel), 'utf8'), { schema: CORE_SCHEMA }));

const nationDir = path.join(ROOT, 'site', 'data', 'registry', 'nations');
const delivered = existsSync(nationDir) && readdirSync(nationDir).some((n) => n.endsWith('.json'));
const SKIP = delivered ? false : 'lane:L5 registry not built yet';
/** @type {Record<string, any>[]} */
const records = delivered ? readdirSync(nationDir).filter((n) => n.endsWith('.json')).sort().map((n) => readJson(`site/data/registry/nations/${n}`)) : [];

// ---------------------------------------------------------------------------------------------
// Parsers (pure)
// ---------------------------------------------------------------------------------------------

test('L5: Federal Register entries decode entities, fold whitespace, and split sections', () => {
  const xml = `<P>Contiguous</P><FP SOURCE="FP-1">Lummi Tribe of the Lummi Reservation</FP>
    <FP SOURCE="FP-1">Central Council of the Tlingit &amp; Haida
      Indian Tribes</FP><HD SOURCE="HD1">Native Entities Within the State of Alaska Recognized</HD>
    <FP SOURCE="FP-1">Sitka Tribe of Alaska</FP>`;
  const e = parseFederalRegister(xml);
  assert.deepEqual(e.map((x) => x.raw), ['Lummi Tribe of the Lummi Reservation', 'Central Council of the Tlingit & Haida Indian Tribes', 'Sitka Tribe of Alaska']);
  assert.deepEqual(e.map((x) => x.section), ['contiguous', 'contiguous', 'alaska']);
  assert.equal(decodeEntities('A &amp; B &#8212; &lt;'), 'A & B \u2014 <');
});

test('L5: annotations are removed from names and parentheticals that belong to the name are kept', () => {
  assert.deepEqual(splitFrEntry('PuliklaTribe of Yurok People (previously listed as Resighini Rancheria, California)'),
    { name: 'PuliklaTribe of Yurok People', annotations: ['previously listed as Resighini Rancheria, California'], former: ['Resighini Rancheria, California'] });
  assert.equal(splitFrEntry('Pit River Tribe, California (includes XL Ranch, Big Bend, Likely, Lookout, Montgomery Creek, and Roaring Creek Rancherias)').name, 'Pit River Tribe, California');
  assert.equal(splitFrEntry('Chilkat Indian Village (Klukwan)').name, 'Chilkat Indian Village (Klukwan)');
  assert.equal(splitFrEntry('The Muscogee (Creek) Nation').name, 'The Muscogee (Creek) Nation');
  assert.equal(splitFrEntry('Arctic Village (See Native Village of Venetie Tribal Government)').name, 'Arctic Village');
  assert.equal(splitFrEntry('Lummi Tribe of the Lummi Reservation').annotations.length, 0);
});

test('L5: name normalization folds case, marks, ampersands, and the ISC placeholder', () => {
  assert.equal(normName('Central Council of the Tlingit & Haida Indian Tribes'), normName('central council of the Tlingit and Haida Indian Tribes'));
  assert.equal(normName('?Akisq\'nuk First Nation'), 'akisq nuk first nation');
  assert.equal(normName('K\u2019\u00F3moks First Nation'), 'k omoks first nation');
  assert.equal(normName(null), '');
});

test('L5: the person-field allowlist excludes every deny-listed key', () => {
  for (const k of PERSON_KEYS) assert.ok(!TLD_ALLOW.includes(k), `${k} must not be allowlisted`);
  for (const k of ['email', 'phone', 'physicaladdress', 'zipcode']) assert.ok(!TLD_ALLOW.includes(k), `${k} must not be allowlisted`);
  assert.ok(TLD_ALLOW.includes('latitude') && TLD_ALLOW.includes('longitude') && TLD_ALLOW.includes('tribefullname'));
});

test('L5: point in polygon honors holes and distance to the outline is in kilometres', () => {
  const square = { type: 'Polygon', coordinates: [[[0, 0], [2, 0], [2, 2], [0, 2], [0, 0]], [[0.5, 0.5], [1.5, 0.5], [1.5, 1.5], [0.5, 1.5], [0.5, 0.5]]] };
  assert.equal(pointInGeometry(0.25, 0.25, square), true);
  assert.equal(pointInGeometry(1, 1, square), false);
  assert.equal(pointInGeometry(3, 3, square), false);
  const km = distanceToOutlineKm(2.1, 1, square);
  assert.ok(km > 10 && km < 12.5, `0.1 degrees of longitude at the equator is about 11 km, got ${km}`);
  assert.ok(BC_TOLERANCE_KM >= 5);
});

test('L5: headquarters bbox is ten kilometres each way', () => {
  const [w, s, e, n] = hqBbox(48, -122);
  assert.ok(Math.abs((n - s) * 110.57 - 20 * 1.0 * (110.57 / 111.32)) < 0.5);
  assert.ok(w < -122 && e > -122 && s < 48 && n > 48);
});

test('L5: ids are minted from the lock and never re-derived', () => {
  const lock = { schema: /** @type {const} */ ('cthd.ids-lock/1'), entries: [{ id: 'us-wa-lummi-tribe-of-the-lummi-reservation', key: 'bia-tld:Lummi', name: 'Lummi', mintedAt: '2026-10-05' }] };
  const again = assignNationId(lock, { key: 'bia-tld:Lummi', name: 'A Different Name', country: 'US', state: 'wa' }, '2026-10-06');
  assert.equal(again.id, 'us-wa-lummi-tribe-of-the-lummi-reservation');
  assert.equal(again.minted, false);
  assert.throws(() => assignNationId(lock, { key: 'bia-tld:Other', name: 'Lummi Tribe of the Lummi Reservation', country: 'US', state: 'wa' }, '2026-10-06'), /collides/);
});

// ---------------------------------------------------------------------------------------------
// Gates with seeded violations
// ---------------------------------------------------------------------------------------------

/** @param {string} id @param {Record<string, any>} [over] */
const rec = (id, over = {}) => ({
  id, name: `Name of ${id}`, aliases: [], flags: [], country: id.startsWith('ca-') ? 'CA' : 'US', region: id.startsWith('ca-') ? 'bc' : 'wa', kind: id.startsWith('ca-') ? 'first-nation' : 'us-federally-recognized-tribe',
  jurisdictions: [id.startsWith('ca-') ? 'BC' : 'WA'],
  nameSource: { url: 'https://example.org/' }, hq: { sourceId: 'bia-tld' }, timeZone: id.startsWith('ca-') ? 'America/Vancouver' : 'America/Los_Angeles', review: { status: 'draft' }, ...over,
});

test('L5: the time zone gate fails a record whose zone is across the border from its jurisdiction', () => {
  const lock = { entries: ['us-ak-a', 'us-wa-b', 'ca-fn-1', 'ca-fn-2', 'us-ak-c'].map((id, i) => ({ id, key: `k${i}` })) };
  const f = registryGates({
    records: [
      rec('us-ak-a', { region: 'ak-se', jurisdictions: ['AK-SE'], timeZone: 'America/Vancouver' }),
      rec('us-ak-c', { region: 'ak-se', jurisdictions: ['AK-SE'], timeZone: 'America/Sitka', timeZoneSource: 'override', flags: ['tz-needs-confirmation'] }),
      rec('us-wa-b'),
      rec('ca-fn-1', { timeZone: 'America/Los_Angeles' }),
      rec('ca-fn-2', { timeZone: 'America/Fort_Nelson', flags: ['tz-needs-confirmation'] }),
    ], lock, redirects: { redirects: {} }, ratified: false,
  });
  const tz = f.problems.filter((p) => /not consistent with jurisdiction/.test(p));
  assert.equal(tz.length, 2);
  assert.match(tz.join('\n'), /us-ak-a: time zone America\/Vancouver is not consistent with jurisdiction AK-SE/);
  assert.match(tz.join('\n'), /ca-fn-1: time zone America\/Los_Angeles is not consistent with jurisdiction BC/);
  assert.ok(tzConsistent(['AK-SE'], 'America/Sitka') && tzConsistent(['BC'], 'America/Creston') && !tzConsistent(['BC'], 'America/Los_Angeles') && !tzConsistent([], 'America/Sitka'));
});

test('L5: gates flag duplicate ids, ids missing from the lock, vanished ids, and unflagged placeholder names', () => {
  const lock = { entries: [{ id: 'us-wa-a', key: 'k1' }, { id: 'us-wa-b', key: 'k2' }, { id: 'us-wa-gone', key: 'k3' }] };
  const f = registryGates({
    records: [rec('us-wa-a'), rec('us-wa-a'), rec('us-wa-c', { name: '?aqam' })], lock, redirects: { redirects: {} }, previousIds: ['us-wa-a', 'us-wa-lost'], ratified: true,
  });
  const text = f.problems.join('\n');
  assert.match(text, /duplicate Nation id us-wa-a/);
  assert.match(text, /us-wa-c is not in ids\.lock\.json/);
  assert.match(text, /lock id us-wa-gone has no record and no redirect/);
  assert.match(text, /id us-wa-lost of the previous registry disappeared/);
  assert.match(text, /without the name-orthography-needs-nation-source flag/);
  assert.match(text, /count gate/);
});

test('L5: a reviewed name with a placeholder fails; a redirect excuses a vanished id; unratified count drift only warns', () => {
  const lock = { entries: [{ id: 'us-wa-a', key: 'k1' }, { id: 'us-wa-old', key: 'k2' }] };
  const f = registryGates({
    records: [rec('us-wa-a', { name: 'Yaqit ?a knuqli it', review: { status: 'reviewed' }, flags: ['name-orthography-needs-nation-source'] })], lock,
    redirects: { redirects: { 'us-wa-old': { to: 'us-wa-a', since: '2026-10-05', reason: 'rename' } } }, ratified: false,
    bc: { nrcanPolygons: 100, nrcanJoined: 90 },
  });
  assert.ok(f.problems.some((p) => /cannot be reviewed/.test(p)));
  assert.ok(f.problems.some((p) => /90 of 100 \(90\.0 percent/.test(p)));
  assert.ok(!f.problems.some((p) => /lock id us-wa-old/.test(p)));
  assert.ok(f.warnings.some((w) => /count gate/.test(w)));
  assert.ok(f.warnings.some((w) => /wave 2 joins pending/.test(w)));
});

test('L5: a reviewed record needs a review date, a reviewed headquarters, and no flag', () => {
  const lock = { entries: ['us-wa-a', 'us-wa-b', 'us-wa-c'].map((id, i) => ({ id, key: `k${i}` })) };
  const f = registryGates({
    records: [
      rec('us-wa-a', { review: { status: 'reviewed', reviewedAt: '2026-10-05' }, hq: { sourceId: 'bia-tld', reviewed: true } }),
      rec('us-wa-b', { review: { status: 'reviewed', reviewedAt: null }, hq: { sourceId: 'bia-tld', reviewed: false } }),
      rec('us-wa-c', { review: { status: 'reviewed', reviewedAt: '2026-10-05' }, hq: { sourceId: 'bia-tld', reviewed: true }, flags: ['tz-needs-confirmation'] }),
    ], lock, redirects: { redirects: {} }, ratified: true,
  });
  const text = f.problems.join('\n');
  assert.doesNotMatch(text, /us-wa-a: review/);
  assert.match(text, /us-wa-b: review\.status is reviewed without review\.reviewedAt/);
  assert.match(text, /us-wa-b: review\.status is reviewed but hq\.reviewed is not true/);
  assert.match(text, /us-wa-c: review\.status is reviewed while the record carries tz-needs-confirmation/);
  assert.ok(f.notes.some((n) => /review status: 3 reviewed, 0 draft/.test(n)));
});

test('L5: the approval reviews only unflagged, unheld records minted on or before its date', () => {
  const mk = (/** @type {string} */ id, /** @type {string[]} */ flags = []) => ({ id, flags, hq: { reviewed: false }, review: { status: 'draft', reviewedAt: null, notes: 'Draft built by scripts/reference/50-registry.mjs. Footprint basis: state WA.' } });
  const recs = [mk('us-wa-a'), mk('us-wa-held'), mk('us-wa-flag', ['tz-needs-confirmation']), mk('us-wa-new')];
  const rows = [
    { nationId: 'us-wa-a', matchMethod: 'code', reviewed: false }, { nationId: 'us-wa-a', matchMethod: 'name-exact', reviewed: false },
    { nationId: 'us-wa-a', matchMethod: 'name-reviewed', reviewed: false }, { nationId: 'us-wa-held', matchMethod: 'code', reviewed: false },
  ];
  const lock = { entries: [{ id: 'us-wa-a', mintedAt: '2026-10-05' }, { id: 'us-wa-held', mintedAt: '2026-10-05' }, { id: 'us-wa-flag', mintedAt: '2026-10-05' }, { id: 'us-wa-new', mintedAt: '2026-11-01' }] };
  const approval = readApproval({ approvedOn: '2026-10-05', approver: 'maintainer', decision: 'd.md', holds: [{ nationId: 'us-wa-held', reason: 'Source pending.' }] });
  const rep = applyApproval(recs, rows, lock, approval);
  assert.deepEqual([rep.reviewed, rep.draft, rep.held, rep.flagged, rep.newer], [1, 3, ['us-wa-held'], ['us-wa-flag'], ['us-wa-new']]);
  assert.deepEqual(recs[0]?.review, { status: 'reviewed', reviewedAt: '2026-10-05', notes: 'Approved with amendments 10/05/2026 (d.md; approver: maintainer). Footprint basis: state WA.' });
  assert.equal(recs[0]?.hq.reviewed, true);
  assert.equal(recs[1]?.review.status, 'draft');
  assert.match(String(recs[1]?.review.notes), /^Held as draft by the approval of 10\/05\/2026 .*Source pending\./);
  assert.deepEqual(rows.map((r) => r.reviewed), [true, true, false, false]);
  assert.equal(readApproval(null), null);
  assert.throws(() => readApproval({ approvedOn: '10/05/2026', approver: 'maintainer', decision: 'd.md' }), /approvedOn/);
  assert.throws(() => readApproval({ approvedOn: '2026-10-05', approver: 'maintainer', decision: 'd.md', extra: 1 }), /unknown keys/);
});

test('L5: count gates read the blueprint 6.2 ranges (U.S. outside Alaska 75 to 95 since 10/05/2026)', () => {
  assert.deepEqual(COUNT_GATES.usOutsideAlaska, { min: 75, max: 95 });
  assert.deepEqual(COUNT_GATES.southeastAlaska, { min: 15, max: 25 });
  assert.deepEqual(COUNT_GATES.britishColumbia, { min: 195, max: 210 });
  assert.deepEqual(countRegistry([rec('us-wa-a'), rec('us-ak-b', { region: 'ak-se' }), rec('ca-fn-1')]), { total: 3, us: 2, usOutsideAlaska: 1, southeastAlaska: 1, britishColumbia: 1 });
});

test('L5: projection sets the headquarters sample and bbox and never invents a join', () => {
  const draft = { generatedAt: '2026-10-04T00:00:00Z', records: [{ ...rec('us-wa-a'), hq: { lat: 48.5, lon: -122.5 }, boundary: { status: 'point-only' }, preferredName: null, jurisdictions: ['WA'], nws: null, eccc: null, gauges: [] }] };
  const out = project(draft, { redirects: {} });
  assert.deepEqual(out.records[0]?.samples, [[48.5, -122.5]]);
  assert.equal(out.records[0]?.nws, null);
  assert.deepEqual(out.hqPoints.features[0]?.geometry.coordinates, [-122.5, 48.5]);
  assert.equal(out.index.nations[0]?.hasBoundary, false);
  assert.deepEqual(out.hqPoints.features[0]?.properties, { nationId: 'us-wa-a' });
  assert.equal(compact(out.hqPoints).includes('\n  '), false, 'the headquarters layer is written without indentation');
});

test('L5: Census legal classes are G2101 reservations and G2102 off-reservation trust land', () => {
  assert.deepEqual([...CENSUS_LEGAL_MTFCC], ['G2101', 'G2102']);
});

// ---------------------------------------------------------------------------------------------
// The committed registry
// ---------------------------------------------------------------------------------------------

test('L5: every record is schema-valid with name source, headquarters provenance, time zone, and review status', { skip: SKIP }, async () => {
  const ajv = await loadAjv();
  const v = ajv.getSchema(`${SCHEMA}nation.schema.json`);
  assert.ok(v);
  for (const r of records) {
    assert.ok(v(r), `${r.id}: ${JSON.stringify(v.errors)}`);
    assert.ok(r.nameSource.url.startsWith('https://') && r.nameSource.citation);
    assert.ok(r.hq.sourceId && r.hq.sourceRecordId && r.hq.retrievedAt);
    assert.match(r.timeZone, /^(America|Pacific)\//);
    // Approved with amendments 10/05/2026 (packet-amendments-2026-10-05.md, Section F): 302 reviewed, ca-fn-709 held as draft.
    if (r.id === 'ca-fn-709') {
      assert.equal(r.review.status, 'draft', 'ca-fn-709 stays draft until its spelling has a Nation source');
      assert.equal(r.hq.reviewed, false);
    } else {
      assert.equal(r.review.status, 'reviewed', r.id);
      assert.equal(r.review.reviewedAt, '2026-10-05', r.id);
      assert.match(r.review.notes, /^Approved with amendments 10\/05\/2026 \(packet-amendments-2026-10-05\.md; approver: maintainer\)\./, r.id);
      assert.equal(r.hq.reviewed, true, r.id);
    }
  }
  assert.equal(records.filter((r) => r.review.status === 'reviewed').length, 302);
});

test('L5: counts are within the gates that apply and reconciled to the source counts', { skip: SKIP }, () => {
  const c = countRegistry(records);
  assert.ok(c.southeastAlaska >= COUNT_GATES.southeastAlaska.min && c.southeastAlaska <= COUNT_GATES.southeastAlaska.max, `Southeast Alaska ${c.southeastAlaska}`);
  assert.ok(c.britishColumbia >= COUNT_GATES.britishColumbia.min && c.britishColumbia <= COUNT_GATES.britishColumbia.max, `British Columbia ${c.britishColumbia}`);
  // The footprint was ratified on 10/05/2026 with the gate of 75 to 95 (packet amendments, Section E).
  assert.ok(c.usOutsideAlaska >= COUNT_GATES.usOutsideAlaska.min && c.usOutsideAlaska <= COUNT_GATES.usOutsideAlaska.max, `U.S. outside Alaska ${c.usOutsideAlaska}`);
  assert.deepEqual([c.usOutsideAlaska, c.southeastAlaska, c.britishColumbia], [83, 19, 201]);
  const draft = readJson('data/registry/draft-registry.json');
  assert.equal(draft.records.length, records.length);
  assert.equal(draft.stats.iscLocationRows, 638);
  assert.ok(draft.stats.tldTribes >= c.us, 'no more U.S. Nations than Directory Tribes');
  const index = readJson('site/data/registry/nations-index.json');
  assert.equal(index.nations.length, records.length);
  assert.equal(readJson('site/data/geo/hq-points.json').features.length, records.length);
});

test('L5: zero names with ? or U+FFFD, and the names.yaml corrections carry the exact code points', { skip: SKIP }, () => {
  const flagged = records.filter((r) => hasNamePlaceholder(r.name));
  assert.deepEqual(flagged.map((r) => r.id), [], 'every ISC placeholder is corrected through names.yaml (packet amendments, Section C)');
  for (const r of records) assert.equal(r.flags.includes('name-orthography-needs-nation-source'), false, r.id);
  const byId = new Map(records.map((r) => [r.id, r]));
  // U+0294 glottal stop, U+0313 combining comma above, U+00B7, U+2C61, and U+2019, in NFC.
  for (const [id, name] of [
    ['ca-fn-602', 'ʔaq̓am'],
    ['ca-fn-603', 'Yaq̓it ʔa·knuqⱡi’it First Nation'],
    ['ca-fn-604', 'ʔAkisq̓nuk First Nation'],
    ['ca-fn-709', 'ʔEsdilagh First Nation'],
    ['us-ca-puliklatribe-of-yurok-people', 'Pulikla Tribe of Yurok People'],
  ]) {
    const r = byId.get(id);
    assert.equal(r?.name, name, id);
    assert.equal(r?.name, String(r?.name).normalize('NFC'), id);
    assert.equal(r?.nameSource.kind, 'names-override', id);
  }
  assert.ok(byId.get('us-ca-puliklatribe-of-yurok-people')?.aliases.includes('PuliklaTribe of Yurok People'), 'the Federal Register form stays a search alias');
});

test('L5: no person keys anywhere in the registry files', { skip: SKIP }, () => {
  for (const rel of ['data/registry/boundaries-build.json', 'data/registry/joins-build.json', 'data/registry/eccc-citypage-sites.json', 'data/registry/draft-registry.json', 'data/registry/crosswalk-us.json', 'data/registry/crosswalk-bc.json', 'data/registry/ids.lock.json', 'site/data/registry/nations-index.json']) {
    assert.deepEqual(personKeyHits(readJson(rel)), [], rel);
  }
  for (const r of records) assert.deepEqual(personKeyHits(r), [], r.id);
  for (const rel of ['data/registry/scope.yaml', 'data/registry/overrides.yaml', 'data/registry/inputs.yaml', 'data/registry/names.yaml', 'data/registry/review.yaml']) assert.deepEqual(personKeyHits(readYaml(rel)), [], rel);
});

test('L5: id stability: every id is in the lock, ids are unique, First Nation ids follow the band number', { skip: SKIP }, () => {
  const lock = readJson('data/registry/ids.lock.json');
  const byId = new Map(lock.entries.map((/** @type {any} */ e) => [e.id, e]));
  assert.equal(byId.size, lock.entries.length, 'lock ids are unique');
  assert.equal(new Set(lock.entries.map((/** @type {any} */ e) => e.key)).size, lock.entries.length, 'lock keys are unique');
  assert.equal(new Set(records.map((r) => r.id)).size, records.length);
  for (const r of records) {
    assert.ok(byId.has(r.id), `${r.id} is not in the lock`);
    if (r.country === 'CA') assert.equal(r.id, `ca-fn-${r.isc.bandNumber}`);
    else assert.match(r.id, /^us-(wa|or|id|ca|mt|nv|ak)-/);
  }
  for (const e of lock.entries) assert.ok(records.some((r) => r.id === e.id), `lock id ${e.id} has no record (needs a redirect)`);
  const redirects = readJson('data/registry/id-redirects.json');
  assert.equal(redirects.schema, 'cthd.id-redirects/1');
});

test('L5: crosswalk rows point at real Nations, carry a method, and only code and name-exact rows of reviewed Nations are reviewed', { skip: SKIP }, () => {
  const ids = new Set(records.map((r) => r.id));
  const reviewed = new Set(records.filter((r) => r.review.status === 'reviewed').map((r) => r.id));
  for (const f of ['crosswalk-us', 'crosswalk-bc']) {
    const cw = readJson(`data/registry/${f}.json`);
    assert.ok(cw.rows.length > 0);
    for (const row of cw.rows) {
      assert.ok(ids.has(row.nationId), `${f}: ${row.nationId}`);
      assert.equal(row.reviewed, reviewed.has(row.nationId) && ['code', 'name-exact'].includes(row.matchMethod), `${f}: ${row.nationId} ${row.sourceKey}`);
      assert.ok(['code', 'name-exact', 'name-reviewed', 'manual'].includes(row.matchMethod));
    }
  }
  const bc = readJson('data/registry/crosswalk-bc.json').rows.filter((/** @type {any} */ r) => r.sourceId === 'nrcan-aboriginal-lands-bc');
    // Some reserves are held by more than one band, so a polygon can appear in more than one row.
  assert.ok(new Set(bc.map((/** @type {any} */ r) => r.sourceKey)).size >= 0.95 * 1602);
});

test('L5: scope, names, and overrides name Nations that exist; pins carry SHA-256 values', { skip: SKIP }, async () => {
  const ids = new Set(records.map((r) => r.id));
  for (const o of readYaml('data/registry/overrides.yaml')) assert.ok(ids.has(o.nationId), o.nationId);
  if (existsSync(path.join(ROOT, 'data/registry/names.yaml'))) for (const n of readYaml('data/registry/names.yaml')) assert.ok(ids.has(n.nationId), n.nationId);
  const ajv = await loadAjv();
  for (const [schema, rel] of [['registry-scope', 'data/registry/scope.yaml'], ['registry-overrides', 'data/registry/overrides.yaml'], ['pipeline-inputs', 'data/registry/inputs.yaml'], ['ids-lock', 'data/registry/ids.lock.json'], ['crosswalk', 'data/registry/crosswalk-us.json'], ['crosswalk', 'data/registry/crosswalk-bc.json'], ['nations-index', 'site/data/registry/nations-index.json'], ['hq-points', 'site/data/geo/hq-points.json']]) {
    const v = ajv.getSchema(`${SCHEMA}${schema}.schema.json`);
    assert.ok(v, String(schema));
    const data = String(rel).endsWith('.json') ? readJson(String(rel)) : readYaml(String(rel));
    assert.ok(v(data), `${rel}: ${JSON.stringify(v.errors?.slice(0, 3))}`);
  }
  for (const p of readYaml('data/registry/inputs.yaml').inputs) assert.match(p.sha256, /^[0-9a-f]{64}$/);
});

test('L5: source records for the registry exist and name build-time access', { skip: SKIP }, async () => {
  const ajv = await loadAjv();
  const v = ajv.getSchema(`${SCHEMA}source.schema.json`);
  assert.ok(v);
  for (const id of ['bia-tld', 'bia-anv', 'bia-tribal-leaders-directory', 'bia-alaska-native-villages', 'bia-lar', 'census-aiannh-2025', 'isc-first-nations', 'nrcan-aboriginal-lands-bc', 'federal-register-tribes', 'cthd-registry']) {
    const s = readYaml(`data/sources/${id}.yaml`);
    assert.equal(s.id, id);
    assert.ok(v(s), `${id}: ${JSON.stringify(v.errors?.slice(0, 3))}`);
    assert.equal(s.access.mode, 'build');
  }
  const hqIds = new Set(records.flatMap((r) => [r.hq.sourceId, r.nameSource.kind === 'federal-register' ? 'federal-register-tribes' : '']).filter(Boolean));
  for (const id of hqIds) assert.ok(existsSync(path.join(ROOT, `data/sources/${id}.yaml`)), `${id} is registered`);
});

test('L5: headquarters points are inside plausible ranges for the footprint', { skip: SKIP }, () => {
  for (const r of records) {
    assert.ok(r.hq.lat > 38 && r.hq.lat < 61, `${r.id} lat ${r.hq.lat}`);
    assert.ok(r.hq.lon < -108 && r.hq.lon > -141, `${r.id} lon ${r.hq.lon}`);
    // A point-only Nation's bbox is the headquarters plus ten kilometres; a Nation with polygons has the bbox of its land areas,
    // which can exclude an office that lies off the land (Elem, Guidiville, and Jamestown S'Klallam are examples; tested in boundaries.test.mjs).
    if (r.boundary.status === 'point-only') assert.ok(r.bbox[0] < r.hq.lon && r.bbox[2] > r.hq.lon && r.bbox[1] < r.hq.lat && r.bbox[3] > r.hq.lat);
    else assert.ok(r.bbox[0] > -141 && r.bbox[2] < -108 && r.bbox[1] > 38 && r.bbox[3] < 61, r.id);
    assert.deepEqual(r.samples[0], [r.hq.lat, r.hq.lon]);
  }
});

test('L5: every committed record has a time zone consistent with its jurisdiction, and the twenty ratified overrides clear every flag', { skip: SKIP }, () => {
  for (const r of records) assert.ok(tzConsistent(r.jurisdictions, r.timeZone), `${r.id}: ${r.timeZone} for ${r.jurisdictions[0]}`);
  const byId = new Map(records.map((r) => [r.id, r]));
  // Packet amendments 10/05/2026, Section A.2: three changes, five ratified corrections, twelve confirmations.
  const decided = [
    ['us-nv-shoshone-paiute-tribes-of-the-duck-valley-reservation-nevada', 'America/Denver'],
    ['us-nv-fort-mcdermitt-paiute-and-shoshone-tribes-of-the-fort-mcdermitt-indian', 'America/Los_Angeles'],
    ['us-ak-metlakatla-indian-community-annette-island-reserve', 'America/Metlakatla'],
    ['us-ak-petersburg-indian-association', 'America/Sitka'], ['us-ak-wrangell-cooperative-association', 'America/Sitka'],
    ['ca-fn-596', 'America/Vancouver'], ['ca-fn-598', 'America/Vancouver'], ['ca-fn-658', 'America/Vancouver'],
    ['ca-fn-542', 'America/Dawson_Creek'], ['ca-fn-545', 'America/Dawson_Creek'], ['ca-fn-546', 'America/Dawson_Creek'],
    ['ca-fn-547', 'America/Dawson_Creek'], ['ca-fn-548', 'America/Dawson_Creek'], ['ca-fn-544', 'America/Fort_Nelson'], ['ca-fn-543', 'America/Fort_Nelson'],
    ['ca-fn-602', 'America/Edmonton'], ['ca-fn-603', 'America/Edmonton'], ['ca-fn-604', 'America/Edmonton'], ['ca-fn-605', 'America/Edmonton'],
    ['ca-fn-606', 'America/Creston'],
  ];
  assert.equal(decided.length, 20);
  for (const [id, zone] of decided) {
    const r = byId.get(id);
    assert.equal(r?.timeZone, zone, id);
    assert.equal(r?.timeZoneSource, 'override', id);
  }
  assert.equal(records.filter((r) => r.timeZoneSource === 'override').length, 20);
  assert.deepEqual(records.filter((r) => r.flags.includes('tz-needs-confirmation')).map((r) => r.id), []);
  const overrides = readYaml('data/registry/overrides.yaml').filter((/** @type {any} */ o) => o.field === 'timeZone');
  assert.equal(overrides.length, 20);
  for (const o of overrides) assert.match(o.reason, /^Ratified 10\/05\/2026 \(packet amendments\)\./, o.nationId);
});

test('L5: Census off-reservation trust land (G2102, GEOID suffix T) reaches the crosswalk', { skip: SKIP }, () => {
  const rows = readJson('data/registry/crosswalk-us.json').rows.filter((/** @type {any} */ r) => r.sourceId === 'census-aiannh-2025');
  const trust = rows.filter((/** @type {any} */ r) => r.sourceKey.endsWith('T'));
  assert.ok(trust.length >= 30, `expected many trust-land rows, got ${trust.length}`);
  for (const k of ['0760T', '3940T', '4690T', '3795T', '1365T']) assert.ok(trust.some((/** @type {any} */ r) => r.sourceKey === k), k);
  for (const r of trust) assert.match(r.notes, /MTFCC G2102, legal off-reservation trust land/);
  for (const r of rows) assert.match(r.sourceKey, /^[0-9]{4}[RT]$/);
  const roh = records.find((r) => r.id === 'us-ca-bear-river-band-of-the-rohnerville-rancheria-california');
  assert.equal(roh?.codes.censusGeoid, '3220T', 'a Nation whose only legal area is trust land carries it as the primary GEOID');
});

test('L5: the headquarters layer meets its 40,960-byte budget and carries only the promoted id', { skip: SKIP }, () => {
  const text = readFileSync(path.join(ROOT, 'site/data/geo/hq-points.json'), 'utf8');
  assert.ok(Buffer.byteLength(text) <= 40960, `${Buffer.byteLength(text)} bytes`);
  const j = JSON.parse(text);
  const ids = new Set(records.map((r) => r.id));
  for (const f of j.features) {
    assert.ok(ids.has(f.properties.nationId));
    assert.deepEqual(Object.keys(f.properties).filter((k) => k !== 'hasBoundary'), ['nationId']);
    const rec = records.find((r) => r.id === f.properties.nationId);
    assert.ok(Math.abs(f.geometry.coordinates[0] - /** @type {any} */ (rec).hq.lon) < 6e-5 && Math.abs(f.geometry.coordinates[1] - /** @type {any} */ (rec).hq.lat) < 6e-5);
  }
});

test('L5: loaders are implemented and read the committed registry paths', () => {
  const src = readFileSync(path.join(ROOT, 'site/static/js/data/nations.js'), 'utf8');
  // fetchLocal accepts only data/registry/... (core/net.js LOCAL_PATH); a bare registry/ path always fails.
  assert.match(src, /fetchLocal\('data\/registry\/nations-index\.json'/);
  assert.match(src, /fetchLocal\('data\/registry\/id-redirects\.json'/);
  assert.match(src, /fetchLocal\(`data\/registry\/nations\/\$\{current\}\.json`/);
  assert.doesNotMatch(src, /fetchLocal\(['`]registry\//);
  assert.match(src, /resolveNationId/);
});
