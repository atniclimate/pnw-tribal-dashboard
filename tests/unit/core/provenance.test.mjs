// @ts-check
/** core/provenance.js: the footer carries state, sources, the as-of stamp with its verb, detail, and checked age. */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { asOfLabel, renderProvenance } from '../../../site/static/js/core/provenance.js';
import { installFakeDom } from './helpers/fake-dom.mjs';
import { record } from './helpers/records.mjs';

/** @typedef {import('./helpers/fake-dom.mjs').FakeElement} FakeElement */

/** @type {ReturnType<typeof installFakeDom>} */
let dom;
beforeEach(() => { dom = installFakeDom(); });
afterEach(() => { dom.restore(); });

const NOW = new Date('2026-10-04T22:44:00Z');
/** @type {import('../../../site/static/js/types.js').StatusSnapshot} */
const LIVE = {
  state: 'live', asOf: '2026-10-04T22:42:00Z', asOfBasis: 'issued', sourceIds: ['nws-alerts-active', 'eccc-geomet-weather-alerts'],
  origin: 'direct', completeness: 'complete', checkedAt: '2026-10-04T22:43:00Z',
};
const SOURCES = [
  record({ id: 'nws-alerts-active', humanUrl: 'https://www.weather.gov/', attribution: 'National Weather Service' }),
  record({ id: 'eccc-geomet-weather-alerts', humanUrl: 'https://weather.gc.ca/', attribution: 'Environment and Climate Change Canada' }),
];

/** @returns {FakeElement} */
const footer = () => /** @type {FakeElement} */ (/** @type {unknown} */ (dom.document.createElement('footer')));

describe('asOfLabel', () => {
  test('one verb per basis', () => {
    assert.equal(asOfLabel('issued'), 'Issued as of');
    assert.equal(asOfLabel('observed'), 'Observed as of');
    assert.equal(asOfLabel('valid'), 'Valid as of');
    assert.equal(asOfLabel('model-run'), 'Model run');
    assert.equal(asOfLabel('retrieved'), 'Retrieved');
    assert.equal(asOfLabel(null), 'As of');
  });
});

