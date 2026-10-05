// @ts-check
/**
 * check:no-fabrication (blueprint 10.1, 10.3 check 4). Fails on:
 *   - a numeric array literal of five or more values in site/static/js/pages/ or site/static/js/ui/
 *     (hard-coded series are how fabricated charts and tables get in);
 *   - "sample", "placeholder", "simulated", "dummy", "fake", or "lorem" as a value in site/ or data/
 *     (HTML text and attribute values, JavaScript string literals, and every string in JSON, YAML, and CSV);
 *   - a fixture, mock, or sample file outside tests/ (a path segment named fixture, fixtures, mock, mocks,
 *     sample, or samples, or a file name ending .fixture.* or .mock.*, under site/ or data/).
 * Exempt: site/classic/ (preserved May 2026 page), site/static/vendor/, site/static/fonts/, tests/.
 * Owner: lane L15.
 */
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { ROOT, isMain } from './lib/pages.mjs';
import { parseDataFile } from './lib/data-files.mjs';
import { jsStrings, visibleText } from './copy.mjs';

const EXEMPT = ['site/classic/', 'site/static/vendor/', 'site/static/fonts/', 'node_modules/'];
export const FORBIDDEN_WORDS = /\b(sample|samples|placeholder|placeholders|simulated|dummy|fake|lorem)\b/i;
const NUM_ARRAY = /\[\s*[-+]?\d+(?:\.\d+)?(?:\s*,\s*[-+]?\d+(?:\.\d+)?){4,}\s*,?\s*\]/g;
const FIXTURE_SEGMENT = /(^|\/)(fixtures?|mocks?|samples?)(\/|$)/;
const FIXTURE_NAME = /\.(fixture|mock)\.[a-z]+$/;

/** @param {string} rel */
const exempt = (rel) => EXEMPT.some((p) => rel.startsWith(p));

/**
 * A JavaScript source with comments and string literals blanked, so array detection ignores both.
 * @param {string} src
 */
export function codeOnly(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const ch = src[i];
    const next = src[i + 1];
    if (ch === '/' && next === '/') { while (i < n && src[i] !== '\n') i += 1; continue; }
    if (ch === '/' && next === '*') { const end = src.indexOf('*/', i + 2); const stop = end < 0 ? n : end + 2; out += src.slice(i, stop).replace(/[^\n]/g, ' '); i = stop; continue; }
    if (ch === "'" || ch === '"' || ch === '`') {
      let j = i + 1;
      while (j < n && src[j] !== ch) { if (src[j] === '\\') j += 1; j += 1; }
      out += `${ch}${' '.repeat(Math.max(0, j - i - 1))}${ch}`;
      i = j + 1;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

/**
 * @param {string} rel repository-relative path
 * @param {string} content
 * @returns {string[]}
 */
export function fileProblems(rel, content) {
  /** @type {string[]} */
  const problems = [];
  if (exempt(rel)) return problems;
  if ((rel.startsWith('site/') || rel.startsWith('data/')) && (FIXTURE_SEGMENT.test(rel) || FIXTURE_NAME.test(rel))) {
    problems.push(`${rel}: fixture, mock, or sample file outside tests/`);
  }
  if (rel.startsWith('site/static/js/pages/') || rel.startsWith('site/static/js/ui/')) {
    for (const m of codeOnly(content).matchAll(NUM_ARRAY)) {
      const line = content.slice(0, m.index ?? 0).split('\n').length;
      problems.push(`${rel}:${line}: numeric array literal of five or more values`);
    }
  }
  if (rel.endsWith('.html')) {
    const attrValues = [...content.matchAll(/\s(?:alt|title|aria-label|value|content)="([^"]*)"/g)].map((m) => m[1] ?? '');
    for (const t of [...visibleText(content), ...attrValues]) {
      const m = FORBIDDEN_WORDS.exec(t);
      if (m) problems.push(`${rel}: "${m[0]}" in "${t.slice(0, 60)}"`);
    }
  } else if (rel.endsWith('.js') && rel.startsWith('site/')) {
    for (const s of jsStrings(content)) {
      if (!/\s/.test(s)) continue;
      const m = FORBIDDEN_WORDS.exec(s);
      if (m) problems.push(`${rel}: "${m[0]}" in string "${s.slice(0, 60)}"`);
    }
  }
  return problems;
}

/**
 * Forbidden words as values in parsed data: every string value, never a key.
 * @param {string} rel @param {unknown} value @param {string} [at]
 * @returns {string[]}
 */
export function dataProblems(rel, value, at = '$') {
  /** @type {string[]} */
  const problems = [];
  if (typeof value === 'string') {
    const m = FORBIDDEN_WORDS.exec(value);
    if (m) problems.push(`${rel}: "${m[0]}" as a value at ${at}`);
  } else if (Array.isArray(value)) value.forEach((v, i) => problems.push(...dataProblems(rel, v, `${at}[${i}]`)));
  else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) problems.push(...dataProblems(rel, v, `${at}.${k}`));
  return problems;
}

/** @param {string} dir @param {string[]} out */
async function walk(dir, out) {
  let entries;
  try { entries = await readdir(path.join(ROOT, dir), { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const rel = `${dir}/${e.name}`;
    if (exempt(`${rel}/`)) continue;
    if (e.isDirectory()) await walk(rel, out); else out.push(rel);
  }
}

if (isMain(import.meta.url)) {
  /** @type {string[]} */
  const files = [];
  for (const d of ['site', 'data']) await walk(d, files);
  let failed = 0;
  for (const rel of files) {
    /** @type {string[]} */
    let problems = [];
    if (/\.(html|js)$/.test(rel)) problems = fileProblems(rel, await readFile(path.join(ROOT, rel), 'utf8'));
    else if (/\.(json|ya?ml|csv)$/.test(rel) && !exempt(rel)) {
      problems = fileProblems(rel, '');
      try { problems.push(...dataProblems(rel, await parseDataFile(rel))); } catch { /* unparseable files are validate:data's concern */ }
    } else problems = fileProblems(rel, '');
    for (const p of problems) { failed += 1; console.error(`check:no-fabrication ${p}`); }
  }
  if (failed) { console.error(`check:no-fabrication failed: ${failed} problem(s)`); process.exit(1); }
  console.log(`check:no-fabrication ok (${files.length} files)`);
}
