// @ts-check
/**
 * boot/flags.js (blueprint 1.4): embed, framed, low-data, and single-panel flags set before first paint.
 * Runs the classic script in a VM context with minimal browser stand-ins.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, test } from 'node:test';
import vm from 'node:vm';

const source = await readFile(new URL('../../../site/static/js/boot/flags.js', import.meta.url), 'utf8');

/**
 * @param {{ search?: string, framed?: boolean | 'throws', stored?: string | null, storageThrows?: boolean, saveData?: boolean }} opts
 * @returns {Record<string, string>} attributes set on <html>
 */
function run(opts) {
  /** @type {Record<string, string>} */
  const attrs = {};
  const top = {};
  /** @type {any} */
  const win = {};
  win.self = win;
  if (opts.framed === 'throws') Object.defineProperty(win, 'top', { get() { throw new Error('cross-origin'); } });
  else win.top = opts.framed ? top : win;
  const context = {
    window: win,
    document: { documentElement: { setAttribute: (/** @type {string} */ k, /** @type {string} */ v) => { attrs[k] = v; } } },
    location: { search: opts.search ?? '' },
    URLSearchParams,
    localStorage: { getItem: () => { if (opts.storageThrows) throw new Error('blocked'); return opts.stored ?? null; } },
    navigator: { connection: opts.saveData ? { saveData: true } : undefined },
  };
  vm.runInNewContext(source, context);
  return attrs;
}

describe('boot/flags.js', () => {
  test('top-level page without parameters sets nothing', () => {
    assert.deepEqual(run({}), {});
  });

  test('embed=1 and embed=true set embed mode', () => {
    assert.equal(run({ search: '?embed=1' })['data-embed'], '1');
    assert.equal(run({ search: '?embed=true' })['data-embed'], '1');
  });

  test('framed without a parameter defaults to embed mode; embed=0 and embed=false force full chrome', () => {
    assert.deepEqual(run({ framed: true }), { 'data-embed': '1', 'data-framed': '1' });
    assert.deepEqual(run({ framed: true, search: '?embed=0' }), { 'data-framed': '1' });
    assert.deepEqual(run({ framed: true, search: '?embed=false' }), { 'data-framed': '1' });
  });

  test('a cross-origin top that throws counts as framed', () => {
    assert.deepEqual(run({ framed: 'throws' }), { 'data-embed': '1', 'data-framed': '1' });
  });

  test('low-data mode from the parameter, the stored preference, or Save-Data', () => {
    assert.equal(run({ search: '?lowdata=1' })['data-lowdata'], '1');
    assert.equal(run({ stored: '1' })['data-lowdata'], '1');
    assert.equal(run({ saveData: true })['data-lowdata'], '1');
    assert.equal(run({ search: '?lowdata=0' })['data-lowdata'], undefined);
  });

  test('blocked storage never breaks the script', () => {
    assert.equal(run({ storageThrows: true, search: '?lowdata=1' })['data-lowdata'], '1');
    assert.deepEqual(run({ storageThrows: true }), {});
  });

  test('panel accepts short kebab-case names only', () => {
    assert.equal(run({ search: '?panel=banner' })['data-panel-only'], 'banner');
    assert.equal(run({ search: '?panel=Banner' })['data-panel-only'], undefined);
    assert.equal(run({ search: '?panel=%3Cscript%3E' })['data-panel-only'], undefined);
    assert.equal(run({ search: `?panel=${'a'.repeat(25)}` })['data-panel-only'], undefined);
  });

  test('stays under 1 KB', () => {
    const code = source.split('\n').filter((l) => !l.startsWith('//')).join('\n');
    assert.ok(Buffer.byteLength(code) < 1024, `${Buffer.byteLength(code)} bytes`);
  });
});
