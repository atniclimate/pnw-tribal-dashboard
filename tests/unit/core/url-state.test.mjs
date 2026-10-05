// @ts-check
/**
 * core/url-state.js (blueprint 3.5): typed parsing with invalid values dropped, round trips, unknown keys and
 * embed preserved, id-redirects applied to n=, history writes, linkWithState.
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { linkWithState, onStateChange, parseQuery, readState, serializeQuery, setIdRedirects, writeState } from '../../../site/static/js/core/url-state.js';

/** The page schema of blueprint 3.5. */
const SCHEMA = /** @type {import('../../../site/static/js/types.js').UrlStateSchema} */ ({
  n: { type: 'nation-id' },
  view: { type: 'enum', values: ['list', 'map', 'declarations', 'rivers'] },
  j: { type: 'enum-list', values: ['wa', 'or', 'id', 'bc', 'ca-n', 'mt-w', 'nv-n', 'ak-se', 'marine'] },
  hz: { type: 'enum-list', values: ['flood', 'coastal', 'wind', 'winter'] },
  des: { type: 'list' },
  g: { type: 'string' },
  fh: { type: 'int', min: 0, max: 240 },
  map: { type: 'latlonzoom' },
  units: { type: 'enum', values: ['us', 'metric'] },
  q: { type: 'string' },
  embed: { type: 'flag' },
  lowdata: { type: 'flag' },
});

describe('parseQuery', () => {
  test('parses every type', () => {
    const s = parseQuery('?n=us-wa-lummi-nation&view=rivers&j=wa,ca-n&hz=flood,coastal&des=warning,watch&g=nwps:MVEW1&fh=48&map=47.6,-122.3,9&units=metric&q=skagit&embed=1&lowdata=1', SCHEMA);
    assert.deepEqual(s, {
      n: 'us-wa-lummi-nation', view: 'rivers', j: ['wa', 'ca-n'], hz: ['flood', 'coastal'], des: ['warning', 'watch'],
      g: 'nwps:MVEW1', fh: 48, map: [47.6, -122.3, 9], units: 'metric', q: 'skagit', embed: true, lowdata: true,
    });
  });

  test('works with or without the leading question mark, and on an empty query', () => {
    assert.deepEqual(parseQuery('view=map', SCHEMA), { view: 'map' });
    assert.deepEqual(parseQuery('', SCHEMA), {});
    assert.deepEqual(parseQuery('?', SCHEMA), {});
  });

  test('invalid values are dropped, never coerced', () => {
    const s = parseQuery('?n=not-an-id&view=nowhere&j=xx,yy&hz=&fh=abc&map=91,0,3&units=imperial&embed=maybe&q=%20%20', SCHEMA);
    assert.deepEqual(s, {});
  });

  test('valid items of a list survive an invalid neighbor', () => {
    assert.deepEqual(parseQuery('?j=wa,xx,bc', SCHEMA), { j: ['wa', 'bc'] });
    assert.deepEqual(parseQuery('?des=a,,b,', SCHEMA), { des: ['a', 'b'] });
  });

  test('ints respect bounds and reject decimals and unsafe values', () => {
    assert.deepEqual(parseQuery('?fh=0', SCHEMA), { fh: 0 });
    assert.deepEqual(parseQuery('?fh=240', SCHEMA), { fh: 240 });
    assert.deepEqual(parseQuery('?fh=241', SCHEMA), {});
    assert.deepEqual(parseQuery('?fh=-1', SCHEMA), {});
    assert.deepEqual(parseQuery('?fh=4.5', SCHEMA), {});
    assert.deepEqual(parseQuery('?fh=99999999999999999999', SCHEMA), {});
  });

  test('map must be three numbers within range', () => {
    assert.deepEqual(parseQuery('?map=47,-122,9.5', SCHEMA), { map: [47, -122, 9.5] });
    for (const bad of ['47,-122', '47,-122,9,1', 'a,b,c', '47,-181,9', '47,-122,25', '47,-122,-1', ',,']) assert.deepEqual(parseQuery(`?map=${bad}`, SCHEMA), {}, bad);
  });

  test('flags: empty, 1, and true are on; 0 and false are off; others are dropped', () => {
    assert.deepEqual(parseQuery('?embed', SCHEMA), { embed: true });
    assert.deepEqual(parseQuery('?embed=true', SCHEMA), { embed: true });
    assert.deepEqual(parseQuery('?embed=0', SCHEMA), { embed: false });
    assert.deepEqual(parseQuery('?embed=false', SCHEMA), { embed: false });
    assert.deepEqual(parseQuery('?embed=yes', SCHEMA), {});
  });

  test('Nation ids: US and First Nation forms validate', () => {
    assert.deepEqual(parseQuery('?n=ca-fn-555', SCHEMA), { n: 'ca-fn-555' });
    assert.deepEqual(parseQuery('?n=us-ak-metlakatla-indian-community', SCHEMA), { n: 'us-ak-metlakatla-indian-community' });
    for (const bad of ['ca-fn-0', 'ca-fn-123456', 'us-tx-x', 'US-WA-X', 'us-wa-', '../x', 'ca-fn-5x']) assert.deepEqual(parseQuery(`?n=${bad}`, SCHEMA), {}, bad);
  });

  test('over-long strings are dropped', () => {
    assert.deepEqual(parseQuery(`?q=${'x'.repeat(201)}`, SCHEMA), {});
    assert.deepEqual(parseQuery(`?q=${'x'.repeat(200)}`, SCHEMA).q?.toString().length, 200);
  });

  test('keys outside the schema are ignored by parsing', () => {
    assert.deepEqual(parseQuery('?utm_source=sms&view=map', SCHEMA), { view: 'map' });
  });
});

