// @ts-check
/**
 * check:copy (blueprint 10.1). Fails on:
 *   - U+2014 (em dash) anywhere in site/, data/, README.md, or DATA.md;
 *   - a visible date that is not MM/DD/YYYY (an ISO date, or a slash date with a short month, day, or year);
 *   - lowercase "tribe", "tribes", "tribal", "treaty", or "treaties" in visible text (URLs and ids exempt);
 *   - a listed short form shown as a Nation's visible name (an element marked `data-nation-name`).
 *
 * Exempt by design: site/classic/ (the preserved May 2026 page), tests/fixtures/ (verbatim upstream
 * captures), site/static/vendor/, site/static/fonts/, and generated site/data/curated and site/data/live
 * (their text is checked at its source in data/). docs/ is local and gitignored; pass `--docs` to scan it
 * (docs/legacy/ stays exempt). Visible text means HTML text nodes and user-facing attributes, plus string
 * literals in site/static/js. Owner: lane L15.
 */
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { ROOT, isMain } from './lib/pages.mjs';
import { parseDataFile } from './lib/data-files.mjs';

export const EM_DASH = '—';
const EXEMPT_PREFIXES = ['site/classic/', 'tests/fixtures/', 'site/static/vendor/', 'site/static/fonts/', 'site/data/curated/', 'site/data/live/', 'docs/legacy/', 'node_modules/'];
const TEXT_EXT = /\.(html|js|mjs|css|json|ya?ml|csv|txt|md|webmanifest|svg)$/;
const LOWER_WORDS = /(?<![\w\-/.#@:])(tribe|tribes|tribal|treaty|treaties)(?![\w\-/@])/g;

/** @param {string} rel repository-relative with forward slashes */
export function isExempt(rel) {
  return EXEMPT_PREFIXES.some((p) => rel.startsWith(p));
}

/**
 * String literal bodies of JavaScript source, skipping comments. Template expressions are skipped; only
 * the literal text parts are returned.
 * @param {string} src
 * @returns {string[]}
 */
export function jsStrings(src) {
  /** @type {string[]} */
  const out = [];
  let i = 0;
  const n = src.length;
  while (i < n) {
    const ch = src[i];
    const next = src[i + 1];
    if (ch === '/' && next === '/') { while (i < n && src[i] !== '\n') i += 1; continue; }
    if (ch === '/' && next === '*') { const end = src.indexOf('*/', i + 2); i = end < 0 ? n : end + 2; continue; }
    if (ch === "'" || ch === '"') {
      let j = i + 1;
      let body = '';
      while (j < n && src[j] !== ch && src[j] !== '\n') { if (src[j] === '\\') { body += src[j + 1] ?? ''; j += 2; } else { body += src[j]; j += 1; } }
      out.push(body);
      i = j + 1;
      continue;
    }
    if (ch === '`') {
      let j = i + 1;
      let body = '';
      while (j < n && src[j] !== '`') {
        if (src[j] === '\\') { body += src[j + 1] ?? ''; j += 2; continue; }
        if (src[j] === '$' && src[j + 1] === '{') {
          out.push(body); body = '';
          let depth = 1;
          j += 2;
          while (j < n && depth > 0) { if (src[j] === '{') depth += 1; else if (src[j] === '}') depth -= 1; j += 1; }
          continue;
        }
        body += src[j];
        j += 1;
      }
      out.push(body);
      i = j + 1;
      continue;
    }
    i += 1;
  }
  return out;
}

/**
 * Visible text of an HTML page: text nodes plus user-facing attribute values, one string per piece.
 * @param {string} html
 * @returns {string[]}
 */
export function visibleText(html) {
  const stripped = html.replace(/<!--[\s\S]*?-->/g, '').replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '');
  /** @type {string[]} */
  const out = [];
  for (const m of stripped.matchAll(/(?:alt|title|aria-label|placeholder)="([^"]*)"/g)) out.push(m[1] ?? '');
  const meta = /<meta name="description" content="([^"]*)"/.exec(stripped);
  if (meta) out.push(meta[1] ?? '');
  const text = stripped.replace(/<[^>]*>/g, '\n');
  for (const piece of text.split('\n')) { const t = decodeEntities(piece).trim(); if (t) out.push(t); }
  return out;
}

/** @param {string} s */
function decodeEntities(s) {
  return s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d))).replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)));
}

