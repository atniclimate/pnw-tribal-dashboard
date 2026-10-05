// @ts-check
/**
 * Tests for site/static/js/data/ids.js (blueprint 5.2; L0 acceptance: diacritics, ? placeholders, and
 * renames through redirects).
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, test } from 'node:test';
import {
  MAX_SLUG_LENGTH, NATION_ID_PATTERN, assignNationId, firstNationId, hasNamePlaceholder, isNationId, mintContactId,
  mintPrefixedId, mintUsNationId, parseNationId, resolveNationId, slugify,
} from '../../../site/static/js/data/ids.js';

const ch = (/** @type {number} */ cp) => String.fromCodePoint(cp);
const GLOTTAL = ch(0x294);
const RIGHT_QUOTE = ch(0x2019);
const COMMA_ABOVE = ch(0x313);
const MACRON_BELOW = ch(0x331);
const REPLACEMENT = ch(0xfffd);

describe('slugify', () => {
  test('full formal names become kebab-case ASCII', () => {
    assert.equal(slugify('Lummi Tribe of the Lummi Reservation'), 'lummi-tribe-of-the-lummi-reservation');
    assert.equal(slugify('Confederated Tribes of the Coos, Lower Umpqua and Siuslaw Indians'), 'confederated-tribes-of-the-coos-lower-umpqua-and-siuslaw-indians');
    assert.equal(slugify('Shoshone-Bannock Tribes of the Fort Hall Reservation'), 'shoshone-bannock-tribes-of-the-fort-hall-reservation');
    assert.equal(slugify("Coeur D'Alene Tribe"), 'coeur-dalene-tribe');
    assert.equal(slugify('Pit River Tribe & Bands'), 'pit-river-tribe-and-bands');
  });

  test('diacritics and combining marks are removed', () => {
    assert.equal(slugify('Skwxwú7mesh'), 'skwxwu7mesh');
    assert.equal(slugify(`q${COMMA_ABOVE}ay${MACRON_BELOW}`), 'qay');
    assert.equal(slugify('Stá́tímc'), 'statimc');
    assert.equal(slugify(`x${ch(0x30c)}a${ch(0x142)}`), 'xal');
    assert.equal(slugify(`${ch(0x19b)}u${ch(0x2b7)}`), 'tluw');
    assert.equal(slugify('Tsilhqot’in'), 'tsilhqotin');
  });

  test('glottal stops, apostrophes, ? placeholders, and U+FFFD vanish', () => {
    assert.equal(slugify(`${GLOTTAL}aq${COMMA_ABOVE}am`), 'aqam');
    assert.equal(slugify('?aqam'), 'aqam');
    assert.equal(slugify(`Yaqit ?a${REPLACEMENT}knuqli${REPLACEMENT}it First Nation`), 'yaqit-aknuqliit-first-nation');
    assert.equal(slugify(`Tla${RIGHT_QUOTE}amin Nation`), 'tlaamin-nation');
    assert.equal(slugify("Tla'amin Nation"), slugify(`Tla${RIGHT_QUOTE}amin Nation`));
    assert.equal(slugify(`${GLOTTAL}Esdilagh First Nation`), slugify('?Esdilagh First Nation'));
  });

  test('digits used as letters are kept', () => {
    assert.equal(slugify('Sts’ail̓es 7'), 'stsailes-7');
  });

  test('long names are cut at a word boundary', () => {
    const s = slugify('Word '.repeat(40));
    assert.ok(s.length <= MAX_SLUG_LENGTH);
    assert.ok(!s.endsWith('-'));
    assert.match(s, /^word(-word)*$/);
  });

  test('a name with nothing usable throws', () => {
    assert.throws(() => slugify('???'), /cannot make a slug/);
    assert.throws(() => slugify(`${GLOTTAL}${REPLACEMENT}`), /cannot make a slug/);
  });
});

