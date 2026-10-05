// @ts-check
/**
 * Assemble the GitHub Pages artifact (blueprint 2.1, 5.12, 8.4):
 *
 *   node scripts/assemble-site.mjs --out _site [--sha <40-hex git sha>] [--previous <live build-info.json URL or path>]
 *                                  [--sw-disabled]
 *
 * 1. Copy the allowlist: site/** except static/ (data/curated and data/live included; classic/ included
 *    until its removal date).
 * 2. Copy site/static/ to _site/v/<sha12>/.
 * 3. Rewrite href and src attribute values that begin with `./static/` or `(../)*static/` in HTML files
 *    only, to the same prefix plus `v/<sha12>/`. JavaScript and CSS are never rewritten, and neither is
 *    text inside script, style, or comments.
 * 4. Retain the previous generation: read the live build-info.json, and when its sha12 differs, restore
 *    _site/v/<prev>/ from `git archive <prev> site/static` (checkout uses fetch-depth 0).
 * 5. Write _site/build-info.json (schemas/build-info.schema.json). `--sw-disabled` sets the service worker
 *    kill switch (`swDisabled: true`).
 *
 * Owner: lane L9. The service worker precache list arrives with the service worker (Wave 3).
 */
import { execFileSync } from 'node:child_process';
import { cp, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { getOwn } from './lib/http.mjs';
import { extractTar } from './lib/tar.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Top-level entries of site/ that are deployed (static/ is deployed as v/<sha12>/). */
export const ALLOWLIST = Object.freeze(['index.html', '404.html', 'offline.html', 'sw.js', 'embed.js', 'manifest.webmanifest',
  'robots.txt', '.nojekyll', 'alerts', 'forecasts', 'contacts', 'resources', 'safety', 'news', 'usage', 'archive', 'embed', 'classic', 'data']);

/** Markup the rewrite must step over (comments, raw-text elements) or rewrite (any start tag). */
const TOKENS = /<!--[\s\S]*?-->|<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>|<[a-zA-Z][^>]*>/gi;
const ATTR = /(\s(?:href|src)\s*=\s*)(["'])((?:\.\/)?(?:\.\.\/)*)static\//gi;

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
 * @returns {Promise<{ sha: string, sha12: string } | null>}
 */
async function readPrevious(location, fetchImpl) {
  if (!location) return null;
  const text = await getOwn(location, fetchImpl ? { fetchImpl } : {});
  if (!text) return null;
  try {
    const info = JSON.parse(text);
    if (/^[0-9a-f]{40}$/.test(info.sha) && info.sha12 === info.sha.slice(0, 12)) return { sha: info.sha, sha12: info.sha12 };
  } catch { /* unusable */ }
  return null;
}

/**
 * @param {{
 *   out: string, sha: string, previous: string | null,
 *   site?: string, repo?: string, swDisabled?: boolean, now?: Date,
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
  if (out === repo || out === site || site.startsWith(out + path.sep) || out.startsWith(site + path.sep)) {
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
  if (present.includes('static')) await cp(path.join(site, 'static'), path.join(out, 'v', sha12), { recursive: true });

  let files = 0;
  for await (const file of walk(out)) {
    files++;
    if (!file.endsWith('.html') || file.startsWith(path.join(out, 'v') + path.sep)) continue;
    const html = await readFile(file, 'utf8');
    const next = rewriteHtml(html, sha12);
    if (next !== html) await writeFile(file, next);
  }

  /** @type {string | null} */
  let retained = null;
  const prev = await readPrevious(opts.previous, opts.fetchImpl);
  if (prev && prev.sha12 !== sha12) {
    try {
      const tar = execFileSync('git', ['archive', '--format=tar', prev.sha, 'site/static'], { cwd: repo, maxBuffer: 512 * 1024 * 1024 });
      const n = await extractTar(tar, 'site/static/', path.join(out, 'v', prev.sha12));
      files += n;
      retained = n > 0 ? prev.sha12 : null;
      log(n > 0 ? `retained the previous generation v/${prev.sha12}/ (${n} files)` : `commit ${prev.sha12} has no site/static/; nothing to retain`);
    } catch (e) {
      log(`could not retain v/${prev.sha12}/ (${/** @type {Error} */ (e).message.split('\n')[0]}); pages loaded before this deploy may fail to lazy-load modules`);
    }
  } else log(prev ? `previous generation is this commit (v/${sha12}/)` : 'no previous build-info.json; nothing to retain');

  const info = { sha: opts.sha, sha12, builtAt: (opts.now ?? new Date()).toISOString(), swDisabled: Boolean(opts.swDisabled) };
  await writeFile(path.join(out, 'build-info.json'), `${JSON.stringify(info)}\n`);
  files++;
  log(`assembled ${files} files into ${out} (v/${sha12}/${info.swDisabled ? ', service worker disabled' : ''})`);
  return { sha12, files, retained };
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
    const sha = values.sha || execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
    const site = values.site ? path.resolve(values.site) : path.join(ROOT, 'site');
    if (!(await exists(site))) throw new Error(`${site} does not exist`);
    await assemble({ out: path.resolve(values.out), sha, previous: values.previous ?? null, site, swDisabled: values['sw-disabled'] });
  } catch (e) {
    console.error(`[assemble] ${/** @type {Error} */ (e).message}`);
    process.exit(1);
  }
}
