// @ts-check
/**
 * ui/panel.js (blueprint 3.3): mountPanel always renders a provenance footer, even when load fails, render
 * throws, or the status is dishonest; superseded loads are discarded; polling and heavy panels behave; the
 * development assertion on data-sources fires. Real-browser coverage is tests/e2e/harness.spec.mjs.
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { registerSources } from '../../../site/static/js/core/sources.js';
import { mountPanel, panelStatuses } from '../../../site/static/js/ui/panel.js';
import { installFakeDom } from '../core/helpers/fake-dom.mjs';
import { record } from '../core/helpers/records.mjs';

/** @typedef {import('../core/helpers/fake-dom.mjs').FakeElement} FakeElement */

/** @type {ReturnType<typeof installFakeDom>} */
let dom;
const locDesc = Object.getOwnPropertyDescriptor(globalThis, 'location');
let n = 0;

beforeEach(() => {
  dom = installFakeDom();
  registerSources([record({ id: 'src-a', attribution: 'Agency A', humanUrl: 'https://www.weather.gov/' }), record({ id: 'src-b', attribution: 'Agency B', humanUrl: 'https://weather.gc.ca/' })]);
});
afterEach(() => {
  dom.restore();
  if (locDesc) Object.defineProperty(globalThis, 'location', locDesc); else delete (/** @type {any} */ (globalThis)).location;
});

/** @param {string} sources */
function makeSlot(sources = 'src-a') {
  const slot = /** @type {FakeElement} */ (/** @type {unknown} */ (dom.document.createElement('section')));
  slot.setAttribute('data-panel', 'test');
  slot.setAttribute('data-sources', sources);
  const body = dom.document.createElement('div');
  body.setAttribute('data-panel-body', '');
  slot.appendChild(body);
  return slot;
}

/** @param {Partial<import('../../../site/static/js/types.js').StatusSnapshot>} [over] @returns {import('../../../site/static/js/types.js').StatusSnapshot} */
const status = (over = {}) => ({
  state: 'live', asOf: '2026-10-04T22:00:00Z', asOfBasis: 'issued', sourceIds: ['src-a'], origin: 'direct', completeness: 'complete', checkedAt: '2026-10-04T22:01:00Z', ...over,
});

const settle = async () => { for (let i = 0; i < 15; i += 1) await Promise.resolve(); await new Promise((r) => setTimeout(r, 0)); };
const footerOf = (/** @type {FakeElement} */ slot) => /** @type {FakeElement} */ (slot.querySelector('[data-provenance]'));
const bodyOf = (/** @type {FakeElement} */ slot) => /** @type {FakeElement} */ (slot.querySelector('[data-panel-body]'));
const statusId = () => `panel-test-${n += 1}`;