describe('id redirects', () => {
  afterEach(() => setIdRedirects(null));

  test('a renamed id is rewritten silently, following chains', () => {
    setIdRedirects({
      schema: 'cthd.id-redirects/1',
      redirects: {
        'us-wa-old-name': { to: 'us-wa-mid-name', since: '2026-10-01', reason: 'rename' },
        'us-wa-mid-name': { to: 'us-wa-new-name', since: '2026-10-02', reason: 'rename' },
      },
    });
    assert.deepEqual(parseQuery('?n=us-wa-old-name', SCHEMA), { n: 'us-wa-new-name' });
    assert.deepEqual(parseQuery('?n=us-wa-new-name', SCHEMA), { n: 'us-wa-new-name' });
  });

  test('a redirect cycle or a malformed target does not hang or throw', () => {
    setIdRedirects({
      schema: 'cthd.id-redirects/1',
      redirects: {
        'us-wa-a': { to: 'us-wa-b', since: 'x', reason: 'x' },
        'us-wa-b': { to: 'us-wa-a', since: 'x', reason: 'x' },
        'us-wa-c': { to: 'NOT AN ID', since: 'x', reason: 'x' },
      },
    });
    assert.doesNotThrow(() => parseQuery('?n=us-wa-a', SCHEMA));
    assert.deepEqual(parseQuery('?n=us-wa-c', SCHEMA), {});
  });
});

describe('serializeQuery', () => {
  test('round-trips parse(serialize(state))', () => {
    const state = { n: 'us-id-nez-perce-tribe', view: 'map', j: ['wa', 'or'], fh: 24, map: [47.6062, -122.3321, 9.25], units: 'us', embed: true, g: 'nwps:MVEW1' };
    const q = serializeQuery(/** @type {any} */ (state));
    assert.deepEqual(parseQuery(q, SCHEMA), state);
  });

  test('is stable: sorted keys, equal states give equal strings, commas and colons stay readable', () => {
    const a = serializeQuery({ view: 'map', n: 'us-wa-x', j: ['wa', 'bc'], g: 'nwps:MVEW1' });
    const b = serializeQuery({ g: 'nwps:MVEW1', j: ['wa', 'bc'], n: 'us-wa-x', view: 'map' });
    assert.equal(a, b);
    assert.equal(a, '?g=nwps:MVEW1&j=wa,bc&n=us-wa-x&view=map');
  });

  test('preserves unknown keys and embed from the base query', () => {
    const q = serializeQuery({ view: 'rivers' }, '?utm_source=sms&embed=1&view=list&ref=a%20b');
    const p = new URLSearchParams(q);
    assert.equal(p.get('utm_source'), 'sms');
    assert.equal(p.get('embed'), '1');
    assert.equal(p.get('ref'), 'a b');
    assert.equal(p.get('view'), 'rivers');
  });

  test('undefined, false, null, and empty lists remove a key; other keys stay', () => {
    const q = serializeQuery(/** @type {any} */ ({ view: undefined, embed: false, j: [], hz: null }), '?view=map&embed=1&j=wa&hz=flood&keep=1');
    assert.equal(q, '?keep=1');
  });

  test('an empty result is the empty string', () => {
    assert.equal(serializeQuery({}), '');
    assert.equal(serializeQuery({ a: undefined }, '?a=1'), '');
  });

  test('map is rounded to four decimals for position and two for zoom', () => {
    assert.equal(serializeQuery({ map: [47.123456789, -122.987654321, 9.126] }), '?map=47.1235,-122.9877,9.13');
  });

  test('values with reserved characters are percent-encoded and survive the round trip', () => {
    const q = serializeQuery({ q: 'skagit & snohomish=1' });
    assert.deepEqual(parseQuery(q, SCHEMA), { q: 'skagit & snohomish=1' });
  });
});

