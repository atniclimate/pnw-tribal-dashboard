// @ts-check
/**
 * site/embed.js, the host-page helper (blueprint 1.5): at most 1 KB gzip, defines no globals, and resizes
 * only iframe[data-cthd] frames whose own window sent a { source: 'cthd', type: 'resize' } message from
 * the dashboard's origin, clamped to 320 to 6000 px. Runs the real file in a vm context. Owner: lane L1.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { gzipSync } from 'node:zlib';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const SOURCE = await readFile(path.join(ROOT, 'site', 'embed.js'), 'utf8');
const ORIGIN = 'https://atniclimate.github.io';

function host() {
  /** @type {((e: any) => void)[]} */
  const listeners = [];
  const winA = { name: 'frame A' };
  const winB = { name: 'frame B' };
  const frames = [{ contentWindow: winA, style: { height: '1200px' } }, { contentWindow: winB, style: { height: '900px' } }];
  const context = vm.createContext({
    addEventListener: (/** @type {string} */ type, /** @type {(e: any) => void} */ fn) => { if (type === 'message') listeners.push(fn); },
    document: { querySelectorAll: (/** @type {string} */ sel) => (sel === 'iframe[data-cthd]' ? frames : []) },
    Math, Number,
  });
  const before = new Set(Object.keys(context));
  vm.runInContext(SOURCE, context);
  const send = (/** @type {any} */ event) => { for (const fn of listeners) fn(event); };
  return { context, before, listeners, frames, winA, winB, send };
}

describe('site/embed.js host helper', () => {
  test('is at most 1 KB gzip', () => {
    const bytes = gzipSync(Buffer.from(SOURCE), { level: 9 }).length;
    assert.ok(bytes <= 1024, `${bytes} bytes gzip`);
  });

  test('defines no globals and registers exactly one message listener', () => {
    const h = host();
    assert.deepEqual(Object.keys(h.context).filter((k) => !h.before.has(k)), []);
    assert.equal(h.listeners.length, 1);
  });

  test('resizes only the frame whose window sent a matching message', () => {
    const h = host();
    h.send({ origin: ORIGIN, source: h.winB, data: { source: 'cthd', type: 'resize', page: 'alerts', height: 1534.4 } });
    assert.equal(h.frames[0]?.style.height, '1200px');
    assert.equal(h.frames[1]?.style.height, '1534px');
  });

  test('ignores other origins, other sources, other types, and empty data', () => {
    const h = host();
    const ok = { source: 'cthd', type: 'resize', height: 2000 };
    h.send({ origin: 'https://evil.example', source: h.winA, data: ok });
    h.send({ origin: 'http://atniclimate.github.io', source: h.winA, data: ok });
    h.send({ origin: ORIGIN, source: h.winA, data: { ...ok, source: 'other' } });
    h.send({ origin: ORIGIN, source: h.winA, data: { ...ok, type: 'height' } });
    h.send({ origin: ORIGIN, source: h.winA, data: null });
    h.send({ origin: ORIGIN, source: h.winA, data: 'resize' });
    h.send({ origin: ORIGIN, source: { name: 'not a dashboard frame' }, data: ok });
    assert.equal(h.frames[0]?.style.height, '1200px');
    assert.equal(h.frames[1]?.style.height, '900px');
  });

  test('clamps heights to 320 through 6000 px and treats junk as the minimum', () => {
    const h = host();
    const at = (/** @type {unknown} */ height) => { h.send({ origin: ORIGIN, source: h.winA, data: { source: 'cthd', type: 'resize', height } }); return h.frames[0]?.style.height; };
    assert.equal(at(40), '320px');
    assert.equal(at(99999), '6000px');
    assert.equal(at('not a number'), '320px');
    assert.equal(at(-5), '320px');
    assert.equal(at('800'), '800px');
  });
});