describe('mountPanel always renders a provenance footer', () => {
  test('before the first load: a footer exists, names the source, and the body says Loading with no digits', () => {
    const slot = makeSlot();
    mountPanel(/** @type {any} */ (slot), { title: 'T', sourceIds: ['src-a'], statusId: statusId(), load: () => new Promise(() => {}), render() {} });
    const f = footerOf(slot);
    assert.ok(f, 'footer present immediately');
    assert.equal(f.getAttribute('data-status'), 'loading');
    assert.match(f.textContent, /Source: Agency A/);
    assert.equal(bodyOf(slot).textContent, 'Loading Agency A');
    assert.doesNotMatch(bodyOf(slot).textContent, /\d/);
    assert.equal(slot.getAttribute('aria-busy'), 'true');
  });

  test('after a successful load: the renderer ran, and the footer is the full stamp', async () => {
    const slot = makeSlot();
    mountPanel(/** @type {any} */ (slot), {
      title: 'T', sourceIds: ['src-a'], statusId: statusId(),
      load: async () => ({ data: { name: 'Skagit' }, status: status() }),
      render(body, data) { body.append(/** @type {any} */ (dom.document.createTextNode(`River ${/** @type {any} */ (data).name}`))); },
    });
    await settle();
    assert.equal(bodyOf(slot).textContent, 'River Skagit');
    const f = footerOf(slot);
    assert.equal(f.getAttribute('data-status'), 'live');
    assert.ok(f.querySelector('.status-pill'));
    assert.match(f.querySelector('.provenance__asof')?.textContent ?? '', /^Issued as of /);
    assert.equal(slot.hasAttribute('aria-busy'), false);
  });

  test('a renderer that tries to skip the footer cannot: even an empty renderer gets one', async () => {
    const slot = makeSlot();
    mountPanel(/** @type {any} */ (slot), { title: 'T', sourceIds: ['src-a'], statusId: statusId(), load: async () => ({ data: 1, status: status() }), render() {} });
    await settle();
    assert.ok(footerOf(slot).querySelector('.status-pill'));
  });

  test('a renderer that throws shows a plain message, downgrades the status honestly, and keeps the footer', async () => {
    const slot = makeSlot();
    mountPanel(/** @type {any} */ (slot), { title: 'T', sourceIds: ['src-a'], statusId: statusId(), load: async () => ({ data: 1, status: status() }), render() { throw new Error('bad render'); } });
    await settle();
    assert.match(bodyOf(slot).textContent, /could not be displayed/);
    const f = footerOf(slot);
    assert.equal(f.getAttribute('data-status'), 'degraded');
    assert.match(f.querySelector('.provenance__detail')?.textContent ?? '', /could not be displayed/);
  });

  test('a load that rejects renders the unavailable state with a footer, never a blank panel', async () => {
    const slot = makeSlot();
    mountPanel(/** @type {any} */ (slot), { title: 'T', sourceIds: ['src-a'], statusId: statusId(), load: async () => { throw new Error('boom'); }, render() { throw new Error('never'); } });
    await settle();
    assert.match(bodyOf(slot).textContent, /could not be loaded/);
    assert.equal(footerOf(slot).getAttribute('data-status'), 'unavailable');
  });

  test('an unavailable status uses renderUnavailable when given, else the detail text', async () => {
    const slot = makeSlot();
    mountPanel(/** @type {any} */ (slot), { title: 'T', sourceIds: ['src-a'], statusId: statusId(), load: async () => ({ data: null, status: status({ state: 'unavailable', asOf: null, asOfBasis: null, detail: 'Agency A is down.' }) }), render() { throw new Error('never'); } });
    await settle();
    assert.equal(bodyOf(slot).textContent, 'Agency A is down.');
    const slot2 = makeSlot();
    mountPanel(/** @type {any} */ (slot2), {
      title: 'T', sourceIds: ['src-a'], statusId: statusId(),
      load: async () => ({ data: null, status: status({ state: 'unavailable', asOf: null, asOfBasis: null }) }),
      render() {}, renderUnavailable(body) { body.append(/** @type {any} */ (dom.document.createTextNode('Custom unavailable'))); },
    });
    await settle();
    assert.equal(bodyOf(slot2).textContent, 'Custom unavailable');
    assert.ok(footerOf(slot2));
  });

  test('a dishonest status from a loader is replaced by unavailable, not displayed', async () => {
    const slot = makeSlot();
    let rendered = false;
    mountPanel(/** @type {any} */ (slot), {
      title: 'T', sourceIds: ['src-a'], statusId: statusId(),
      load: async () => ({ data: { x: 1 }, status: status({ asOf: null }) }),
      render() { rendered = true; },
    });
    await settle();
    assert.equal(rendered, false);
    assert.equal(footerOf(slot).getAttribute('data-status'), 'unavailable');
    assert.match(bodyOf(slot).textContent, /invalid status/);
  });

  test('missing footer and body elements are created', async () => {
    const slot = /** @type {FakeElement} */ (/** @type {unknown} */ (dom.document.createElement('section')));
    slot.setAttribute('data-sources', 'src-a');
    mountPanel(/** @type {any} */ (slot), { title: 'River', sourceIds: ['src-a'], statusId: statusId(), load: async () => ({ data: 1, status: status() }), render() {} });
    await settle();
    assert.ok(slot.querySelector('[data-panel-body]'));
    assert.ok(footerOf(slot));
    assert.equal(slot.querySelector('.panel__title')?.textContent, 'River');
  });

  test('status is reported to the page registry under statusId', async () => {
    const slot = makeSlot();
    const id = statusId();
    mountPanel(/** @type {any} */ (slot), { title: 'T', sourceIds: ['src-a'], statusId: id, load: async () => ({ data: 1, status: status({ state: 'stale' }) }), render() {} });
    assert.equal(panelStatuses.get(id).state, 'unavailable', 'registered honestly as not yet loaded');
    await settle();
    assert.equal(panelStatuses.get(id).state, 'stale');
  });
});

