// @ts-check
/**
 * `npm run check:contrast` (blueprint 9.5, 10.1). Resolves every pair in tests/fixtures/contrast-pairs.json
 * against site/static/css/tokens.css in the pair's theme layer and fails when a ratio is below the
 * pair's minimum: 4.5 for text, 3.0 for large text (19 px bold or 24 px regular and larger) and for
 * non-text marks (status shapes, band keylines, focus rings, boundary lines). Pairs marked
 * `"expect": "below"` document a combination the design forbids (for example white on Severe) and fail
 * if they ever start passing, which would mean a token changed underneath the rule. Owner: lane L1.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT, contrast, readTokens, resolve } from './tokens.mjs';

/** @type {Readonly<Record<string, number>>} */
export const MINIMUM = Object.freeze({ text: 4.5, large: 3.0, nontext: 3.0 });

/**
 * @typedef {{ fg: string, bg: string, kind: 'text' | 'large' | 'nontext', theme?: 'dark' | 'light', expect?: 'pass' | 'below', use: string }} Pair
 */

/**
 * @param {string} v a token name (--x) or a hex literal
 * @param {Map<string, string>} tokens
 * @returns {string}
 */
function color(v, tokens) {
  return v.startsWith('--') ? resolve(`var(${v})`, tokens) : v;
}

/**
 * @returns {Promise<{ problems: string[], rows: { pair: Pair, ratio: number, min: number }[] }>}
 */
export async function checkContrast() {
  const themes = await readTokens();
  /** @type {{ pairs: Pair[] }} */
  const fixture = JSON.parse(await readFile(path.join(ROOT, 'tests', 'fixtures', 'contrast-pairs.json'), 'utf8'));
  /** @type {string[]} */
  const problems = [];
  const rows = [];
  for (const pair of fixture.pairs) {
    const tokens = pair.theme === 'light' ? themes.light : themes.dark;
    const min = /** @type {number} */ (MINIMUM[pair.kind]);
    let ratio;
    try { ratio = contrast(color(pair.fg, tokens), color(pair.bg, tokens)); } catch (e) {
      problems.push(`${pair.fg} on ${pair.bg}: ${/** @type {Error} */ (e).message}`);
      continue;
    }
    rows.push({ pair, ratio, min });
    const below = ratio < min;
    if (pair.expect === 'below' && !below) problems.push(`${pair.fg} on ${pair.bg} (${pair.theme ?? 'dark'}) is documented as forbidden but now measures ${ratio}:1; review the rule (${pair.use})`);
    if (pair.expect !== 'below' && below) problems.push(`${pair.fg} on ${pair.bg} (${pair.theme ?? 'dark'}, ${pair.kind}) is ${ratio}:1, below ${min}:1 (${pair.use})`);
  }
  return { problems, rows };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const { problems, rows } = await checkContrast();
  if (process.argv.includes('--table')) for (const r of rows) console.log(`${r.ratio.toFixed(2).padStart(6)}  ${r.pair.kind.padEnd(7)} ${(r.pair.theme ?? 'dark').padEnd(5)} ${r.pair.fg} on ${r.pair.bg}  ${r.pair.use}`);
  if (problems.length) {
    for (const p of problems) console.error(p);
    console.error(`check:contrast: ${problems.length} problem(s)`);
    process.exit(1);
  }
  console.log(`check:contrast: ${rows.length} pairs meet their minimums`);
}
