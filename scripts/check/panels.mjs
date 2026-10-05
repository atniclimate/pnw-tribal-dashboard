// @ts-check
/**
 * check:panels (blueprint 10.1, 10.3 check 2). Every `[data-panel]` in a page names registered source ids
 * in `data-sources`, so mountPanel can write a provenance footer that resolves. Source ids are the files
 * of data/sources/*.yaml. Panel names are unique within a page. Owner: lane L15.
 */
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { ROOT, isMain, listPages, readPage } from './lib/pages.mjs';
import { parseDataFile } from './lib/data-files.mjs';

/**
 * Every element start tag that carries a data-panel attribute, with its attributes.
 * @param {string} html
 * @returns {{ panel: string, sources: string[] | null }[]}
 */
export function panelsOf(html) {
  const body = html.replace(/<!--[\s\S]*?-->/g, '').replace(/<script[\s\S]*?<\/script>/gi, '');
  /** @type {{ panel: string, sources: string[] | null }[]} */
  const out = [];
  for (const m of body.matchAll(/<[a-z][a-z0-9-]*\s[^>]*\bdata-panel="([^"]*)"[^>]*>/gi)) {
    const tag = m[0];
    const src = /\bdata-sources="([^"]*)"/.exec(tag);
    out.push({ panel: m[1] ?? '', sources: src ? (src[1] ?? '').split(/\s+/).filter(Boolean) : null });
  }
  return out;
}

/**
 * @param {string} html
 * @param {Set<string>} registered
 * @returns {string[]}
 */
export function panelProblems(html, registered) {
  /** @type {string[]} */
  const problems = [];
  /** @type {Set<string>} */
  const seen = new Set();
  for (const { panel, sources } of panelsOf(html)) {
    if (!panel) problems.push('a [data-panel] has an empty name');
    if (seen.has(panel)) problems.push(`panel "${panel}" appears more than once`);
    seen.add(panel);
    if (!sources || sources.length === 0) { problems.push(`panel "${panel}" has no data-sources`); continue; }
    for (const id of sources) if (!registered.has(id)) problems.push(`panel "${panel}" names unregistered source "${id}"`);
  }
  return problems;
}

/** @returns {Promise<Set<string>>} */
export async function registeredIds() {
  /** @type {Set<string>} */
  const ids = new Set();
  let names = [];
  try { names = (await readdir(path.join(ROOT, 'data', 'sources'))).filter((n) => n.endsWith('.yaml')); } catch { return ids; }
  for (const n of names) {
    const rec = /** @type {{ id?: string }} */ (await parseDataFile(`data/sources/${n}`));
    if (rec?.id) ids.add(rec.id);
  }
  return ids;
}

if (isMain(import.meta.url)) {
  const ids = await registeredIds();
  let failed = 0;
  let panels = 0;
  /** @type {Map<string, Set<string>>} */
  const unregistered = new Map();
  for (const rel of await listPages()) {
    const html = await readPage(rel);
    panels += panelsOf(html).length;
    for (const p of panelProblems(html, ids)) {
      failed += 1;
      const m = /unregistered source "([^"]+)"/.exec(p);
      if (m) { const set = unregistered.get(m[1] ?? '') ?? new Set(); set.add(rel); unregistered.set(m[1] ?? '', set); } else console.error(`check:panels site/${rel}: ${p}`);
    }
  }
  if (unregistered.size) {
    console.error(`check:panels: ${unregistered.size} source id(s) named by panels have no data/sources/<id>.yaml: ${[...unregistered.keys()].sort().join(', ')}`);
  }
  if (failed) { console.error(`check:panels failed: ${failed} problem(s)`); process.exit(1); }
  console.log(`check:panels ok (${panels} panels, ${ids.size} registered sources)`);
}
