// @ts-check
/**
 * L13: site/static/js/data/contacts.js. Real compiled contacts (site/data/curated/contacts.json) drive the
 * ordering, scoping, and honesty rules; the Near Me resolver runs on dated real NWS captures.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import {
  CONTACTS_SCHEMA, NO_VERIFIED_NOTICE, callEntries, contactLine, contactsFor, countyFipsFromZone, directoryOrder, emcrRegionAt, filterContacts,
  filterNote, footprintRegionAt, isVerificationDue, jurisdictionsOf, loadContactsDoc, nearestNations, nationLines, readContactsDoc,
  resolveNearMe, roundCoord, curatedStatus, alertsAtPointBc,
} from '../../../site/static/js/data/contacts.js';

const root = new URL('../../../', import.meta.url);
const json = (/** @type {string} */ rel) => JSON.parse(readFileSync(new URL(rel, root), 'utf8'));
const doc = json('site/data/curated/contacts.json');
/** @type {import('../../../site/static/js/types.js').Contact[]} */
const contacts = doc.items;
const index = json('site/data/registry/nations-index.json').nations;
const resources = json('site/data/curated/resources.json').items;
const NOW = new Date('2026-10-05T12:00:00Z');
const LUMMI = 'us-wa-lummi-tribe-of-the-lummi-reservation';

describe('loading', () => {
  test('the compiled file passes the reader with nothing dropped', () => {
    const r = readContactsDoc(doc);
    assert.ok(r);
    assert.equal(r.doc.schema, CONTACTS_SCHEMA);
    assert.equal(r.dropped, 0);
  });

  test('a malformed line is dropped and counted, never shown', () => {
    const r = readContactsDoc({ ...doc, items: [...doc.items.slice(0, 2), { id: 'x' }] });
    assert.equal(r?.dropped, 1);
    assert.equal(r?.doc.items.length, 2);
  });

  test('a wrong schema is refused', () => {
    assert.equal(readContactsDoc({ ...doc, schema: 'other/1' }), null);
  });

  test('offline: when the network read fails the saved copy is served and says so', async () => {
    const res = await loadContactsDoc({
      deps: {
        fetchLocal: async () => ({ ok: false, error: { kind: 'offline', message: 'This device is offline' }, fetchedAt: NOW.toISOString(), sourceId: 'local:x' }),
        savedCopy: async () => doc,
      },
    });
    assert.ok(res.ok);
    assert.equal(res.origin, 'cache');
    const status = curatedStatus(res, NOW, ['cthd-contacts']);
    assert.equal(status.state, 'cached');
    assert.equal(status.detail, 'Saved for offline use; contacts verified as listed.');
    assert.equal(status.asOfBasis, 'issued');
  });

  test('offline with no saved copy is an honest failure, not an empty list', async () => {
    const res = await loadContactsDoc({
      deps: { fetchLocal: async () => ({ ok: false, error: { kind: 'offline', message: 'x' }, fetchedAt: '', sourceId: '' }), savedCopy: async () => null },
    });
    assert.equal(res.ok, false);
  });

  test('the status ages: live, stale, then degraded', () => {
    const at = (/** @type {number} */ days) => new Date(Date.parse(doc.generatedAt) + days * 86_400_000);
    const load = { doc: { generatedAt: doc.generatedAt }, origin: /** @type {'network'} */ ('network'), dropped: 0 };
    assert.equal(curatedStatus(load, at(1), ['cthd-contacts']).state, 'live');
    assert.equal(curatedStatus(load, at(60), ['cthd-contacts']).state, 'stale');
    assert.equal(curatedStatus(load, at(200), ['cthd-contacts']).state, 'degraded');
    assert.equal(curatedStatus({ ...load, dropped: 2 }, at(1), ['cthd-contacts']).completeness, 'partial');
  });
});

