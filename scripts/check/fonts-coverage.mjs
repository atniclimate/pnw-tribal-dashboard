// @ts-check
/**
 * `npm run check:fonts` (blueprint 9.2, 10.1). Fails when:
 *   - a woff2 named in site/static/css/fonts.css is missing from site/static/fonts/manifest.json, or its
 *     SHA-256 differs from the manifest, or a manifest license file is missing or changed;
 *   - the latin faces (League Spartan latin, Roboto 400 and 500 latin) total more than 90 KB;
 *   - any grapheme cluster of any Nation name cannot be drawn by a single served face in the body stack
 *     (Roboto 400 and 500) or the display stack (League Spartan 500 and 600), honoring each face's
 *     unicode-range and its real cmap. A base letter and its combining mark must come from one face, so
 *     marks such as U+0313 (q̓) position on their letter instead of floating in a fallback face.
 *
 * Names checked: tests/fixtures/names-60.json (sixty hard U.S. and British Columbia names) and, when lane
 * L5 has committed it, every name, preferredName, and alias in site/data/registry/nations-index.json.
 * Uses fontkit (development dependency). Owner: lane L1.
 */
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { CSS_DIR, ROOT, declarations, readTokens, ruleBlocks, stripComments } from './tokens.mjs';

const require = createRequire(import.meta.url);
/** @type {any} */
const fontkit = require('fontkit');

export const FONTS_DIR = path.join(ROOT, 'site', 'static', 'fonts');
export const LATIN_BUDGET_BYTES = 90 * 1024;

/** Weights each stack is drawn at (blueprint 9.3). */
export const STACK_WEIGHTS = Object.freeze({ '--font-body': [400, 500], '--font-display': [500, 600] });

/**
 * @typedef {{ family: string, weight: [number, number], file: string, ranges: [number, number][] }} Face
 */

/**
 * @param {string} value e.g. "U+0000-00FF, U+0131"
 * @returns {[number, number][]}
 */
export function parseUnicodeRange(value) {
  return value.split(',').map((s) => s.trim()).filter(Boolean).map((s) => {
    const m = /^U\+([0-9A-F?]+)(?:-([0-9A-F]+))?$/i.exec(s);
    if (!m) throw new Error(`bad unicode-range part ${s}`);
    const a = /** @type {string} */ (m[1]);
    if (a.includes('?')) return /** @type {[number, number]} */ ([parseInt(a.replace(/\?/g, '0'), 16), parseInt(a.replace(/\?/g, 'F'), 16)]);
    return /** @type {[number, number]} */ ([parseInt(a, 16), parseInt(m[2] ?? a, 16)]);
  });
}

/**
 * @param {string} css
 * @returns {Face[]}
 */
