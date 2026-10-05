// @ts-check
/** L13: site/static/js/data/resources.js on the real compiled resources and a dated seasonal case. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import {
  CATEGORY_LABELS, HAZARD_LABELS, filterResources, inSeason, loadResourcesDoc, readResourcesDoc, resourceFilterNote, resourceLine,
} from '../../../site/static/js/data/resources.js';
import { listText } from '../../../site/static/js/ui/copy-print.js';

const root = new URL('../../../', import.meta.url);
const json = (/** @type {string} */ rel) => JSON.parse(readFileSync(new URL(rel, root), 'utf8'));
const doc = json('site/data/curated/resources.json');
/** @type {import('../../../site/static/js/types.js').Resource[]} */
const items = doc.items;
const NOW = new Date('2026-10-05T12:00:00Z');

describe('resources', () => {
  test('the compiled file reads clean, and every category and hazard has a label', () => {
    const r = readResourcesDoc(doc);
    assert.equal(r?.dropped, 0);
    for (const i of items) {
      assert.ok(CATEGORY_LABELS[i.category], i.category);
      for (const h of i.hazards) assert.ok(HAZARD_LABELS[h], h);
    }
  });

  test('hazard labels equal data/ref/hazards.json', () => {
    const ref = json('site/data/ref/hazards.json').categories;
    assert.deepEqual(Object.keys(HAZARD_LABELS).sort(), Object.keys(ref).sort());
    for (const [k, v] of Object.entries(ref)) assert.equal(HAZARD_LABELS[k], /** @type {any} */ (v).label);
  });

  test('every resource has a source, a verified date, and a dialable phone when it has one', () => {
    for (const i of items) {
      assert.match(i.sourceUrl, /^https:\/\//);
      assert.match(i.verifiedAt, /^\d{4}-\d{2}-\d{2}$/);
      if (i.phone) assert.match(i.phone, /^(211|311|511|911|988|\+[1-9]\d{6,14})$/);
    }
  });

  test('the Event Archive items never appear here', () => {
    assert.ok(items.every((i) => i.status === 'evergreen' || (i.validFrom && i.validUntil)));
  });

  test('season window is inclusive by day; a seasonal item with no window never shows', () => {
    const s = /** @type {any} */ ({ ...items[0], status: 'seasonal', validFrom: '2026-06-01', validUntil: '2026-09-30' });
    assert.equal(inSeason(s, new Date('2026-06-01T00:00:00Z')), true);
    assert.equal(inSeason(s, new Date('2026-09-30T23:59:00Z')), true);
    assert.equal(inSeason(s, NOW), false);
    assert.equal(inSeason({ ...s, validFrom: undefined }, new Date('2026-07-01T00:00:00Z')), false);
  });

  test('evergreen first, then category order', () => {
    const seasonal = /** @type {any} */ ({ ...items[0], id: 'zz', title: 'A Seasonal', status: 'seasonal', validFrom: '2026-09-01', validUntil: '2026-10-31' });
    const out = filterResources([seasonal, ...items], {}, NOW);
    assert.equal(out.at(-1)?.id, 'zz');
    const cats = out.slice(0, -1).map((r) => Object.keys(CATEGORY_LABELS).indexOf(r.category));
    assert.deepEqual(cats, [...cats].sort((a, b) => a - b));
  });

  test('jurisdiction keeps federal items; British Columbia has none on file; search folds case', () => {
    const wa = filterResources(items, { region: ['WA'] }, NOW);
    assert.ok(wa.some((r) => r.scope.level === 'federal') && wa.some((r) => r.scope.region === 'WA'));
    assert.ok(!wa.some((r) => r.scope.region === 'OR'));
    assert.equal(filterResources(items, { region: ['BC'] }, NOW).filter((r) => r.scope.level !== 'federal').length, 0);
    assert.ok(filterResources(items, { q: 'RED CROSS' }, NOW).length >= 2);
  });

  test('category and hazard filters combine', () => {
    const out = filterResources(items, { category: ['rivers'], hazard: ['flood'] }, NOW);
    assert.ok(out.length > 0 && out.every((r) => r.category === 'rivers' && r.hazards.includes('flood')));
  });

  test('a Nation selection includes its own items, federal items, and its jurisdictions', () => {
    const out = filterResources(items, { nationId: 'us-wa-lummi-tribe-of-the-lummi-reservation', nationRegions: ['WA'] }, NOW);
    assert.ok(out.some((r) => r.nationId === 'us-wa-lummi-tribe-of-the-lummi-reservation'));
    assert.ok(!out.some((r) => r.nationId === 'us-wa-tulalip-tribes-of-washington'));
    assert.ok(!out.some((r) => r.scope.region === 'OR'));
  });

  test('the filter note and the copy text name the filter', () => {
    const note = resourceFilterNote({ category: ['rivers'], shown: 3, total: 21 });
    assert.equal(note, 'Filter: Category: Rivers and Flood Information. 3 of 21 resources.');
    const text = listText(items.slice(0, 2).map(resourceLine), note);
    assert.equal(text.split('\n')[0], note);
    assert.match(text, /Verified 10\/05\/2026/);
  });

  test('offline falls back to the saved copy', async () => {
    const res = await loadResourcesDoc({
      deps: { fetchLocal: async () => ({ ok: false, error: { kind: 'offline', message: 'x' }, fetchedAt: '', sourceId: '' }), savedCopy: async () => doc },
    });
    assert.ok(res.ok && res.origin === 'cache');
  });
});