describe('renderProvenance', () => {
  test('renders the house-style footer: pill, linked sources, stamp, checked age', () => {
    const f = footer();
    renderProvenance(/** @type {any} */ (f), LIVE, SOURCES, { timeZone: 'America/Los_Angeles', now: NOW });
    assert.equal(f.getAttribute('data-status'), 'live');
    assert.equal(f.getAttribute('data-source-ids'), 'nws-alerts-active eccc-geomet-weather-alerts');
    assert.ok(f.hasAttribute('data-provenance'));
    const pill = f.querySelector('.status-pill');
    assert.ok(pill?.matches('.status-pill'));
    assert.ok(pill?.className.includes('status-pill--live'));
    assert.equal(pill?.textContent, 'Live');
    assert.ok(pill?.querySelector('svg'), 'the pill has an icon so state never relies on color alone');
    const links = f.querySelectorAll('a');
    assert.deepEqual(links.map((a) => a.getAttribute('href')), ['https://www.weather.gov/', 'https://weather.gc.ca/']);
    assert.deepEqual(links.map((a) => a.textContent), ['National Weather Service', 'Environment and Climate Change Canada']);
    assert.match(f.querySelector('.provenance__src')?.textContent ?? '', /^Sources: /);
    const asof = f.querySelector('.provenance__asof');
    assert.equal(asof?.textContent, 'Issued as of 10/04/2026 3:42 PM PDT');
    assert.equal(asof?.querySelector('time')?.getAttribute('datetime'), '2026-10-04T22:42:00Z');
    assert.equal(f.querySelector('.provenance__checked')?.textContent, 'Checked 1 min ago');
  });

  test('the relative age never stands alone: its element carries the absolute stamp', () => {
    const f = footer();
    renderProvenance(/** @type {any} */ (f), LIVE, SOURCES, { timeZone: 'America/Los_Angeles', now: NOW });
    assert.equal(f.querySelector('.provenance__checked')?.querySelector('time')?.getAttribute('title'), '10/04/2026 3:43 PM PDT');
    assert.ok(f.querySelector('.provenance__asof')?.textContent?.includes('10/04/2026'));
  });

  test('one source reads "Source:"; an unregistered id is plain text, not a link', () => {
    const f = footer();
    renderProvenance(/** @type {any} */ (f), { ...LIVE, sourceIds: ['cthd-curated-declarations'] }, [], { now: NOW });
    assert.match(f.querySelector('.provenance__src')?.textContent ?? '', /^Source: cthd-curated-declarations$/);
    assert.equal(f.querySelectorAll('a').length, 0);
  });

  test('each of the five states renders its own pill label and class', () => {
    const labels = /** @type {const} */ ({ live: 'Live', cached: 'Saved on Device', stale: 'Stale', degraded: 'Degraded', unavailable: 'Unavailable' });
    for (const [state, label] of Object.entries(labels)) {
      const f = footer();
      const snap = state === 'unavailable' ? { ...LIVE, state, asOf: null, asOfBasis: null } : { ...LIVE, state };
      renderProvenance(/** @type {any} */ (f), /** @type {any} */ (snap), SOURCES, { now: NOW });
      assert.equal(f.getAttribute('data-status'), state);
      assert.equal(f.querySelector('.status-pill')?.textContent, label);
      assert.ok(f.querySelector('.status-pill')?.className.includes(`status-pill--${state}`));
    }
  });

  test('detail renders when present; an unavailable footer says no data time is available', () => {
    const f = footer();
    renderProvenance(/** @type {any} */ (f), { ...LIVE, state: 'unavailable', asOf: null, asOfBasis: null, detail: 'The National Weather Service could not be reached.' }, SOURCES, { now: NOW });
    assert.equal(f.querySelector('.provenance__detail')?.textContent, 'The National Weather Service could not be reached.');
    assert.equal(f.querySelector('.provenance__asof')?.textContent, 'No data time is available');
    assert.equal(f.querySelector('time')?.getAttribute('datetime'), LIVE.checkedAt, 'only the checked time remains');
  });

  test('re-rendering replaces the previous content rather than appending', () => {
    const f = footer();
    renderProvenance(/** @type {any} */ (f), LIVE, SOURCES, { now: NOW });
    const first = f.childNodes.length;
    renderProvenance(/** @type {any} */ (f), { ...LIVE, state: 'stale' }, SOURCES, { now: NOW });
    assert.equal(f.childNodes.length, first);
    assert.equal(f.querySelectorAll('.status-pill').length, 1);
    assert.equal(f.getAttribute('data-status'), 'stale');
  });

  test('source text is inert: markup in an attribution is text, and an unsafe human URL is dropped', () => {
    const f = footer();
    renderProvenance(/** @type {any} */ (f), { ...LIVE, sourceIds: ['x'] }, [record({ id: 'x', attribution: '<img src=x onerror=alert(1)>', humanUrl: /** @type {any} */ ('javascript:alert(1)') })], { now: NOW });
    assert.equal(f.querySelectorAll('img').length, 0);
    assert.equal(f.querySelector('a')?.hasAttribute('href'), false);
    assert.equal(f.querySelector('a')?.textContent, '<img src=x onerror=alert(1)>');
  });

  test('the stamp defaults to the viewer\'s zone and still prints an abbreviation', () => {
    const f = footer();
    renderProvenance(/** @type {any} */ (f), LIVE, SOURCES, { now: NOW });
    assert.match(f.querySelector('.provenance__asof')?.textContent ?? '', /\d{2}\/\d{2}\/\d{4} \d{1,2}:\d{2} [AP]M [A-Z]{2,5}/);
  });
});