export function parseFontFaces(css) {
  /** @type {Face[]} */
  const faces = [];
  for (const b of ruleBlocks(stripComments(css))) {
    if (!b.selector.startsWith('@font-face')) continue;
    const d = Object.fromEntries(declarations(b.body));
    const src = /url\(\s*['"]?([^'")]+)['"]?\s*\)/.exec(d.src ?? '');
    if (!src) continue; // local() fallbacks carry no file
    const family = String(d['font-family'] ?? '').replace(/['"]/g, '').trim();
    const w = String(d['font-weight'] ?? '400').split(/\s+/).map(Number);
    faces.push({
      family,
      weight: [w[0] ?? 400, w[1] ?? w[0] ?? 400],
      file: path.basename(/** @type {string} */ (src[1])),
      ranges: d['unicode-range'] ? parseUnicodeRange(d['unicode-range']) : [[0, 0x10FFFF]],
    });
  }
  return faces;
}

/**
 * @param {string} value a font-family list
 * @returns {string[]}
 */
export function familyList(value) {
  return value.split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
}

/**
 * Faces of a family that the browser would use at a weight: the faces whose range includes it, else the
 * faces at the nearest declared weight.
 * @param {Face[]} faces
 * @param {number} weight
 * @returns {Face[]}
 */
export function facesAtWeight(faces, weight) {
  const exact = faces.filter((f) => f.weight[0] <= weight && weight <= f.weight[1]);
  if (exact.length) return exact;
  const dist = (/** @type {Face} */ f) => Math.min(Math.abs(f.weight[0] - weight), Math.abs(f.weight[1] - weight));
  const best = Math.min(...faces.map(dist));
  return faces.filter((f) => dist(f) === best);
}

/**
 * @param {string} hay
 * @param {string} name
 * @returns {Promise<string>}
 */
async function sha256(hay, name) {
  return createHash('sha256').update(await readFile(path.join(hay, name))).digest('hex');
}

/**
 * Loads every name to check.
 * @returns {Promise<{ text: string, from: string }[]>}
 */
export async function loadNames() {
  /** @type {{ text: string, from: string }[]} */
  const out = [];
  const fixture = JSON.parse(await readFile(path.join(ROOT, 'tests', 'fixtures', 'names-60.json'), 'utf8'));
  for (const n of fixture.names) out.push({ text: n.name, from: `names-60 (${n.source} ${n.ref})` });
  const registry = path.join(ROOT, 'site', 'data', 'registry', 'nations-index.json');
  if (existsSync(registry)) {
    const idx = JSON.parse(await readFile(registry, 'utf8'));
    for (const n of idx.nations ?? []) {
      for (const t of [n.name, n.preferredName, ...(n.aliases ?? [])]) if (typeof t === 'string' && t) out.push({ text: t, from: `registry ${n.id}` });
    }
  }
  return out;
}

/**
 * Runs the check.
 * @param {{ names?: { text: string, from: string }[] }} [opts]
 * @returns {Promise<{ problems: string[], latinBytes: number, clusters: number, names: number }>}
 */
export async function checkFonts(opts = {}) {
  /** @type {string[]} */
  const problems = [];
  const faces = parseFontFaces(await readFile(path.join(CSS_DIR, 'fonts.css'), 'utf8'));
  const manifest = JSON.parse(await readFile(path.join(FONTS_DIR, 'manifest.json'), 'utf8'));
  /** @type {Map<string, any>} */
  const byFile = new Map(manifest.faces.map((/** @type {any} */ f) => [f.file, f]));

  /** @type {Map<string, Set<number>>} */
  const cmaps = new Map();
  for (const face of faces) {
    const m = byFile.get(face.file);
    if (!m) { problems.push(`fonts.css names ${face.file}, which manifest.json does not list`); continue; }
    if (!existsSync(path.join(FONTS_DIR, face.file))) { problems.push(`${face.file} is missing`); continue; }
    const digest = await sha256(FONTS_DIR, face.file);
    if (digest !== m.sha256) problems.push(`${face.file}: SHA-256 ${digest} differs from manifest ${m.sha256}`);
    if (!cmaps.has(face.file)) cmaps.set(face.file, new Set(fontkit.openSync(path.join(FONTS_DIR, face.file)).characterSet));
  }
  for (const lic of manifest.licenses) {
    if (!existsSync(path.join(FONTS_DIR, lic.file))) problems.push(`license ${lic.file} is missing`);
    else if (await sha256(FONTS_DIR, lic.file) !== lic.sha256) problems.push(`license ${lic.file} changed`);
  }

  let latinBytes = 0;
  for (const f of manifest.faces) if (f.subset === 'latin') latinBytes += f.bytes;
  if (latinBytes > LATIN_BUDGET_BYTES) problems.push(`latin woff2 total ${latinBytes} bytes exceeds ${LATIN_BUDGET_BYTES}`);

  const tokens = (await readTokens()).dark;
  const names = opts.names ?? await loadNames();
  const seg = new Intl.Segmenter('und', { granularity: 'grapheme' });
  let clusters = 0;
  /** @type {Set<string>} */
  const reported = new Set();
  for (const [stackToken, weights] of Object.entries(STACK_WEIGHTS)) {
    const stack = familyList(tokens.get(stackToken) ?? '').filter((fam) => faces.some((f) => f.family === fam));
    if (!stack.length) { problems.push(`${stackToken} names no self-hosted family`); continue; }
    for (const weight of weights) {
      for (const name of names) {
        for (const { segment } of seg.segment(name.text)) {
          clusters += 1;
          const forms = [...new Set([segment, segment.normalize('NFC'), segment.normalize('NFD')])].map((s) => [...s].map((c) => /** @type {number} */ (c.codePointAt(0))));
          const drawn = stack.some((fam) => facesAtWeight(faces.filter((f) => f.family === fam), weight).some((face) => {
            const cmap = cmaps.get(face.file);
            return cmap && forms.some((cps) => cps.every((cp) => cmap.has(cp) && face.ranges.some(([a, b]) => cp >= a && cp <= b)));
          }));
          if (!drawn) {
            const cps = [...segment].map((c) => `U+${(c.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, '0')}`).join(' ');
            const key = `${stackToken}|${weight}|${segment}|${name.text}`;
            if (!reported.has(key)) { reported.add(key); problems.push(`"${segment}" (${cps}) in "${name.text}" [${name.from}] has no served face in ${stackToken} at ${weight}`); }
          }
        }
      }
    }
  }
  return { problems, latinBytes, clusters, names: names.length };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const r = await checkFonts();
  if (r.problems.length) {
    for (const p of r.problems) console.error(p);
    console.error(`check:fonts: ${r.problems.length} problem(s)`);
    process.exit(1);
  }
  console.log(`check:fonts: ${r.names} names (${r.clusters} cluster checks across both stacks and four weights) drawn by served faces; latin woff2 total ${r.latinBytes} bytes`);
}
