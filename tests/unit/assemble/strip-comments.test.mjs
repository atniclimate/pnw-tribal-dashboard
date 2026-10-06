// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { stripComments } from '../../../scripts/assemble-site.mjs';

test('stripComments removes comments only, keeps literals that look like comments, and leaves classic scripts and vendor files alone', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'cthd-strip-'));
  try {
    const v = path.join(dir, 'v');
    await mkdir(path.join(v, 'js', 'core'), { recursive: true });
    await mkdir(path.join(v, 'js', 'boot'), { recursive: true });
    await mkdir(path.join(v, 'js', 'vendor'), { recursive: true });
    await writeFile(path.join(v, 'js', 'core', 'm.js'), [
      '// @ts-check',
      '/** A note. @param {string} s */',
      "import { x } from './x.js'; // trailing",
      "export const url = 'https://api.weather.gov/alerts'; /* block */",
      'export const re = /\\/\\*not a comment\\*\\//g;',
      'export const tpl = `a // b /* c */ ${x}`;',
      'export const cast = /** @type {number} */ (Number(x));',
      '',
    ].join('\n'));
    await writeFile(path.join(v, 'js', 'boot', 'flags.js'), '// classic script\n(function () { var a = 1; })();\n');
    await writeFile(path.join(v, 'js', 'vendor', 'lib.js'), '/* vendored */\nexport const y = 1;\n');

    assert.equal(await stripComments(v), 1);
    const m = await readFile(path.join(v, 'js', 'core', 'm.js'), 'utf8');
    assert.doesNotMatch(m, /@ts-check|A note|trailing|block \*\/|@type/);
    assert.match(m, /'https:\/\/api\.weather\.gov\/alerts'/);
    assert.ok(m.includes('/\\/\\*not a comment\\*\\//g'), 'regex literals survive');
    assert.ok(m.includes('`a // b /* c */ ${x}`'), 'template literals survive');
    assert.match(m, /import \{ x \} from '\.\/x\.js';/);
    assert.equal(await readFile(path.join(v, 'js', 'boot', 'flags.js'), 'utf8'), '// classic script\n(function () { var a = 1; })();\n',
      'a classic script would gain "use strict", so it keeps its original text');
    assert.equal(await readFile(path.join(v, 'js', 'vendor', 'lib.js'), 'utf8'), '/* vendored */\nexport const y = 1;\n');
    // The emitted module still evaluates to the same values.
    const mod = await import(`data:text/javascript,${encodeURIComponent(m.replace("import { x } from './x.js';", 'const x = 7;'))}`);
    assert.equal(mod.cast, 7);
    assert.equal(mod.tpl, 'a // b /* c */ 7');
    assert.equal('/*not a comment*/'.replace(mod.re, ''), '');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