describe('generation counter and refresh', () => {
  test('a superseded load never paints (the forecastSelectionGen guard)', async () => {
    const slot = makeSlot();
    /** @type {Array<(r: { data: unknown, status: import('../../../site/static/js/types.js').StatusSnapshot }) => void>} */
    const resolvers = [];
    /** @type {string[]} */
    const painted = [];
    const handle = mountPanel(/** @type {any} */ (slot), {
      title: 'T', sourceIds: ['src-a'], statusId: statusId(),
      load: () => new Promise((res) => { resolvers.push(res); }),
      render(body, data) { painted.push(/** @type {string} */ (data)); },
    });
    const second = handle.refresh();
    assert.equal(resolvers.length, 2);
    resolvers[1]?.({ data: 'second', status: status() });
    await second;
    resolvers[0]?.({ data: 'first (stale)', status: status() });
    await settle();
    assert.deepEqual(painted, ['second']);
  });

  test('the signal handed to load is aborted when superseded', async () => {
    const slot = makeSlot();
    /** @type {AbortSignal[]} */
    const signals = [];
    const handle = mountPanel(/** @type {any} */ (slot), { title: 'T', sourceIds: ['src-a'], statusId: statusId(), load: (s) => { signals.push(s); return new Promise(() => {}); }, render() {} });
    void handle.refresh();
    assert.equal(signals[0]?.aborted, true);
    assert.equal(signals[1]?.aborted, false);
  });

  test('refresh reloads and repaints; dispose stops everything and discards late results', async () => {
    const slot = makeSlot();
    let calls = 0;
    /** @type {string[]} */
    const painted = [];
    const handle = mountPanel(/** @type {any} */ (slot), { title: 'T', sourceIds: ['src-a'], statusId: statusId(), load: async () => ({ data: `v${calls += 1}`, status: status() }), render(_b, d) { painted.push(/** @type {string} */ (d)); } });
    await settle();
    await handle.refresh();
    assert.deepEqual(painted, ['v1', 'v2']);
    handle.dispose();
    await handle.refresh();
    assert.deepEqual(painted, ['v1', 'v2'], 'nothing paints after dispose');
  });

  test('a load that resolves after dispose is discarded', async () => {
    const slot = makeSlot();
    /** @type {(r: any) => void} */
    let release = () => {};
    let rendered = false;
    const handle = mountPanel(/** @type {any} */ (slot), { title: 'T', sourceIds: ['src-a'], statusId: statusId(), load: () => new Promise((r) => { release = r; }), render() { rendered = true; } });
    handle.dispose();
    release({ data: 1, status: status() });
    await settle();
    assert.equal(rendered, false);
  });
});

describe('the data-sources assertion', () => {
  test('on a development host a mismatch throws; the order of ids does not matter', () => {
    Object.defineProperty(globalThis, 'location', { value: { hostname: 'localhost' }, configurable: true, writable: true });
    assert.throws(() => mountPanel(/** @type {any} */ (makeSlot('src-a')), { title: 'T', sourceIds: ['src-b'], statusId: statusId(), load: async () => ({ data: 1, status: status() }), render() {} }), /does not match/);
    assert.doesNotThrow(() => mountPanel(/** @type {any} */ (makeSlot('src-a src-b')), { title: 'T', sourceIds: ['src-b', 'src-a'], statusId: statusId(), load: () => new Promise(() => {}), render() {} }));
  });

  test('on a production host a mismatch only warns', () => {
    Object.defineProperty(globalThis, 'location', { value: { hostname: 'atniclimate.github.io' }, configurable: true, writable: true });
    const warn = console.warn;
    /** @type {string[]} */
    const warned = [];
    console.warn = (/** @type {string} */ m) => { warned.push(m); };
    try {
      assert.doesNotThrow(() => mountPanel(/** @type {any} */ (makeSlot('src-a')), { title: 'T', sourceIds: ['src-b'], statusId: statusId(), load: () => new Promise(() => {}), render() {} }));
    } finally { console.warn = warn; }
    assert.equal(warned.length, 1);
  });
});

describe('polling', () => {
  test('a polling panel is started through the poller and stops on dispose', async () => {
    const slot = makeSlot();
    let calls = 0;
    const handle = mountPanel(/** @type {any} */ (slot), { title: 'T', sourceIds: ['src-a'], statusId: statusId(), poll: { visibleMs: 40, minMs: 10 }, load: async () => ({ data: calls += 1, status: status() }), render() {} });
    await new Promise((r) => setTimeout(r, 150));
    assert.ok(calls >= 2, `polled (${calls})`);
    handle.dispose();
    const after = calls;
    await new Promise((r) => setTimeout(r, 120));
    assert.equal(calls, after, 'no polling after dispose');
  });

  test('a heavy panel does not poll in low-data mode, and does otherwise', async () => {
    dom.document.documentElement.setAttribute('data-lowdata', '1');
    let low = 0;
    const h1 = mountPanel(/** @type {any} */ (makeSlot()), { title: 'T', sourceIds: ['src-a'], statusId: statusId(), heavy: true, poll: { visibleMs: 30, minMs: 10 }, load: async () => ({ data: low += 1, status: status() }), render() {} });
    await new Promise((r) => setTimeout(r, 120));
    assert.equal(low, 1, 'initial load only');
    h1.dispose();
    dom.document.documentElement.removeAttribute('data-lowdata');
    let normal = 0;
    const h2 = mountPanel(/** @type {any} */ (makeSlot()), { title: 'T', sourceIds: ['src-a'], statusId: statusId(), heavy: true, poll: { visibleMs: 30, minMs: 10 }, load: async () => ({ data: normal += 1, status: status() }), render() {} });
    await new Promise((r) => setTimeout(r, 120));
    assert.ok(normal >= 2);
    h2.dispose();
  });
});