describe('Nation ids', () => {
  test('U.S. ids are us-<state>-<slug>; Southeast Alaska uses us-ak-', () => {
    assert.equal(mintUsNationId('WA', 'Lummi Tribe of the Lummi Reservation'), 'us-wa-lummi-tribe-of-the-lummi-reservation');
    assert.equal(mintUsNationId('ak', 'Organized Village of Kasaan'), 'us-ak-organized-village-of-kasaan');
    assert.throws(() => mintUsNationId('TX', 'Any Tribe'), /outside the registry footprint/);
  });

  test('First Nation ids come from the ISC band number', () => {
    assert.equal(firstNationId(602), 'ca-fn-602');
    assert.equal(firstNationId('555'), 'ca-fn-555');
    assert.throws(() => firstNationId(0));
    assert.throws(() => firstNationId('6O2'));
    assert.throws(() => firstNationId(1.5));
  });

  test('a First Nation id is immune to orthography fixes', () => {
    assert.equal(firstNationId(602), firstNationId(602));
    const lock = { schema: /** @type {const} */ ('cthd.ids-lock/1'), entries: [] };
    const a = assignNationId(lock, { key: 'isc:602', name: '?aqam', country: 'CA', bandNumber: 602 }, '2026-10-04');
    const b = assignNationId(a.lock, { key: 'isc:602', name: `${GLOTTAL}aq${COMMA_ABOVE}am`, country: 'CA', bandNumber: 602 }, '2026-11-01');
    assert.equal(a.id, b.id);
    assert.equal(b.minted, false);
  });

  test('isNationId and parseNationId', () => {
    assert.ok(isNationId('us-id-shoshone-bannock-tribes-of-the-fort-hall-reservation'));
    assert.ok(isNationId('ca-fn-602'));
    for (const bad of ['us-tx-x', 'ca-fn-0', 'ca-fn-0602', 'US-WA-LUMMI', 'us-wa-', 'us-wa-a--b', 'ct-wa-x', 42]) assert.ok(!isNationId(bad), String(bad));
    assert.deepEqual(parseNationId('ca-fn-602'), { country: 'CA', bandNumber: 602 });
    assert.deepEqual(parseNationId('us-or-confederated-tribes-of-siletz-indians-of-oregon'), { country: 'US', state: 'or', slug: 'confederated-tribes-of-siletz-indians-of-oregon' });
    assert.throws(() => parseNationId('nope'));
  });

  test('placeholders are detected for flagging', () => {
    assert.ok(hasNamePlaceholder('?aqam'));
    assert.ok(hasNamePlaceholder(`Yaqit ?a${REPLACEMENT}knuqli${REPLACEMENT}it`));
    assert.ok(!hasNamePlaceholder(`${GLOTTAL}aq${COMMA_ABOVE}am`));
  });
});

describe('the frozen id lock', () => {
  const empty = () => ({ schema: /** @type {const} */ ('cthd.ids-lock/1'), entries: [] });

  test('mints once, then returns the frozen id for the same key even after a rename', () => {
    const a = assignNationId(empty(), { key: 'bia-tld:Lummi Tribe of the Lummi Reservation', name: 'Lummi Tribe of the Lummi Reservation', country: 'US', state: 'wa' }, '2026-10-04');
    assert.equal(a.minted, true);
    assert.equal(a.lock.entries.length, 1);
    const again = assignNationId(a.lock, { key: 'bia-tld:Lummi Tribe of the Lummi Reservation', name: 'Lummi Nation', country: 'US', state: 'wa' }, '2027-01-01');
    assert.equal(again.id, a.id);
    assert.equal(again.minted, false);
    assert.equal(again.lock, a.lock);
  });

  test('is append-only and never mutates the input', () => {
    const lock = empty();
    const r = assignNationId(lock, { key: 'isc:555', name: 'Squamish', country: 'CA', bandNumber: 555 }, '2026-10-04');
    assert.equal(lock.entries.length, 0);
    assert.equal(r.lock.entries.length, 1);
  });

  test('a collision under a different key needs a person, not a suffix', () => {
    const a = assignNationId(empty(), { key: 'bia-tld:Example Tribe', name: 'Example Tribe', country: 'US', state: 'wa' }, '2026-10-04');
    assert.throws(() => assignNationId(a.lock, { key: 'federal-register:Example Tribe', name: 'Example Tribe', country: 'US', state: 'wa' }, '2026-10-04'), /collides/);
  });

  test('rejects a malformed date', () => {
    assert.throws(() => assignNationId(empty(), { key: 'isc:1', name: 'x', country: 'CA', bandNumber: 1 }, '10/04/2026'));
  });

  test('the registry fixture lock agrees with the algorithm', async () => {
    const lock = JSON.parse(await readFile(new URL('../../fixtures/registry/ids.lock.json', import.meta.url), 'utf8'));
    for (const e of lock.entries) {
      assert.match(e.id, NATION_ID_PATTERN);
      const expected = e.key.startsWith('isc:') ? firstNationId(Number(e.key.slice(4))) : mintUsNationId(e.id.slice(3, 5), e.name);
      assert.equal(e.id, expected);
    }
  });
});