/** @param {string} text @returns {string[]} problems for one piece of visible text */
export function textProblems(text) {
  /** @type {string[]} */
  const problems = [];
  const noUrls = text.replace(/https?:\/\/\S+/g, ' ').replace(/\b[\w.-]+@[\w.-]+\b/g, ' ');
  for (const m of noUrls.matchAll(LOWER_WORDS)) problems.push(`lowercase "${m[1]}" in visible text: ${excerpt(noUrls, m.index ?? 0)}`);
  for (const m of noUrls.matchAll(/(?<![\d/-])\d{4}-\d{2}-\d{2}(?![\d-])/g)) problems.push(`ISO date "${m[0]}" in visible text (use MM/DD/YYYY)`);
  for (const m of noUrls.matchAll(/(?<![\d/.])(\d{1,2})\/(\d{1,2})\/(\d{2,4})(?![\d/])/g)) {
    if ((m[1] ?? '').length !== 2 || (m[2] ?? '').length !== 2 || (m[3] ?? '').length !== 4) problems.push(`date "${m[0]}" is not MM/DD/YYYY`);
  }
  return problems;
}

/** @param {string} s @param {number} at */
function excerpt(s, at) {
  return `"${s.slice(Math.max(0, at - 24), at + 32).replace(/\s+/g, ' ')}"`;
}

/**
 * Problems in one file's content.
 * @param {string} rel repository-relative path
 * @param {string} content
 * @param {{ shortForms?: Set<string> }} [opts]
 * @returns {string[]}
 */
export function fileProblems(rel, content, opts = {}) {
  /** @type {string[]} */
  const problems = [];
  if (isExempt(rel)) return problems;
  if (content.includes(EM_DASH)) {
    const line = content.slice(0, content.indexOf(EM_DASH)).split('\n').length;
    problems.push(`${rel}:${line}: em dash (U+2014)`);
  }
  if (rel.endsWith('.html')) {
    for (const t of visibleText(content)) for (const p of textProblems(t)) problems.push(`${rel}: ${p}`);
    for (const m of content.matchAll(/data-nation-name[^>]*>([^<]*)</g)) {
      const name = (m[1] ?? '').trim().toLowerCase();
      if (opts.shortForms?.has(name)) problems.push(`${rel}: short form "${m[1]}" shown as a Nation name`);
    }
  } else if (rel.startsWith('site/static/js/') && rel.endsWith('.js')) {
    for (const s of jsStrings(content)) {
      if (!/\s/.test(s)) continue; // ids, keys, and selectors have no spaces; prose does
      for (const m of s.replace(/https?:\/\/\S+/g, ' ').matchAll(LOWER_WORDS)) problems.push(`${rel}: lowercase "${m[1]}" in string "${s.slice(0, 60)}"`);
    }
  } else if (rel === 'README.md' || rel === 'DATA.md') {
    const prose = content.replace(/```[\s\S]*?```/g, ' ').replace(/`[^`]*`/g, ' ').replace(/\]\([^)]*\)/g, ']');
    for (const t of prose.split('\n')) for (const p of textProblems(t).filter((x) => x.startsWith('lowercase'))) problems.push(`${rel}: ${p}`);
  }
  return problems;
}

/** @param {string} dir @param {string[]} out */
async function walk(dir, out) {
  let entries;
  try { entries = await readdir(path.join(ROOT, dir), { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const rel = `${dir}/${e.name}`;
    if (isExempt(`${rel}/`) || isExempt(rel)) continue;
    if (e.isDirectory()) await walk(rel, out);
    else if (TEXT_EXT.test(e.name)) out.push(rel);
  }
}

/** @returns {Promise<Set<string>>} lowercase aliases of every Nation found in the registry or its fixture */
async function loadShortForms() {
  /** @type {Set<string>} */
  const set = new Set();
  for (const dir of ['site/data/registry/nations', 'tests/fixtures/registry/nations']) {
    let names = [];
    try { names = (await readdir(path.join(ROOT, dir))).filter((n) => n.endsWith('.json')); } catch { continue; }
    for (const n of names) {
      const rec = /** @type {any} */ (await parseDataFile(`${dir}/${n}`));
      for (const a of rec.aliases ?? []) set.add(String(a).toLowerCase());
    }
  }
  return set;
}

if (isMain(import.meta.url)) {
  /** @type {string[]} */
  const files = ['README.md', 'DATA.md'];
  for (const d of ['site', 'data']) await walk(d, files);
  if (process.argv.includes('--docs')) await walk('docs', files);
  const shortForms = await loadShortForms();
  let failed = 0;
  let scanned = 0;
  for (const rel of files) {
    let content;
    try { content = await readFile(path.join(ROOT, rel), 'utf8'); } catch { continue; }
    scanned += 1;
    for (const p of fileProblems(rel, content, { shortForms })) { failed += 1; console.error(`check:copy ${p}`); }
  }
  if (failed) { console.error(`check:copy failed: ${failed} problem(s) in ${scanned} file(s)`); process.exit(1); }
  console.log(`check:copy ok (${scanned} files)`);
}
