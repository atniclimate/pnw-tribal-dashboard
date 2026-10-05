// @ts-check
/**
 * check:preload (blueprint 2.5, 10.1). For every page, the <link rel="modulepreload"> list between
 * <!-- modulepreload:start --> and <!-- modulepreload:end --> must equal the page entry module plus every
 * module in its static import graph: nothing missing, nothing unused. Dynamic import() targets and
 * anything under static/vendor/ are ignored.
 *
 *   node scripts/check/modulepreload.mjs            check
 *   node scripts/check/modulepreload.mjs --write    rewrite each page's block from the import graph
 *
 * Owner: lane L0. Page lanes that change a page's static imports run --write and hand the head change to
 * L0's owner (page heads are L0's; blueprint 12.1).
 */
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { SITE, blocks, isMain, listPages, readPage } from './lib/pages.mjs';

/**
 * Static import specifiers of an ES module source (comments stripped; dynamic import() ignored).
 * @param {string} source
 * @returns {string[]}
 */
export function staticImports(source) {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
  /** @type {string[]} */
  const out = [];
  const fromRe = /(?:^|[;\n])\s*(?:import|export)\s+(?:[^;'"`]*?\s+from\s*)?['"]([^'"]+)['"]/g;
  for (const m of code.matchAll(fromRe)) if (m[1]) out.push(m[1]);
  return out;
}

/**
 * The static module graph from an entry file, as absolute paths in discovery order (entry first).
 * @param {string} entryAbs
 * @returns {Promise<string[]>}
 */
export async function moduleGraph(entryAbs) {
  /** @type {string[]} */
  const order = [];
  const seen = new Set();
  /** @param {string} file */
  async function visit(file) {
    if (seen.has(file)) return;
    seen.add(file);
    order.push(file);
    const src = await readFile(file, 'utf8');
    for (const spec of staticImports(src)) {
      if (!spec.startsWith('.')) throw new Error(`${path.relative(SITE, file)}: bare import specifier "${spec}" (relative paths with .js only)`);
      const target = path.resolve(path.dirname(file), spec);
      if (target.split(path.sep).includes('vendor')) continue;
      await visit(target);
    }
  }
  await visit(entryAbs);
  return order;
}

/**
 * @param {string} rel page path relative to site/
 * @param {string} html
 * @returns {Promise<{ entries: string[], want: string[], have: string[], block: { start: number, end: number, inner: string } | null }>}
 */
export async function analyzePage(rel, html) {
  const pageDir = path.dirname(path.join(SITE, rel));
  const toHref = (/** @type {string} */ abs) => {
    const r = path.relative(pageDir, abs).split(path.sep).join('/');
    return r.startsWith('.') ? r : `./${r}`;
  };
  const entries = [...html.matchAll(/<script\s+type="module"\s+src="([^"]+)"/g)].map((m) => m[1] ?? '');
  /** @type {string[]} */
  const want = [];
  for (const src of entries) {
    for (const abs of await moduleGraph(path.resolve(pageDir, src))) {
      const href = toHref(abs);
      if (!want.includes(href)) want.push(href);
    }
  }
  const [block] = blocks(html, 'modulepreload');
  const have = block ? [...block.inner.matchAll(/<link\s+rel="modulepreload"\s+href="([^"]+)"/g)].map((m) => {
    const h = m[1] ?? '';
    return h.startsWith('.') ? h : `./${h}`;
  }) : [];
  return { entries, want, have, block: block ?? null };
}

async function main() {
  const write = process.argv.includes('--write');
  let failures = 0;
  let checked = 0;
  for (const rel of await listPages()) {
    const html = await readPage(rel);
    const { entries, want, have, block } = await analyzePage(rel, html);
    if (entries.length === 0) {
      if (block && have.length) { console.error(`check:preload ${rel}: modulepreload links on a page with no module entry`); failures += 1; }
      continue;
    }
    checked += 1;
    if (!block) { console.error(`check:preload ${rel}: missing <!-- modulepreload:start --> block`); failures += 1; continue; }
    if (write) {
      const inner = '\n' + want.map((h) => `  <link rel="modulepreload" href="${h}">`).join('\n') + '\n  ';
      const next = html.slice(0, block.start) + `<!-- modulepreload:start -->${inner}<!-- modulepreload:end -->` + html.slice(block.end);
      if (next !== html) await writeFile(path.join(SITE, rel), next);
      continue;
    }
    const missing = want.filter((h) => !have.includes(h));
    const unused = have.filter((h) => !want.includes(h));
    for (const h of missing) console.error(`check:preload ${rel}: missing modulepreload for ${h}`);
    for (const h of unused) console.error(`check:preload ${rel}: modulepreload ${h} is not in the static import graph`);
    if (missing.length || unused.length) failures += 1;
  }
  if (failures) {
    console.error(`check:preload failed on ${failures} page(s); run node scripts/check/modulepreload.mjs --write to regenerate`);
    process.exit(1);
  }
  console.log(`check:preload ${write ? 'wrote' : 'ok'} (${checked} pages with module entries)`);
}

if (isMain(import.meta.url)) await main();
