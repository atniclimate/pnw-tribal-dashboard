// @ts-check
/**
 * Assemble the GitHub Pages artifact (blueprint 2.1, 5.12, 8.4):
 *
 *   node scripts/assemble-site.mjs --out _site [--sha <40-hex git sha>] [--previous <live build-info.json URL or path>]
 *                                  [--sw-disabled]
 *
 * 1. Copy the allowlist: site/** except static/ (data/curated and data/live included; classic/ included
 *    until its removal date).
 * 2. Copy site/static/ to _site/v/<sha12>/ and remove comments from its modules (stripComments).
 * 3. Rewrite href and src attribute values that begin with `./static/` or `(../)*static/` in HTML files
 *    only, to the same prefix plus `v/<sha12>/`. JavaScript and CSS are never rewritten, and neither is
 *    text inside script, style, or comments.
 * 4. Retain the previous generation: read the live build-info.json, and when its sha12 differs, restore
 *    _site/v/<prev>/ from `git archive <prev> site/static` (checkout uses fetch-depth 0).
 * 5. Write _site/build-info.json (schemas/build-info.schema.json). `--sw-disabled` sets the service worker
 *    kill switch (`swDisabled: true`).
 *
 * Owner: lane L9. The worker and manifest reference the same versioned asset generation.
 */
