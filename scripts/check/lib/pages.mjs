// @ts-check
/**
 * Shared helpers for the static page checks (chrome, modulepreload). Owner: lane L0.
 */
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
export const SITE = path.join(ROOT, 'site');

/** Pages excluded from chrome, CSP, budget, and copy checks (blueprint 1.6). */
export const EXCLUDED_DIRS = ['classic', 'static', 'data'];

/**
 * Every HTML page under site/, as paths relative to site/ with forward slashes.
 * @returns {Promise<string[]>}
 */
export async function listPages() {
  /** @type {string[]} */
  const out = [];
  /** @param {string} dir @param {string} rel */
  async function walk(dir, rel) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const r = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (!rel && EXCLUDED_DIRS.includes(entry.name)) continue;
        await walk(path.join(dir, entry.name), r);
      } else if (entry.name.endsWith('.html')) out.push(r);
    }
  }
  await walk(SITE, '');
  return out.sort();
}

/**
 * True when the module at `metaUrl` is the script Node was asked to run.
 * @param {string} metaUrl import.meta.url of the caller
 */
export function isMain(metaUrl) {
  return Boolean(process.argv[1]) && path.resolve(process.argv[1] ?? '') === fileURLToPath(metaUrl);
}

/** @param {string} rel path relative to site/ */
export function readPage(rel) {
  return readFile(path.join(SITE, rel), 'utf8');
}

/**
 * Blocks between two markers, in order.
 * @param {string} html
 * @param {string} name marker name, for example 'chrome' for <!-- chrome:start --> and <!-- chrome:end -->
 * @returns {{ start: number, end: number, inner: string }[]}
 */
export function blocks(html, name) {
  const re = new RegExp(`<!-- ${name}:start -->([\\s\\S]*?)<!-- ${name}:end -->`, 'g');
  /** @type {{ start: number, end: number, inner: string }[]} */
  const out = [];
  for (const m of html.matchAll(re)) out.push({ start: m.index ?? 0, end: (m.index ?? 0) + m[0].length, inner: m[1] ?? '' });
  return out;
}