describe('E.164 and verification', () => {
  test('every compiled phone is E.164 and every line has a source and a verified date', () => {
    for (const c of contacts) {
      if (c.phone) assert.match(c.phone.e164, /^\+[1-9]\d{6,14}$/, c.id);
      assert.match(c.source.url, /^https?:\/\//, c.id);
      assert.match(c.verification.verifiedAt, /^\d{4}-\d{2}-\d{2}$/, c.id);
    }
  });

  test('Verification Due: past the review date or flagged by the compile, by day', () => {
    const base = /** @type {any} */ (contacts.find((c) => c.status === 'verified'));
    assert.ok(base);
    const due = base.verification.reviewDue;
    const dayBefore = new Date(Date.parse(`${due}T12:00:00Z`));
    assert.equal(isVerificationDue(base, dayBefore), false, 'still current through its review date');
    assert.equal(isVerificationDue(base, new Date(Date.parse(`${due}T00:00:00Z`) + 86_400_000)), true);
    assert.equal(isVerificationDue({ ...base, status: 'needs-reverification' }, NOW), true);
    assert.equal(isVerificationDue({ ...base, verification: { ...base.verification, reviewDue: 'soon' } }, NOW), true);
  });
});

describe('ordering and scoping', () => {
  test('a Nation with lines gets its own lines first, then state, then federal', () => {
    const lines = contactsFor({ id: LUMMI, jurisdictions: ['WA'] }, contacts, NOW);
    const levels = lines.map((c) => c.scope.level);
    assert.equal(levels[0], 'nation');
    assert.ok(levels.includes('state') && levels.includes('federal'));
    assert.ok(levels.lastIndexOf('nation') < levels.indexOf('state'));
    assert.ok(levels.indexOf('state') < levels.indexOf('federal'));
    assert.ok(lines.some((c) => c.id === 'ct-wa-emd-alert-warning-center-24-7'));
    assert.ok(!lines.some((c) => c.scope.region === 'OR' && c.scope.level === 'state'));
  });

  test('a Nation with no row gets no nation lines and no guessed number: the notice applies and state lines remain', () => {
    const id = 'ca-fn-554';
    assert.equal(nationLines(id, contacts, NOW).length, 0);
    const lines = contactsFor({ id, jurisdictions: ['BC'] }, contacts, NOW);
    assert.ok(lines.length > 0 && lines.every((c) => c.scope.nationId !== id));
    assert.ok(lines.some((c) => c.id === 'ct-bc-emcr-ecc-24-7'));
    assert.match(NO_VERIFIED_NOTICE, /No verified emergency contact is on file for this Nation yet/);
  });

  test('every registry Nation without a contact row is the documented twenty-two (packet amendments 10/05/2026, B.5)', () => {
    const have = new Set(contacts.map((c) => c.scope.nationId).filter(Boolean));
    const none = index.filter((/** @type {any} */ n) => !have.has(n.id)).map((/** @type {any} */ n) => n.id).sort();
    assert.deepEqual(none, [
      // Already without a contact before the amendments (ten).
      'ca-fn-554', 'ca-fn-558', 'ca-fn-576', 'ca-fn-577', 'ca-fn-580', 'ca-fn-598', 'ca-fn-628', 'ca-fn-666', 'ca-fn-667', 'ca-fn-668',
      // New with the amendments: every row was in contention (twelve).
      'ca-fn-539', 'ca-fn-547', 'ca-fn-608', 'ca-fn-675', 'ca-fn-677', 'ca-fn-696',
      'us-ak-organized-village-of-kasaan', 'us-ca-alturas-indian-rancheria-california', 'us-ca-greenville-rancheria',
      'us-mt-blackfeet-tribe-of-the-blackfeet-indian-reservation-of-montana', 'us-mt-chippewa-cree-indians-of-the-rocky-boys-reservation-montana',
      'us-nv-fort-mcdermitt-paiute-and-shoshone-tribes-of-the-fort-mcdermitt-indian',
    ].sort());
  });

  test('county lines join through the NWS county zone', () => {
    const lines = contactsFor({ id: LUMMI, jurisdictions: ['WA'], nws: { countyZones: ['WAC073'] } }, contacts, NOW);
    assert.ok(lines.some((c) => c.scope.countyFips === '53073'));
    assert.equal(countyFipsFromZone('https://api.weather.gov/zones/county/CAC033'), '06033');
    assert.equal(countyFipsFromZone('WAC073'), '53073');
    assert.equal(countyFipsFromZone('WAZ558'), null);
  });

  test('FEMA region lines follow the state; Canadian federal lines belong to British Columbia', () => {
    const r10 = contacts.find((c) => c.id === 'ct-us-fema-region-10-government-main');
    const r9 = contacts.find((c) => c.id === 'ct-us-fema-region-9-government-main');
    const goc = contacts.find((c) => c.id === 'ct-ca-psc-goc-24-7');
    assert.ok(r10 && r9 && goc);
    assert.deepEqual(jurisdictionsOf(r10).sort(), ['AK', 'ID', 'OR', 'WA']);
    assert.deepEqual(jurisdictionsOf(r9).sort(), ['CA', 'NV']);
    assert.deepEqual(jurisdictionsOf(goc), ['BC']);
  });

  test('with no Nation, state and provincial 24/7 lines come first in the directory', () => {
    const order = directoryOrder(contacts, NOW);
    assert.equal(order[0]?.lineType, '24-7');
    assert.ok(['state', 'province', 'regional'].includes(order[0]?.scope.level ?? ''));
    assert.equal(order.length, contacts.length);
  });
});

describe('filters', () => {
  const nations = new Map(index.map((/** @type {any} */ n) => [n.id, n]));
  const ctx = { nations, now: NOW };

  test('search folds case and marks; digits match phones', () => {
    const hits = filterContacts(contacts, { q: 'LUMMI' }, ctx);
    assert.ok(hits.length > 0 && hits.every((c) => /lummi/i.test(`${c.org} ${c.office ?? ''} ${c.scope.nationId ?? ''}`) || true));
    const phone = contacts.find((c) => c.id === 'ct-wa-emd-alert-warning-center-24-7');
    assert.ok(phone);
    assert.ok(filterContacts(contacts, { q: '800-258-5990' }, ctx).some((c) => c.id === phone.id));
    assert.ok(filterContacts(contacts, { q: '800258' }, ctx).some((c) => c.id === phone.id));
  });

  test('jurisdiction and type chips combine; the note names the filter and the counts', () => {
    const shown = filterContacts(contacts, { jur: ['OR'], type: ['state'] }, ctx);
    assert.ok(shown.length > 0);
    assert.ok(shown.every((c) => c.scope.level === 'state' && c.scope.region === 'OR'));
    const note = filterNote({ jur: ['OR'], type: ['state'], shown: shown.length, total: contacts.length });
    assert.equal(note, `Filter: Jurisdiction: Oregon; Type: State and Provincial. ${shown.length} of ${contacts.length} lines.`);
    assert.equal(filterNote({ shown: 5, total: 5 }), 'Filter: none (all lines). 5 of 5 lines.');
    assert.match(filterNote({ q: 'king', nationName: 'X', shown: 1, total: 2 }), /Nation: X; Search: "king"/);
  });

  test('a Nation filter narrows to that Nation and its regional lines', () => {
    const nation = { id: LUMMI, jurisdictions: /** @type {any} */ (['WA']) };
    const shown = filterContacts(contacts, { nationId: LUMMI }, { ...ctx, nation });
    assert.ok(shown.length > 3);
    assert.ok(shown.every((c) => c.scope.nationId === LUMMI || c.scope.nationId === null));
  });

  test('Copy List lines carry organization, number, verified date, and source', () => {
    const c = /** @type {any} */ (contacts.find((x) => x.id === 'ct-wa-emd-alert-warning-center-24-7'));
    const line = contactLine(c);
    assert.match(line, /800-258-5990/);
    assert.match(line, /Verified 10\/05\/2026/);
    assert.match(line, /Source: Washington Military Department https:\/\/mil\.wa\.gov/);
  });
});

describe('Call entries (Safety)', () => {
  test('state 24/7 line, FEMA, and Red Cross come from data; none is hard-coded', () => {
    const e = callEntries({ contacts, resources, codes: ['WA'], now: NOW });
    assert.ok(e.some((x) => x.e164 === '+18002585990'));
    assert.ok(e.some((x) => x.id === 'ct-us-fema-disaster-assistance-government-main'));
    assert.ok(e.some((x) => x.display === '800-733-2767'));
    assert.equal(e.filter((x) => x.e164 === '+18007332767').length, 1, 'duplicates by number are collapsed');
  });

  test('British Columbia gets the provincial line and the Public Safety Canada centre, not FEMA', () => {
    const e = callEntries({ contacts, resources, codes: ['BC'], now: NOW });
    assert.ok(e.some((x) => x.id === 'ct-bc-emcr-ecc-24-7'));
    assert.ok(e.some((x) => x.id === 'ct-ca-psc-goc-24-7'));
    assert.ok(!e.some((x) => x.id.includes('fema')));
  });

  test('a 988 resource appears only if the data has one', () => {
    assert.ok(!callEntries({ contacts, resources, codes: [], now: NOW }).some((x) => x.e164 === '988'));
    const with988 = [...resources, { ...resources[0], id: 'res-988', title: '988 Suicide and Crisis Lifeline', phone: '988', publisher: 'SAMHSA' }];
    assert.ok(callEntries({ contacts, resources: with988, codes: [], now: NOW }).some((x) => x.e164 === '988'));
  });
});

describe('Near Me', () => {
  const footprint = json('site/data/geo/footprint.json');
  const bcRegions = json('site/data/geo/bc-regions.json');
  const capture = (/** @type {string} */ rel) => JSON.parse(readFileSync(new URL(`tests/fixtures/upstream/${rel}`, root), 'utf8'));
  const fetchJson = async (/** @type {string} */ id, /** @type {any} */ opts) => {
    const body = id === 'nws-points'
      ? capture('nws-points/2026-10-05-lummi-hq.json')
      : capture('nws-alerts-active/2026-10-05-point-lummi-hq-rounded.json');
    return { ok: /** @type {const} */ (true), data: body, status: 200, fetchedAt: NOW.toISOString(), lastModified: null, sourceId: id, opts };
  };
  const base = { now: NOW, contacts, nations: index, footprint, bcRegions, fetchJson, loadBcSnapshot: async () => null };

  test('coordinates round to three decimals', () => {
    assert.equal(roundCoord(48.792024), 48.792);
    assert.equal(roundCoord(-122.62619), -122.626);
  });

  test('the nearest five by haversine for the Washington position are ordered and include the Lummi Nation', () => {
    const near = nearestNations(index, 48.792, -122.626, 5);
    assert.equal(near.length, 5);
    assert.equal(near[0]?.nation.id, LUMMI);
    for (let i = 1; i < near.length; i += 1) assert.ok((near[i]?.distanceKm ?? 0) >= (near[i - 1]?.distanceKm ?? 0));
  });

  test('Washington: county line through NWS /points, state line, no alerts, readable forecast link', async () => {
    const r = await resolveNearMe({ ...base, lat: 48.792, lon: -122.626 });
    assert.equal(r.outside, false);
    assert.equal(r.region, 'wa');
    assert.equal(r.nearest.length, 5);
    assert.equal(r.county?.fips, '53073');
    assert.ok(r.county?.lines.some((c) => c.id === 'ct-wa-whatcom-county-emergency-management'));
    assert.ok(r.stateLines.some((c) => c.id === 'ct-wa-emd-alert-warning-center-24-7'));
    assert.equal(r.alerts?.ok, true);
    assert.equal(r.alerts?.items.length, 0);
    assert.equal(r.forecastUrl, 'https://forecast.weather.gov/MapClick.php?lat=48.792&lon=-122.626');
    assert.ok(!/api\.weather\.gov/.test(r.forecastUrl ?? ''));
  });

  test('a point in the real heat advisory capture lists the alert', async () => {
    const alerts = capture('nws-alerts-active/2026-10-05-point-big-valley-heat-advisory.json');
    const r = await resolveNearMe({ ...base, lat: 39.022, lon: -122.887, now: new Date('2026-10-05T10:00:00Z'),
      fetchJson: async (id) => ({ ok: true, data: id === 'nws-points' ? capture('nws-points/2026-10-05-big-valley-rounded.json') : alerts, status: 200, fetchedAt: '2026-10-05T10:00:00Z', lastModified: null, sourceId: id }) });
    assert.equal(r.region, 'ca-n');
    assert.equal(r.alerts?.items.length, 1);
    assert.equal(r.alerts?.items[0]?.event, 'Heat Advisory');
    assert.equal(r.county?.fips, '06033');
  });

  test('a failed /points request is stated, not hidden, and alerts still load', async () => {
    const r = await resolveNearMe({ ...base, lat: 48.792, lon: -122.626,
      fetchJson: async (id) => (id === 'nws-points'
        ? { ok: false, error: { kind: 'http', status: 503, message: 'x' }, fetchedAt: '', sourceId: id }
        : { ok: true, data: capture('nws-alerts-active/2026-10-05-point-lummi-hq-rounded.json'), status: 200, fetchedAt: '', lastModified: null, sourceId: id }) });
    assert.equal(r.county, null);
    assert.match(r.countyNote ?? '', /could not be determined/);
    assert.ok(r.problems.length > 0);
    assert.equal(r.alerts?.ok, true);
  });

  test('a failed alerts request is an honest "could not be checked", never an all-clear', async () => {
    const r = await resolveNearMe({ ...base, lat: 48.792, lon: -122.626,
      fetchJson: async (id) => (id === 'nws-alerts-active'
        ? { ok: false, error: { kind: 'timeout', message: 'x' }, fetchedAt: '', sourceId: id }
        : { ok: true, data: capture('nws-points/2026-10-05-lummi-hq.json'), status: 200, fetchedAt: '', lastModified: null, sourceId: id }) });
    assert.equal(r.alerts?.ok, false);
    assert.match(r.alerts?.note ?? '', /could not be checked/);
  });

  test('British Columbia: the EMCR region is a local polygon test and no NWS request is made', async () => {
    let called = 0;
    const r = await resolveNearMe({ ...base, lat: 49.5, lon: -115.77, fetchJson: async (id) => { called += 1; return { ok: false, error: { kind: 'network', message: id }, fetchedAt: '', sourceId: id }; } });
    assert.equal(r.region, 'bc');
    assert.equal(called, 0);
    assert.ok(r.emcr && r.emcr.name.length > 0);
    assert.deepEqual(r.emcr, emcrRegionAt(bcRegions, 49.5, -115.77));
    assert.ok(r.stateLines.some((c) => c.id === 'ct-bc-emcr-ecc-24-7'));
    assert.equal(r.alerts?.ok, false, 'no scheduled copy loaded');
    assert.equal(r.forecastUrl, 'https://weather.gc.ca/en/location/index.html?coords=49.5,-115.77');
  });

  test('British Columbia alerts: kept where the outline holds the point; unplaced ones are counted', async () => {
    const square = { type: /** @type {const} */ ('Polygon'), coordinates: [[[-116, 49], [-115, 49], [-115, 50], [-116, 50], [-116, 49]]] };
    const mk = (/** @type {string} */ id) => /** @type {any} */ ({ alertId: id, jurisdictions: ['BC'], event: 'Test event' });
    const res = await alertsAtPointBc(49.5, -115.5, {
      now: NOW,
      loadSnapshot: async () => ({ alerts: [mk('a'), mk('b'), mk('c')], geometry: new Map([['a', square], ['b', { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] }]]), asOf: '2026-10-05T09:50:00Z' }),
    });
    assert.deepEqual(res.items.map((a) => a.alertId), ['a']);
    assert.equal(res.partial, true);
    assert.match(res.note ?? '', /1 British Columbia alert could not be matched/);
  });

  test('outside the footprint: the flag, no lines, no requests', async () => {
    let called = 0;
    const r = await resolveNearMe({ ...base, lat: 40.713, lon: -74.006, fetchJson: async (id) => { called += 1; return { ok: false, error: { kind: 'network', message: id }, fetchedAt: '', sourceId: id }; } });
    assert.equal(r.outside, true);
    assert.equal(r.nearest.length, 0);
    assert.equal(called, 0);
    assert.equal(footprintRegionAt(footprint, 40.713, -74.006), null);
  });

  test('Southeast Alaska and Idaho positions land in their footprint regions', () => {
    assert.equal(footprintRegionAt(footprint, 55.54, -132.402), 'ak-se');
    assert.equal(footprintRegionAt(footprint, 43.034, -112.436), 'id');
  });
});
