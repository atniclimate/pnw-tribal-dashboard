// @ts-check
/**
 * check:csp (blueprint 2.6, 10.1). Each page carries one meta Content-Security-Policy generated from the
 * source registry (data/sources/*.yaml). Hosts come from sources whose `access.mode` is `direct`,
 * `direct+snapshot`, `image`, `tiles`, or `video` and whose `usedBy` lists the page.
 *
 *   node scripts/check/csp.mjs --check   fail when any page's CSP differs from its derived policy
 *   node scripts/check/csp.mjs --write   rewrite every page's CSP meta line (the only writer of that line)
 *
 * Also fails when a policy contains `blob:`, `'unsafe-eval'`, or `'unsafe-inline'` (none passes without an
 * ADR; this check has no exemption list), or when a map page lacks `worker-src 'self'` or a tile host in
 * both `img-src` and `connect-src`. Pages under site/classic/, site/static/, and site/data/ are excluded.
 * Owner: lane L15.
 */
import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ROOT, SITE, isMain, listPages } from './lib/pages.mjs';
import { parseDataFile } from './lib/data-files.mjs';

const MODES_CONNECT = new Set(['direct', 'direct+snapshot', 'tiles']);
const META_RE = /<meta http-equiv="Content-Security-Policy" content="([^"]*)">/;

/**
 * Host expression for a CSP source list from a source URL or template. Template placeholders in the host
 * (`{s}`, `{a-c}`) become the CSP wildcard `*`; the port is kept; the path is dropped.
 * @param {string} url
 * @returns {string | null}
 */
export function hostOf(url) {
  const m = /^https?:\/\/([^/?#]+)/i.exec(url);
  if (!m) return null;
  const raw = (m[1] ?? '').replace(/\{[^}]*\}/g, '*').toLowerCase();
  return raw.includes('@') ? null : raw;
}

/**
 * @typedef {{ id: string, url: string, urlTemplate?: string, access: { mode: string }, usedBy: string[], status?: string }} SourceLike
 */

/**
 * The page id a page declares through `<body data-page="...">`, or null.
 * @param {string} html
 */
export function pageIdOf(html) {
  return /<body[^>]*\bdata-page="([^"]+)"/.exec(html)?.[1] ?? null;
}

/**
 * Whether a page draws a map or a boundary display (markers L0 and L8 write into panel skeletons).
 * @param {string} html
 */
export function isMapPage(html) {
  return /\bdata-(?:map-panel|boundary-display|map)\b/.test(html);
}

/**
 * The derived policy for one page.
 * @param {string | null} pageId
 * @param {SourceLike[]} sources
 * @returns {string}
 */
export function expectedCsp(pageId, sources) {
  /** @type {Set<string>} */ const img = new Set();
  /** @type {Set<string>} */ const media = new Set();
  /** @type {Set<string>} */ const connect = new Set();
  for (const s of sources) {
    if (!pageId || !s.usedBy.includes(pageId)) continue;
    if (['deprecated', 'retired'].includes(String(s.status))) continue;
    const mode = s.access.mode;
    const h = hostOf(s.urlTemplate ?? s.url) ?? hostOf(s.url);
    if (!h) continue;
    if (MODES_CONNECT.has(mode)) connect.add(h);
    if (mode === 'image' || mode === 'tiles') img.add(h);
    if (mode === 'video') media.add(h);
  }
  /** @param {Set<string>} set */
  const list = (set) => [...set].sort().map((h) => ` https://${h}`).join('');
  return [
    "default-src 'self'", "script-src 'self'", "style-src 'self'", "font-src 'self'", "worker-src 'self'",
    `img-src 'self' data:${list(img)}`,
    `media-src 'self'${list(media)}`,
    `connect-src 'self'${list(connect)}`,
    "frame-src 'none'", "object-src 'none'", "base-uri 'self'", "form-action 'none'", 'upgrade-insecure-requests',
  ].join('; ');
}

