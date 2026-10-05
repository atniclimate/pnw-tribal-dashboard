// @ts-check
/**
 * check:chrome (blueprint 1.3, 10.1). Fails when the static chrome blocks between <!-- chrome:start --> and
 * <!-- chrome:end --> differ across pages, apart from the relative prefix of link targets and the
 * aria-current marker on the current navigation item. Every page under site/ (except classic/) must carry
 * exactly two chrome blocks: header, primary nav, and embed bar; then footer and bottom bar.
 * Owner: lane L0.
 */
import { blocks, isMain, listPages, readPage } from './lib/pages.mjs';

const REFERENCE = 'index.html';

/**
 * Normalize one chrome block for comparison.
 * @param {string} inner
 */
export function normalizeChrome(inner) {
  return inner
    .replace(/\s+aria-current="page"/g, '')
    .replace(/\b(href|src)="(?:\.\/|(?:\.\.\/)+)/g, '$1="{root}/')
    .split('\n')
    .map((l) => l.trimEnd())
    .join('\n')
    .trim();
}

/**
 * @param {string} html
 * @returns {string[]} problems
 */
export function chromeProblems(html) {
  const found = blocks(html, 'chrome');
  /** @type {string[]} */
  const problems = [];
  if (found.length !== 2) problems.push(`expected 2 chrome blocks, found ${found.length}`);
  const current = (html.match(/aria-current="page"/g) ?? []).length;
  if (current > 1) problems.push(`expected at most one aria-current="page", found ${current}`);
  return problems;
}

async function main() {
  const pages = await listPages();
  const refHtml = await readPage(REFERENCE);
  const ref = blocks(refHtml, 'chrome').map((b) => normalizeChrome(b.inner));
  let failures = 0;
  for (const rel of pages) {
    const html = await readPage(rel);
    const problems = chromeProblems(html);
    const got = blocks(html, 'chrome').map((b) => normalizeChrome(b.inner));
    got.forEach((g, i) => {
      const want = ref[i];
      if (want === undefined || g === want) return;
      const gl = g.split('\n');
      const wl = want.split('\n');
      const at = gl.findIndex((line, j) => line !== wl[j]);
      problems.push(`chrome block ${i + 1} differs from ${REFERENCE} at line ${at + 1}: "${(gl[at] ?? '').trim()}" vs "${(wl[at] ?? '').trim()}"`);
    });
    if (problems.length) {
      failures += 1;
      for (const p of problems) console.error(`check:chrome ${rel}: ${p}`);
    }
  }
  if (failures) {
    console.error(`check:chrome failed on ${failures} of ${pages.length} pages`);
    process.exit(1);
  }
  console.log(`check:chrome ok (${pages.length} pages)`);
}

if (isMain(import.meta.url)) await main();
