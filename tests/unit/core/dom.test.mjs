// @ts-check
/**
 * core/dom.js (blueprint 3.4): h() rejects on* and drops unsafe href; safeUrl blocks javascript:, data:, and
 * vbscript:; strings become Text nodes, never markup. Runs on the fake DOM; the same checks run in a real
 * browser in tests/e2e/harness.spec.mjs.
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { clear, h, on, safeUrl, telHref } from '../../../site/static/js/core/dom.js';
import { FakeEvent, FakeText, installFakeDom } from './helpers/fake-dom.mjs';

/** @typedef {import('./helpers/fake-dom.mjs').FakeElement} FakeElement */

/** @type {ReturnType<typeof installFakeDom>} */
let dom;
beforeEach(() => { dom = installFakeDom(); });
afterEach(() => { dom.restore(); });

/** @param {unknown} el @returns {FakeElement} */
const fe = (el) => /** @type {FakeElement} */ (el);

describe('safeUrl', () => {
  test('allows https, http, tel, mailto, and relative references', () => {
    for (const ok of ['https://www.weather.gov/', 'http://example.org', 'tel:+18002585990', 'mailto:climate@atnitribes.org', '/alerts/', 'alerts/?n=us-wa-x', '?n=1', '#flood', '../safety/#flood', '//www.weather.gov/x']) {
      assert.equal(safeUrl(ok), ok, ok);
    }
  });

  test('blocks javascript:, data:, and vbscript: in every spelling', () => {
    const bad = [
      'javascript:alert(1)', 'JAVASCRIPT:alert(1)', ' javascript:alert(1)', 'java\tscript:alert(1)', 'java\nscript:alert(1)',
      'java\u0000script:alert(1)', '\u0001javascript:alert(1)', 'data:text/html,<script>alert(1)</script>', 'DATA:image/png;base64,AAAA',
      'vbscript:msgbox(1)', 'VbScript:x', 'javascript :alert(1)', 'jav ascript:alert(1)', '  \tdata:text/html,x',
    ];
    for (const u of bad) assert.equal(safeUrl(u), '', JSON.stringify(u));
  });

  test('blocks other schemes (file, blob, ftp) by default and honors a custom allowlist', () => {
    for (const u of ['file:///etc/passwd', 'blob:https://x/1', 'ftp://x/y', 'chrome://settings']) assert.equal(safeUrl(u), '');
    assert.equal(safeUrl('ftp://x/y', ['ftp:']), 'ftp://x/y');
    assert.equal(safeUrl('https://x/y', ['ftp:']), '');
  });

  test('non-strings give the empty string', () => {
    assert.equal(safeUrl(/** @type {any} */ (null)), '');
    assert.equal(safeUrl(/** @type {any} */ (42)), '');
  });

  test('trims surrounding whitespace on allowed URLs', () => {
    assert.equal(safeUrl('  https://www.weather.gov/  '), 'https://www.weather.gov/');
  });
});

describe('telHref', () => {
  test('E.164 and the five short codes', () => {
    assert.equal(telHref('+18002585990'), 'tel:+18002585990');
    for (const c of ['211', '311', '511', '911', '988']) assert.equal(telHref(c), `tel:${c}`);
  });

  test('North American numbers without a plus are normalized', () => {
    assert.equal(telHref('(206) 555-0100'), 'tel:+12065550100');
    assert.equal(telHref('1-206-555-0100'), 'tel:+12065550100');
    assert.equal(telHref('206.555.0100'), 'tel:+12065550100');
  });

  test('anything that is not dialable is empty, including injection attempts', () => {
    for (const bad of ['', 'abc', '12', '999', '+0123', 'tel:911', '911;ext=1', 'javascript:alert(1)', '+1 800 CALL NOW', '1234567']) assert.equal(telHref(bad), '', bad);
  });
});

