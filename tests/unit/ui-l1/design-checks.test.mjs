// @ts-check
/**
 * Lane L1 acceptance (blueprint 12.3): token and contrast checks pass, including the Severe ink correction
 * and the extreme keyline; fonts coverage passes on the sixty-name fixture (and the registry once
 * committed); the latin woff2 faces total at most 90 KB; no raw hex outside tokens.css; reduced motion
 * zeroes every duration; CSS within budget. Each check also proves it can fail. Owner: lane L1.
 */
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { checkContrast } from '../../../scripts/check/contrast.mjs';
import { LATIN_BUDGET_BYTES, checkFonts, parseUnicodeRange } from '../../../scripts/check/fonts-coverage.mjs';
import { checkTokens, contrast, derivedTokens, lintStylesheet, readTokens, resolve } from '../../../scripts/check/tokens.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const CSS = path.join(ROOT, 'site', 'static', 'css');

describe('check:tokens', () => {
  test('tokens.css matches the canonical design system and every stylesheet follows the rules', async () => {
    assert.deepEqual(await checkTokens(), []);
  });

  test('the linter catches raw colors, radius, dark shadows, and reserved colors out of place', async () => {
    const t = (await readTokens()).dark;
    const ctx = { isTokens: false, magenta: derivedTokens(t, ['--tribal-magenta', '--color-tribal-magenta']), red: derivedTokens(t, ['--atni-red', '--color-atni-red']) };
    const lint = (/** @type {string} */ css) => lintStylesheet('probe.css', css, ctx);
    assert.equal(lint('.a { color: #FFF; }').length, 1);
    assert.equal(lint('.a { background: rgba(0, 0, 0, 0.5); }').length, 1);
    assert.equal(lint('.a { border-radius: 4px; }').length, 1);
    assert.equal(lint('.a { box-shadow: 0 1px 3px var(--ground); }').length, 1);
    assert.equal(lint('.a:focus-visible { box-shadow: 0 0 0 4px var(--focus-outer); }').length, 0);
    assert.equal(lint('.chart-bar { fill: var(--tribal-magenta); }').length, 1);
    assert.equal(lint('.btn--danger { background: var(--callout-sovereignty-rule); }').length, 1);
    assert.equal(lint('.sovereignty-note { border-color: var(--tribal-magenta); }').length, 0);
    assert.equal(lint('.alert-card__title { color: var(--atni-red); }').length, 1);
    assert.equal(lint('.btn--primary.alert-banner__cta { background: var(--atni-red); }').length, 1);
    assert.equal(lint('.btn--primary { background: var(--atni-red); }').length, 0);
    assert.equal(lint('.status-pill { color: var(--callout-note-rule); }').length, 1);
  });
});

describe('check:contrast', () => {
  test('every pair meets its minimum and every forbidden pair stays forbidden', async () => {
    const { problems, rows } = await checkContrast();
    assert.deepEqual(problems, []);
    assert.ok(rows.length >= 60);
  });

  test('the Severe ink correction and the extreme keyline hold', async () => {
    const t = (await readTokens()).dark;
    const c = (/** @type {string} */ fg, /** @type {string} */ bg) => contrast(resolve(`var(${fg})`, t), resolve(`var(${bg})`, t));
    assert.equal(resolve('var(--band-severe-ink)', t), '#010B13');
    assert.ok(c('--band-severe-ink', '--band-severe-bg') >= 4.5);
    assert.ok(contrast('#FFFFFF', resolve('var(--band-severe-bg)', t)) < 4.5, 'white on Severe stays below AA');
    assert.ok(c('--band-extreme-keyline', '--surface-raised') >= 3);
    assert.ok(c('--band-extreme-bg', '--surface-raised') < 3, 'Extreme needs its keyline');
  });
});

describe('check:fonts', () => {
  test('every name in the sixty-name fixture (and the registry when present) is drawn by served faces', async () => {
    const r = await checkFonts();
    assert.deepEqual(r.problems, []);
    assert.ok(r.latinBytes <= LATIN_BUDGET_BYTES, `latin woff2 total ${r.latinBytes} bytes`);
  });

  test('a character no served face covers is reported', async () => {
    const r = await checkFonts({ names: [{ text: 'Tsalagi ᎠᏎᎢ', from: 'probe' }] });
    assert.ok(r.problems.some((p) => p.includes('U+13A0')), r.problems.join('\n'));
  });

  test('the sixty-name fixture holds sixty sourced names with the hard British Columbia characters', async () => {
    const f = JSON.parse(await readFile(path.join(ROOT, 'tests', 'fixtures', 'names-60.json'), 'utf8'));
    assert.equal(f.names.length, 60);
    for (const n of f.names) {
      assert.ok(n.name && n.source && n.ref && n.checkedAt, JSON.stringify(n));
      assert.ok(Object.hasOwn(f.sources, n.source), n.source);
    }
    const all = f.names.map((/** @type {{ name: string }} */ n) => n.name).join(' ');
    for (const ch of ['ʔ', 'ƛ', 'q̓', 'ł', 'x̌', 'ʷ', 'x̱', 'ḵ', 'ə', 'ɬ', 'ⱡ']) assert.ok(all.includes(ch), `fixture exercises ${ch}`);
  });

  test('unicode-range parsing', () => {
    assert.deepEqual(parseUnicodeRange('U+0000-00FF, U+0131, U+02B?'), [[0, 0xFF], [0x131, 0x131], [0x2B0, 0x2BF]]);
  });
});

describe('reduced motion and CSS budget', () => {
  test('reduced motion zeroes every duration token, and no stylesheet hard-codes a duration', async () => {
    const { reduced } = await readTokens();
    for (const k of ['--dur-micro', '--dur-fast', '--dur-base', '--dur-slow']) assert.equal(reduced.get(k), '0ms', k);
    for (const f of (await readdir(CSS)).filter((x) => x.endsWith('.css') && x !== 'tokens.css' && x !== 'map.css')) {
      const css = (await readFile(path.join(CSS, f), 'utf8')).replace(/\/\*[\s\S]*?\*\//g, '');
      for (const m of css.matchAll(/(transition|animation)(-duration)?\s*:\s*([^;}]*)/g)) {
        assert.ok(!/(^|[\s,])\d*\.?\d+m?s\b/.test(m[3] ?? ''), `${f}: ${m[0]} uses a literal duration instead of a --dur token`);
      }
    }
  });

  test('critical CSS (tokens, fonts, base, layout, components) is within the gzip budget', async () => {
    const budgets = JSON.parse(await readFile(path.join(ROOT, 'budgets.json'), 'utf8'));
    let total = 0;
    for (const f of ['tokens', 'fonts', 'base', 'layout', 'components']) total += gzipSync(await readFile(path.join(CSS, `${f}.css`)), { level: 9 }).length;
    assert.ok(total <= budgets.bytes.cssCritical.gzipMax, `${total} bytes gzip > ${budgets.bytes.cssCritical.gzipMax}`);
  });
});