describe('renames through id-redirects.json', () => {
  const redirects = {
    schema: /** @type {const} */ ('cthd.id-redirects/1'),
    redirects: {
      'us-wa-old-name-tribe': { to: 'us-wa-interim-name-tribe', since: '2027-01-01', reason: 'Federal Register name change' },
      'us-wa-interim-name-tribe': { to: 'us-wa-current-name-tribe', since: '2027-06-01', reason: 'Federal Register name change' },
      'us-or-loop-a': { to: 'us-or-loop-b', since: '2027-01-01', reason: 'test' },
      'us-or-loop-b': { to: 'us-or-loop-a', since: '2027-01-01', reason: 'test' },
      'us-or-bad-target': { to: 'not-an-id', since: '2027-01-01', reason: 'test' },
    },
  };

  test('follows a chain to the current id', () => {
    assert.deepEqual(resolveNationId('us-wa-old-name-tribe', redirects), {
      id: 'us-wa-current-name-tribe', redirected: true, chain: ['us-wa-old-name-tribe', 'us-wa-interim-name-tribe', 'us-wa-current-name-tribe'],
    });
  });

  test('passes unknown and current ids through unchanged', () => {
    assert.deepEqual(resolveNationId('ca-fn-602', redirects), { id: 'ca-fn-602', redirected: false, chain: ['ca-fn-602'] });
    assert.deepEqual(resolveNationId('ca-fn-602', null), { id: 'ca-fn-602', redirected: false, chain: ['ca-fn-602'] });
  });

  test('does not follow inherited object keys', () => {
    assert.equal(resolveNationId('toString', redirects).redirected, false);
  });

  test('throws on cycles and malformed targets', () => {
    assert.throws(() => resolveNationId('us-or-loop-a', redirects), /cycle/);
    assert.throws(() => resolveNationId('us-or-bad-target', redirects), /not a Nation id/);
  });
});

describe('curated record ids', () => {
  test('contact ids follow the blueprint example', () => {
    assert.equal(mintContactId(['wa', 'emd', 'alert-warning-center', '24-7']), 'ct-wa-emd-alert-warning-center-24-7');
    assert.equal(mintContactId(['ca-fn-602', 'Band Office', 'band-office']), 'ct-ca-fn-602-band-office-band-office');
  });

  test('prefixes are a closed set and parts are slugged', () => {
    assert.equal(mintPrefixedId('res', ['WA', '211']), 'res-wa-211');
    assert.equal(mintPrefixedId('decl', ['2025-12-11', 'Nooksack Indian Tribe', '1']), 'decl-2025-12-11-nooksack-indian-tribe-1');
    assert.throws(() => mintPrefixedId(/** @type {any} */ ('person'), ['x']));
    assert.throws(() => mintPrefixedId('ct', []));
  });
});