describe('browser state (location and history)', () => {
  /** @type {Array<{ kind: string, url: string }>} */
  let history;
  /** @type {{ pathname: string, search: string, hash: string }} */
  let loc;
  const saved = { location: Object.getOwnPropertyDescriptor(globalThis, 'location'), history: Object.getOwnPropertyDescriptor(globalThis, 'history') };
  const realAdd = globalThis.addEventListener;
  /** The module binds popstate once per process, so the handler is kept across tests. @type {(() => void) | null} */
  let popHandler = null;

  beforeEach(() => {
    history = [];
    loc = { pathname: '/pnw-tribal-dashboard/alerts/', search: '?embed=1&utm=x', hash: '#top' };
    Object.defineProperty(globalThis, 'location', { value: loc, configurable: true, writable: true });
    Object.defineProperty(globalThis, 'history', {
      configurable: true,
      value: {
        replaceState: (/** @type {any} */ _s, /** @type {string} */ _t, /** @type {string} */ url) => { history.push({ kind: 'replace', url }); const [path, rest = ''] = url.split('?'); loc.pathname = path ?? ''; loc.search = rest ? `?${rest.split('#')[0]}` : ''; },
        pushState: (/** @type {any} */ _s, /** @type {string} */ _t, /** @type {string} */ url) => { history.push({ kind: 'push', url }); const [path, rest = ''] = url.split('?'); loc.pathname = path ?? ''; loc.search = rest ? `?${rest.split('#')[0]}` : ''; },
      },
    });
    globalThis.addEventListener = /** @type {any} */ ((/** @type {string} */ t, /** @type {() => void} */ f) => {
      if (t === 'popstate') popHandler = f;
    });
  });

  afterEach(() => {
    if (saved.location) Object.defineProperty(globalThis, 'location', saved.location); else delete (/** @type {any} */ (globalThis)).location;
    if (saved.history) Object.defineProperty(globalThis, 'history', saved.history); else delete (/** @type {any} */ (globalThis)).history;
    globalThis.addEventListener = realAdd;
  });

  test('readState parses location.search', () => {
    assert.deepEqual(readState(SCHEMA), { embed: true });
  });

  test('writeState replaces by default, pushes on request, keeps unknown keys, embed, and the hash', () => {
    writeState({ view: 'map' });
    assert.deepEqual(history[0], { kind: 'replace', url: '/pnw-tribal-dashboard/alerts/?embed=1&utm=x&view=map#top' });
    writeState({ n: 'us-wa-x' }, { push: true });
    assert.equal(history[1]?.kind, 'push');
    assert.match(history[1]?.url ?? '', /embed=1/);
    assert.match(history[1]?.url ?? '', /utm=x/);
    assert.match(history[1]?.url ?? '', /n=us-wa-x/);
    assert.match(history[1]?.url ?? '', /view=map/);
  });

  test('writeState with no change does not touch history but still notifies', () => {
    /** @type {string[]} */
    const seen = [];
    onStateChange((p) => seen.push(p.toString()));
    writeState({ embed: true });
    assert.equal(history.length, 0);
    assert.equal(seen.length, 1);
  });

  test('onStateChange hears programmatic writes and popstate, and unsubscribes', () => {
    /** @type {string[]} */
    const seen = [];
    const off = onStateChange((p) => seen.push(p.get('view') ?? '-'));
    writeState({ view: 'rivers' });
    assert.ok(popHandler, 'popstate was bound');
    popHandler?.();
    assert.deepEqual(seen, ['rivers', 'rivers']);
    off();
    writeState({ view: 'list' });
    assert.equal(seen.length, 2);
  });

  test('a history error is swallowed (sandboxed frames)', () => {
    Object.defineProperty(globalThis, 'history', { configurable: true, value: { replaceState() { throw new Error('SecurityError'); }, pushState() { throw new Error('SecurityError'); } } });
    assert.doesNotThrow(() => writeState({ view: 'map' }));
  });

  test('linkWithState carries n, embed, units, and lowdata by default and nothing else', () => {
    loc.search = '?n=us-wa-x&embed=1&units=metric&lowdata=1&utm=x&view=map';
    assert.equal(linkWithState('../safety/#flood'), '../safety/?embed=1&lowdata=1&n=us-wa-x&units=metric#flood');
    assert.equal(linkWithState('/alerts/', ['view']), '/alerts/?view=map');
  });

  test('the href\'s own query wins and its hash is kept', () => {
    loc.search = '?n=us-wa-x&embed=1';
    assert.equal(linkWithState('/forecasts/?n=us-id-y&view=rivers#top'), '/forecasts/?embed=1&n=us-id-y&view=rivers#top');
  });

  test('with nothing to carry the link is unchanged', () => {
    loc.search = '';
    assert.equal(linkWithState('/alerts/'), '/alerts/');
    assert.equal(linkWithState('/alerts/#a'), '/alerts/#a');
  });
});

describe('without a browser', () => {
  test('readState, writeState, and linkWithState degrade quietly in Node', () => {
    assert.deepEqual(readState(SCHEMA), {});
    assert.doesNotThrow(() => writeState({ view: 'map' }));
    assert.equal(linkWithState('/x/'), '/x/');
  });
});