describe('h()', () => {
  test('builds an element with attributes and children', () => {
    const el = fe(h('a', { href: 'https://www.weather.gov/', class: 'link', 'data-x': '1' }, 'Weather', ' ', 'Service'));
    assert.equal(el.tagName, 'a');
    assert.equal(el.getAttribute('href'), 'https://www.weather.gov/');
    assert.equal(el.getAttribute('class'), 'link');
    assert.equal(el.dataset.x, '1');
    assert.equal(el.textContent, 'Weather Service');
  });

  test('strings become Text nodes: markup in data is inert', () => {
    const payload = '<img src=x onerror=alert(1)><script>alert(2)</script>';
    const el = fe(h('p', {}, payload));
    assert.equal(el.childNodes.length, 1);
    assert.ok(el.firstChild instanceof FakeText);
    assert.equal(el.textContent, payload);
    assert.equal(el.querySelectorAll('img').length, 0);
    assert.equal(el.querySelectorAll('script').length, 0);
  });

  test('numbers become text; null, undefined, false, true are skipped; arrays flatten; nodes append', () => {
    const child = h('b', {}, 'x');
    const el = fe(h('p', {}, 0, null, undefined, false, true, ['a', ['b']], child, 7));
    assert.equal(el.textContent, '0abx7');
    assert.equal(el.childNodes.length, 5);
  });

  test('rejects on* attributes in any case, as a programming error', () => {
    for (const k of ['onclick', 'onerror', 'onload', 'onmouseover', 'ONCLICK', 'OnFocus']) {
      assert.throws(() => h('div', { [k]: 'alert(1)' }), /event handler/, k);
    }
    assert.throws(() => h('div', { onclick: null }), /event handler/, 'even with an empty value');
  });

  test('drops unsafe href, src, and action instead of setting them', () => {
    const a = fe(h('a', { href: 'javascript:alert(1)' }, 'x'));
    assert.equal(a.hasAttribute('href'), false);
    const img = fe(h('img', { src: 'data:image/svg+xml,<svg onload=alert(1)>' }));
    assert.equal(img.hasAttribute('src'), false);
    const form = fe(h('form', { action: 'vbscript:x' }));
    assert.equal(form.hasAttribute('action'), false);
    const safe = fe(h('a', { href: '/alerts/' }, 'ok'));
    assert.equal(safe.getAttribute('href'), '/alerts/');
  });

  test('refuses script elements and srcdoc', () => {
    assert.throws(() => h('script', {}, 'alert(1)'), /script/);
    assert.throws(() => h('SCRIPT', {}), /script/);
    assert.throws(() => h('iframe', { srcdoc: '<p>x</p>' }), /srcdoc/);
  });

  test('refuses malformed tag names and ignores malformed attribute names', () => {
    assert.throws(() => h('a b'), /invalid tag/);
    assert.throws(() => h('img src=x'), /invalid tag/);
    assert.throws(() => h('<div>'), /invalid tag/);
    const el = fe(h('div', { 'a b': '1', '"><x': '2', ok: '3' }));
    assert.equal(el.attrs.size, 1);
    assert.equal(el.getAttribute('ok'), '3');
  });

  test('drops style attributes (the CSP forbids inline styles) and false, null, or undefined values', () => {
    const el = fe(h('div', { style: 'color:red', hidden: false, title: null, id: undefined, 'aria-hidden': 'true' }));
    assert.deepEqual([...el.attrs.keys()], ['aria-hidden']);
  });

  test('true sets an empty attribute; numbers are stringified; className maps to class', () => {
    const el = fe(h('input', { disabled: true, maxlength: 5, className: 'wide' }));
    assert.equal(el.getAttribute('disabled'), '');
    assert.equal(el.getAttribute('maxlength'), '5');
    assert.equal(el.getAttribute('class'), 'wide');
  });

  test('dataset takes an object', () => {
    const el = fe(h('div', { dataset: { sourceIds: 'a b', skip: null, on: false, n: 3 } }));
    assert.equal(el.getAttribute('data-source-ids'), 'a b');
    assert.equal(el.getAttribute('data-n'), '3');
    assert.equal(el.hasAttribute('data-skip'), false);
  });

  test('svg tags are created in the SVG namespace; html tags are not', () => {
    const svg = fe(h('svg', { viewBox: '0 0 12 12' }, h('circle', { cx: '6' })));
    assert.equal(svg.namespaceURI, 'http://www.w3.org/2000/svg');
    assert.equal(fe(svg.firstChild).namespaceURI, 'http://www.w3.org/2000/svg');
    assert.equal(svg.getAttribute('viewBox'), '0 0 12 12');
    assert.equal(fe(h('div')).namespaceURI, 'http://www.w3.org/1999/xhtml');
  });
});

describe('clear and on', () => {
  test('clear removes every child', () => {
    const el = fe(h('ul', {}, h('li', {}, 'a'), h('li', {}, 'b'), 'text'));
    clear(/** @type {any} */ (el));
    assert.equal(el.childNodes.length, 0);
    assert.doesNotThrow(() => clear(/** @type {any} */ (el)));
  });

  test('on() delegates by data-action and bubbles from descendants', () => {
    const inner = h('span', {}, 'x');
    const btn = h('button', { 'data-action': 'save' }, inner);
    const other = h('button', { 'data-action': 'cancel' }, 'y');
    const root = h('div', {}, btn, other);
    /** @type {string[]} */
    const hits = [];
    const off = on(/** @type {any} */ (root), 'save', (_e, target) => hits.push(/** @type {any} */ (target).getAttribute('data-action')));
    fe(inner).dispatchEvent(new FakeEvent('click'));
    fe(other).dispatchEvent(new FakeEvent('click'));
    assert.deepEqual(hits, ['save']);
    off();
    fe(btn).dispatchEvent(new FakeEvent('click'));
    assert.deepEqual(hits, ['save'], 'unsubscribed');
  });

  test('on() ignores actions outside its root and supports another event type', () => {
    const outside = h('button', { 'data-action': 'save' }, 'z');
    const root = h('div', {});
    let n = 0;
    on(/** @type {any} */ (root), 'save', () => { n += 1; }, 'input');
    fe(outside).dispatchEvent(new FakeEvent('input'));
    assert.equal(n, 0);
    const inside = h('input', { 'data-action': 'save' });
    fe(root).appendChild(/** @type {any} */ (inside));
    fe(inside).dispatchEvent(new FakeEvent('click'));
    assert.equal(n, 0, 'click is not the registered type');
    fe(inside).dispatchEvent(new FakeEvent('input'));
    assert.equal(n, 1);
  });
});