/** @param {string} policy @returns {Map<string, string[]>} directive to source expressions */
export function parsePolicy(policy) {
  /** @type {Map<string, string[]>} */
  const out = new Map();
  for (const part of policy.split(';')) {
    const [name, ...vals] = part.trim().split(/\s+/);
    if (name) out.set(name, vals);
  }
  return out;
}

/**
 * Problems for one page.
 * @param {string} html
 * @param {SourceLike[]} sources
 * @returns {string[]}
 */
export function cspProblems(html, sources) {
  const m = META_RE.exec(html);
  if (!m) return ['no Content-Security-Policy meta line'];
  const actual = m[1] ?? '';
  /** @type {string[]} */
  const problems = [];
  const pageId = pageIdOf(html);
  const want = expectedCsp(pageId, sources);
  if (actual !== want) problems.push(`CSP differs from the registry-derived policy for "${pageId ?? 'unknown page'}"\n    have: ${actual}\n    want: ${want}`);
  const dirs = parsePolicy(actual);
  const all = [...dirs.values()].flat();
  if (all.some((v) => v.startsWith('blob:'))) problems.push('CSP contains blob: (never allowed)');
  if (all.includes("'unsafe-eval'")) problems.push("CSP contains 'unsafe-eval' (never allowed)");
  if (all.includes("'unsafe-inline'")) problems.push("CSP contains 'unsafe-inline' (requires an ADR; none is recognized by this check)");
  if (isMapPage(html)) {
    if (!(dirs.get('worker-src') ?? []).includes("'self'")) problems.push("map page lacks worker-src 'self'");
    const tileHosts = sources
      .filter((s) => s.access.mode === 'tiles' && pageId && s.usedBy.includes(pageId) && !['deprecated', 'retired'].includes(String(s.status)))
      .map((s) => hostOf(s.urlTemplate ?? s.url))
      .filter((h) => h);
    for (const h of tileHosts) {
      for (const d of ['img-src', 'connect-src']) {
        if (!(dirs.get(d) ?? []).includes(`https://${h}`)) problems.push(`map page lacks tile host ${h} in ${d}`);
      }
    }
  }
  return problems;
}

/** @returns {Promise<SourceLike[]>} */
export async function loadSources() {
  /** @type {SourceLike[]} */
  const out = [];
  let names = [];
  try { names = (await readdir(path.join(ROOT, 'data', 'sources'))).filter((n) => n.endsWith('.yaml')).sort(); } catch { return out; }
  for (const n of names) out.push(/** @type {SourceLike} */ (await parseDataFile(`data/sources/${n}`)));
  return out;
}

/**
 * Rewrite the CSP meta line of a page's HTML to the derived policy.
 * @param {string} html @param {SourceLike[]} sources
 */
export function writeCsp(html, sources) {
  return html.replace(META_RE, `<meta http-equiv="Content-Security-Policy" content="${expectedCsp(pageIdOf(html), sources)}">`);
}

async function main() {
  const write = process.argv.includes('--write');
  const sources = await loadSources();
  let failed = 0;
  let changed = 0;
  for (const rel of await listPages()) {
    const file = path.join(SITE, rel);
    const html = await readFile(file, 'utf8');
    if (write) {
      const next = writeCsp(html, sources);
      if (next !== html) { await writeFile(file, next); changed += 1; }
      continue;
    }
    for (const p of cspProblems(html, sources)) { failed += 1; console.error(`check:csp site/${rel}: ${p}`); }
  }
  if (write) { console.log(`check:csp --write updated ${changed} page(s) from ${sources.length} source record(s)`); return; }
  if (failed) { console.error(`check:csp failed: ${failed} problem(s)`); process.exit(1); }
  console.log(`check:csp ok (${(await listPages()).length} pages against ${sources.length} source record(s))`);
}

if (isMain(import.meta.url)) await main();