import { execFileSync } from 'node:child_process';
import { cp, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { gzipSync } from 'node:zlib';
import { getOwn } from './lib/http.mjs';
import { extractTar } from './lib/tar.mjs';
import { publishSafety } from './lib/publish-safety.mjs';
import { staticImports } from './check/modulepreload.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Top-level entries of site/ that are deployed (static/ is deployed as v/<sha12>/). */
export const ALLOWLIST = Object.freeze(['index.html', '404.html', 'offline.html', 'sw.js', 'embed.js', 'manifest.webmanifest',
  'robots.txt', '.nojekyll', 'alerts', 'forecasts', 'contacts', 'resources', 'safety', 'news', 'usage', 'archive', 'embed', 'classic', 'data']);

/** Markup the rewrite must step over (comments, raw-text elements) or rewrite (any start tag). */
const TOKENS = /<!--[\s\S]*?-->|<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>|<[a-zA-Z][^>]*>/gi;
const ATTR = /(\s(?:href|src)\s*=\s*)(["'])((?:\.\/)?(?:\.\.\/)*)static\//gi;

/**
 * Build the small offline graph from published page heads, without maps or geometry.
 * @param {string} out
 * @param {string} sha12
 * @returns {Promise<string[]>}
 */
export async function offlineFiles(out, sha12) {
  const files = new Set(['', 'contacts/', 'safety/', 'offline.html']);
  for (const relative of [...files]) {
    const file = path.join(out, relative.endsWith('.html') ? relative : `${relative}index.html`);
    if (!(await exists(file))) { files.delete(relative); continue; }
    const html = await readFile(file, 'utf8');
    for (const match of html.matchAll(/\b(?:href|src)=["']([^"']+)["']/g)) {
      const href = match[1] ?? '';
      if (!href.includes(`v/${sha12}/`)) continue;
      const rel = path.posix.normalize(path.posix.join(path.posix.dirname(relative.endsWith('.html') ? relative : `${relative}index.html`), href));
      if (rel.startsWith(`v/${sha12}/`) && !/\/(?:map|vendor)\//.test(rel) && /\.(?:js|css|woff2|svg)$/.test(rel)) files.add(rel);
    }
  }
  for (const rel of [
    `v/${sha12}/js/core/sw-register.js`, `v/${sha12}/fonts/roboto-500-latin.woff2`,
    'data/curated/contacts.json', 'data/curated/agencies.json', 'data/curated/sources.json', 'data/curated/resources.json',
    'data/registry/nations-index.json', 'data/registry/id-redirects.json', 'data/live/alerts.json', 'data/live/tsunami.json',
    'data/geo/footprint-ugc.json', 'data/ref/nws-event-categories.json', 'data/ref/eccc-event-categories.json',
  ]) if (await exists(path.join(out, rel))) files.add(rel);
  // Follow the actual dependency graph, including CSS font subsets needed by Nation names.
  // Page preloads are an optimization; a missing preload must not break saved pages.
  for (const rel of files) {
    if (!/\.(?:js|css)$/.test(rel)) continue;
    const source = await readFile(path.join(out, rel), 'utf8');
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
    const dependencies = rel.endsWith('.js') ? [...staticImports(source),
      ...[...code.matchAll(/\bimport\(\s*["']([^"']+)["']\s*\)/g)].map((match) => match[1] ?? '')]
      : [...source.matchAll(/url\(\s*["']?([^)'"\s]+)["']?\s*\)/g)].map((match) => match[1] ?? '');
    for (const dependency of dependencies) {
      if (!dependency.startsWith('.')) continue;
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(rel), dependency));
      if (!target.startsWith(`v/${sha12}/`) || /\/(?:map|vendor)\//.test(target)) continue;
      if (!await exists(path.join(out, target))) throw new Error(`Offline dependency is missing: ${target}`);
      files.add(target);
    }
  }
  let bytes = 0;
  for (const rel of files) {
    const file = path.join(out, rel === '' || rel.endsWith('/') ? `${rel}index.html` : rel);
    const body = await readFile(file);
    bytes += rel.endsWith('.woff2') ? body.length : gzipSync(body).length;
  }
  if (bytes > 450 * 1024) throw new Error(`Offline preparation exceeds 450 KB (${bytes} bytes compressed)`);
  return [...files];
}

/**
 * Rewrite static asset references in one HTML document.
 * @param {string} html
 * @param {string} sha12
 * @returns {string}
 */
export function rewriteHtml(html, sha12) {
  if (!/^[0-9a-f]{12}$/.test(sha12)) throw new Error(`invalid sha12 "${sha12}"`);
  /** @param {string} tag */
  const fix = (tag) => tag.replace(ATTR, (_m, lead, q, up) => `${lead}${q}${up}v/${sha12}/`);
  return html.replace(TOKENS, (token, raw) => {
    if (token.startsWith('<!--')) return token;
    if (raw) {
      const end = token.indexOf('>') + 1;
      return fix(token.slice(0, end)) + token.slice(end);
    }
    return fix(token);
  });
}

/**
 * @param {string} dir
 * @returns {AsyncGenerator<string>} file paths under dir
 */
async function* walk(dir) {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else yield p;
  }
}

/**
 * Read the previous deploy's build info (absent or unusable gives null).
 * @param {string | null} location
 * @param {((input: string, init?: RequestInit) => Promise<Response>) | undefined} fetchImpl
 * @returns {Promise<{ sha: string, sha12: string, previousSha: string | null } | null>}
 */
async function readPrevious(location, fetchImpl) {
  if (!location) return null;
  const text = await getOwn(location, fetchImpl ? { fetchImpl } : {});
  if (!text) return null;
  try {
    const info = JSON.parse(text);
    if (/^[0-9a-f]{40}$/.test(info.sha) && info.sha12 === info.sha.slice(0, 12)) {
      return { sha: info.sha, sha12: info.sha12, previousSha: /^[0-9a-f]{40}$/.test(info.previousSha) ? info.previousSha : null };
    }
  } catch { /* unusable */ }
  return null;
}

/**
 * @param {{
 *   out: string, sha: string, previous: string | null,
 *   site?: string, repo?: string, swDisabled?: boolean, now?: Date, keepComments?: boolean,
 *   fetchImpl?: (input: string, init?: RequestInit) => Promise<Response>, log?: (m: string) => void,
 * }} opts
 * @returns {Promise<{ sha12: string, files: number, retained: string | null }>}
 */
export async function assemble(opts) {
  const log = opts.log ?? ((m) => console.log(`[assemble] ${m}`));
  const repo = path.resolve(opts.repo ?? ROOT);
  const site = path.resolve(opts.site ?? path.join(repo, 'site'));
  const out = path.resolve(opts.out);
  if (!/^[0-9a-f]{40}$/.test(opts.sha)) throw new Error(`--sha must be a full 40-character commit sha (got "${opts.sha}")`);
  const fold = (/** @type {string} */ value) => process.platform === 'win32' ? value.toLowerCase() : value;
  const output = fold(out);
  const source = fold(site);
  const repository = fold(repo);
  if (output === path.parse(output).root || output === repository || output === source
      || repository.startsWith(output + path.sep) || source.startsWith(output + path.sep) || output.startsWith(source + path.sep)) {
    throw new Error(`refusing to assemble into ${out}`);
  }
  const sha12 = opts.sha.slice(0, 12);
  await rm(out, { recursive: true, force: true });
  await mkdir(out, { recursive: true });

  const present = await readdir(site);
  for (const name of present.filter((n) => !ALLOWLIST.includes(n) && n !== 'static')) log(`not deployed (outside the allowlist): site/${name}`);
  for (const name of ALLOWLIST.filter((n) => present.includes(n))) {
    await cp(path.join(site, name), path.join(out, name), { recursive: true });
  }
  if (present.includes('static')) {
    await cp(path.join(site, 'static'), path.join(out, 'v', sha12), { recursive: true });
    if (!opts.keepComments) log(`removed comments from ${await stripComments(path.join(out, 'v', sha12))} shipped modules`);
  }

  let files = 0;
  for await (const file of walk(out)) {
    files++;
    if (!file.endsWith('.html') || file.startsWith(path.join(out, 'v') + path.sep)) continue;
    const html = await readFile(file, 'utf8');
    const published = path.relative(out, file).split(path.sep).join('/') === 'safety/index.html' ? publishSafety(html) : html;
    const next = rewriteHtml(published, sha12);
    if (next !== html) await writeFile(file, next);
  }

  /** @type {string | null} */
  let retained = null;
  const prev = await readPrevious(opts.previous, opts.fetchImpl);
  // Snapshot-only deployments must keep the last distinct code generation, too.
  const previousSha = prev?.sha === opts.sha ? prev.previousSha : prev?.sha ?? null;
  if (previousSha && previousSha !== opts.sha) {
    const previousSha12 = previousSha.slice(0, 12);
    try {
      const tar = execFileSync('git', ['archive', '--format=tar', previousSha, 'site/static'], { cwd: repo, maxBuffer: 512 * 1024 * 1024, windowsHide: true });
      const n = await extractTar(tar, 'site/static/', path.join(out, 'v', previousSha12));
      files += n;
      retained = n > 0 ? previousSha12 : null;
      log(n > 0 ? `retained the previous generation v/${previousSha12}/ (${n} files)` : `commit ${previousSha12} has no site/static/; nothing to retain`);
    } catch (e) {
      log(`could not retain v/${previousSha12}/ (${/** @type {Error} */ (e).message.split('\n')[0]}); pages loaded before this deploy may fail to lazy-load modules`);
    }
  } else log(prev ? `previous generation is this commit (v/${sha12}/)` : 'no previous build-info.json; nothing to retain');

  const info = { sha: opts.sha, sha12, builtAt: (opts.now ?? new Date()).toISOString(), swDisabled: Boolean(opts.swDisabled),
    ...(retained ? { previousSha } : {}) };
  if (present.includes('manifest.webmanifest')) {
    const manifestPath = path.join(out, 'manifest.webmanifest');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    for (const icon of manifest.icons ?? []) if (typeof icon.src === 'string') icon.src = icon.src.replace(/^\.\/static\//, `./v/${sha12}/`);
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  }
  if (present.includes('sw.js')) {
    const workerPath = path.join(out, 'sw.js');
    const template = await readFile(workerPath, 'utf8');
    const precache = info.swDisabled ? [] : await offlineFiles(out, sha12);
    const worker = template.replace("const BUILD = 'development'; // CTHD_BUILD", `const BUILD = '${sha12}'; // CTHD_BUILD`)
      .replace('const PRECACHE = /** @type {string[]} */ ([]); // CTHD_PRECACHE', `const PRECACHE = ${JSON.stringify(precache)}; // CTHD_PRECACHE`);
    await writeFile(workerPath, worker);
    log(`offline preparation: ${precache.length} files; map modules and geometry load only on request`);
  }
  await writeFile(path.join(out, 'build-info.json'), `${JSON.stringify(info)}\n`);
  files++;
  log(`assembled ${files} files into ${out} (v/${sha12}/${info.swDisabled ? ', service worker disabled' : ''})`);
  return { sha12, files, retained };
}

/**
 * Shipped modules carry no comments; JSDoc types and notes stay in source. The TypeScript compiler parses
 * each module and re-emits it with comments and layout removed, nothing else (no type checking, no
 * module or syntax transform). A classic script would gain "use strict", so any emitted file that adds
 * it keeps its original text. Vendor files are never touched.
 * @param {string} dir the versioned asset directory, v/<sha12>/
 * @returns {Promise<number>} modules rewritten
 */
export async function stripComments(dir) {
  const tmp = `${dir}.strip`;
  await rm(tmp, { recursive: true, force: true });
  const config = `${dir}.strip.json`;
  const js = path.join(dir, 'js');
  if (!await exists(js)) return 0;
  await writeFile(config, JSON.stringify({
    compilerOptions: { allowJs: true, noCheck: true, removeComments: true, target: 'esnext', module: 'preserve', noResolve: true,
      isolatedModules: true, skipLibCheck: true, types: [], rootDir: js, outDir: tmp },
    include: [`${js.split(path.sep).join('/')}/**/*.js`], exclude: [`${js.split(path.sep).join('/')}/vendor/**`],
  }));
  try {
    execFileSync(process.execPath, [path.join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', config], { cwd: ROOT, stdio: 'pipe', windowsHide: true });
  } catch (e) {
    const out = /** @type {{ stdout?: Buffer }} */ (e).stdout?.toString() ?? '';
    throw new Error(`comment removal failed: ${out.split('\n').slice(0, 5).join(' ')}`);
  } finally { await rm(config, { force: true }); }
  let n = 0;
  for await (const file of walk(tmp)) {
    const target = path.join(js, path.relative(tmp, file));
    const original = await readFile(target, 'utf8');
    const emitted = await readFile(file, 'utf8');
    if (emitted.startsWith('"use strict";') && !original.trimStart().startsWith('"use strict";')) continue;
    await writeFile(target, emitted); n++;
  }
  await rm(tmp, { recursive: true, force: true });
  return n;
}

/** @param {string} p */
async function exists(p) {
  try { await stat(p); return true; } catch { return false; }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({
    options: {
      out: { type: 'string', default: '_site' },
      sha: { type: 'string' },
      previous: { type: 'string' },
      site: { type: 'string' },
      'sw-disabled': { type: 'boolean', default: false },
    },
  });
  try {
    const sha = values.sha || execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8', windowsHide: true }).trim();
    const site = values.site ? path.resolve(values.site) : path.join(ROOT, 'site');
    if (!(await exists(site))) throw new Error(`${site} does not exist`);
    await assemble({ out: path.resolve(values.out), sha, previous: values.previous ?? null, site, swDisabled: values['sw-disabled'] });
  } catch (e) {
    console.error(`[assemble] ${/** @type {Error} */ (e).message}`);
    process.exit(1);
  }
}
