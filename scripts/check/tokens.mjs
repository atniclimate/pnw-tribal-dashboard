// @ts-check
/**
 * `npm run check:tokens` (blueprint 10.1, 10.3 check 1). Fails when:
 *   - a token in tokens.css differs from tests/fixtures/design-system.canonical.json (per theme layer);
 *   - a raw color (hex, rgb(), hsl()) appears in any stylesheet other than tokens.css;
 *   - a border-radius is anything but 0 (radius is 0 everywhere; status shapes are SVG);
 *   - a box-shadow appears outside focus rules and the light or print layers (no shadows on dark);
 *   - Tribal Magenta, or a token derived from it, is used outside the sovereignty, Treaty, land, and
 *     boundary selectors (blueprint 9.5 rule 5);
 *   - ATNI Red, or a token derived from it, is used outside its whitelist, or anywhere in alert UI
 *     (blueprint 9.5 rule 2).
 *
 * The module also exports the small, dependency-free CSS helpers that contrast.mjs and fonts-coverage.mjs
 * share: a custom-property reader with var() resolution per theme and WCAG 2.2 contrast. Owner: lane L1.
 */
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const CSS_DIR = path.join(ROOT, 'site', 'static', 'css');
export const TOKENS_CSS = path.join(CSS_DIR, 'tokens.css');

/**
 * Strips CSS comments, keeping line count so reported line numbers stay true.
 * @param {string} css
 * @returns {string}
 */
export function stripComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
}

/**
 * Top-level rule blocks (one nesting level, enough for @media wrappers) as { selector, body, line }.
 * @param {string} css comment-free CSS
 * @returns {{ selector: string, body: string, line: number, media: string | null }[]}
 */
export function ruleBlocks(css) {
  /** @type {{ selector: string, body: string, line: number, media: string | null }[]} */
  const out = [];
  /** @param {string} src @param {number} offset @param {string | null} media */
  const walk = (src, offset, media) => {
    let i = 0;
    while (i < src.length) {
      const open = src.indexOf('{', i);
      if (open < 0) break;
      const prelude = src.slice(i, open).trim();
      let depth = 1;
      let j = open + 1;
      while (j < src.length && depth > 0) {
        if (src[j] === '{') depth += 1;
        else if (src[j] === '}') depth -= 1;
        j += 1;
      }
      const body = src.slice(open + 1, j - 1);
      const line = src.slice(0, open).split('\n').length + offset;
      if (/^@(media|supports|layer)\b/.test(prelude)) walk(body, line - 1, prelude);
      else if (!/^@(font-face|keyframes|page)\b/.test(prelude) || prelude.startsWith('@font-face')) out.push({ selector: prelude.replace(/\s+/g, ' '), body, line, media });
      i = j;
    }
  };
  walk(css, 0, null);
  return out;
}

/**
 * Declarations of a rule body as [property, value] pairs.
 * @param {string} body
 * @returns {[string, string][]}
 */
export function declarations(body) {
  /** @type {[string, string][]} */
  const out = [];
  for (const part of body.split(';')) {
    const k = part.indexOf(':');
    if (k < 0) continue;
    const prop = part.slice(0, k).trim();
    const value = part.slice(k + 1).trim();
    if (prop) out.push([prop, value]);
  }
  return out;
}

/**
 * Custom properties per theme: `dark` is :root, `light` is :root[data-theme='light'] layered over dark,
 * `reduced` is the prefers-reduced-motion layer over dark.
 * @param {string} [file]
 * @returns {Promise<{ dark: Map<string, string>, light: Map<string, string>, reduced: Map<string, string> }>}
 */
export async function readTokens(file = TOKENS_CSS) {
  const css = stripComments(await readFile(file, 'utf8'));
  const dark = new Map();
  const lightOnly = new Map();
  const reducedOnly = new Map();
  for (const b of ruleBlocks(css)) {
    const target = /^:root$/.test(b.selector) && !b.media ? dark
      : /^:root\[data-theme=['"]?light['"]?\]$/.test(b.selector) ? lightOnly
        : /^:root$/.test(b.selector) && b.media && /prefers-reduced-motion/.test(b.media) ? reducedOnly : null;
    if (!target) continue;
    for (const [p, v] of declarations(b.body)) if (p.startsWith('--')) target.set(p, v);
  }
  return { dark, light: new Map([...dark, ...lightOnly]), reduced: new Map([...dark, ...reducedOnly]) };
}

/**
 * Resolves var() references (with fallbacks) against a token map.
 * @param {string} value
 * @param {Map<string, string>} tokens
 * @param {number} [depth]
 * @returns {string}
 */
export function resolve(value, tokens, depth = 0) {
  if (depth > 12) throw new Error(`var() cycle near ${value}`);
  return value.replace(/var\(\s*(--[\w-]+)\s*(?:,\s*([^)]*))?\)/g, (_, name, fallback) => {
    const v = tokens.get(name);
    if (v === undefined) {
      if (fallback !== undefined) return resolve(fallback, tokens, depth + 1);
      throw new Error(`undefined token ${name}`);
    }
    return resolve(v, tokens, depth + 1);
  });
}

/**
 * @param {string} hex #RGB or #RRGGBB
 * @returns {[number, number, number]}
 */
export function hexToRgb(hex) {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) throw new Error(`not a hex color: ${hex}`);
  let h = /** @type {string} */ (m[1]);
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  const at = (/** @type {number} */ i) => parseInt(h.slice(i, i + 2), 16);
  return [at(0), at(2), at(4)];
}

/**
 * WCAG 2.2 relative luminance.
 * @param {string} hex
 * @returns {number}
 */
export function luminance(hex) {
  const [r, g, b] = hexToRgb(hex).map((c) => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * /** @type {number} */ (r) + 0.7152 * /** @type {number} */ (g) + 0.0722 * /** @type {number} */ (b);
}

/**
 * WCAG contrast ratio, rounded down to two decimals so a reported pass is never a rounding artifact.
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
export function contrast(a, b) {
  const la = luminance(a);
  const lb = luminance(b);
  const ratio = (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
  return Math.floor(ratio * 100) / 100;
}

/* ------------------------------------------------------------------------------------------------ */
/* The check                                                                                         */
/* ------------------------------------------------------------------------------------------------ */

/** Selectors that may use Tribal Magenta: land, Treaty, sovereignty, and boundary marks only. */
export const MAGENTA_SELECTORS = /sovereignty|treaty|boundary|land-area|selected-nation/;
/** Selectors that may use ATNI Red: the wordmark, the header rule, primary buttons, note callouts. */
export const RED_SELECTORS = /site-header|wordmark|embed-bar__brand|btn--primary|callout--note|display-accent/;
/** Alert UI, where ATNI Red never appears (blueprint 9.5 rule 2), whatever else the selector says. */
export const ALERT_UI = /alert|banner|band|status|tile|designation|posture|gauge|legend|map|flood/;
/** Token names that may alias the reserved colors inside tokens.css. */
const MAGENTA_ALIAS_OK = /sovereignty|boundary|magenta/;
const RED_ALIAS_OK = /atni-red|callout-note/;

/**
 * Token names whose resolved value is (or derives from) a given palette entry.
 * @param {Map<string, string>} tokens
 * @param {string[]} roots
 * @returns {Set<string>}
 */
export function derivedTokens(tokens, roots) {
  const set = new Set(roots);
  let grew = true;
  while (grew) {
    grew = false;
    for (const [name, value] of tokens) {
      if (set.has(name)) continue;
      for (const m of value.matchAll(/var\(\s*(--[\w-]+)/g)) if (set.has(/** @type {string} */ (m[1]))) { set.add(name); grew = true; break; }
    }
  }
  return set;
}

/**
 * Lints one stylesheet against the rules above. Exported for unit tests.
 * @param {string} name file name, for messages
 * @param {string} source CSS text
 * @param {{ isTokens: boolean, magenta: Set<string>, red: Set<string> }} ctx
 * @returns {string[]} problems
 */
export function lintStylesheet(name, source, ctx) {
  /** @type {string[]} */
  const problems = [];
  const css = stripComments(source);
  const uses = (/** @type {string} */ value, /** @type {Set<string>} */ set) => [...value.matchAll(/var\(\s*(--[\w-]+)/g)].some((m) => set.has(/** @type {string} */ (m[1])));
  for (const b of ruleBlocks(css)) {
    const where = `${name}:${b.line} ${b.selector}`;
    const lightOrPrint = /data-theme=['"]?light/.test(b.selector) || (b.media !== null && /\bprint\b/.test(b.media)) || name === 'print.css';
    for (const [prop, value] of declarations(b.body)) {
      const isTokenDef = ctx.isTokens && prop.startsWith('--');
      if (!ctx.isTokens && /#[0-9a-f]{3,8}\b|\brgba?\(|\bhsla?\(/i.test(value)) problems.push(`${where}: raw color in ${prop}: ${value} (colors live in tokens.css)`);
      if (/^border(-[a-z]+)*-radius$/.test(prop) && !/^(0|0px|var\(--radius\))$/.test(value)) problems.push(`${where}: nonzero ${prop}: ${value}`);
      if (prop === 'box-shadow' && !/^(none|var\(--card-shadow\))$/.test(value) && !/:focus/.test(b.selector) && !lightOrPrint) problems.push(`${where}: box-shadow on dark outside focus: ${value}`);
      if (isTokenDef) {
        if (uses(value, ctx.magenta) && !MAGENTA_ALIAS_OK.test(prop)) problems.push(`${where}: token ${prop} aliases Tribal Magenta under a name that is not a sovereignty or boundary token`);
        if (uses(value, ctx.red) && !RED_ALIAS_OK.test(prop)) problems.push(`${where}: token ${prop} aliases ATNI Red outside its whitelist`);
        continue;
      }
      if (uses(value, ctx.magenta) && !MAGENTA_SELECTORS.test(b.selector)) problems.push(`${where}: Tribal Magenta outside land, Treaty, and sovereignty selectors (${prop})`);
      if (uses(value, ctx.red)) {
        if (ALERT_UI.test(b.selector)) problems.push(`${where}: ATNI Red inside alert UI (${prop})`);
        else if (!RED_SELECTORS.test(b.selector)) problems.push(`${where}: ATNI Red outside its whitelist (${prop})`);
      }
    }
  }
  return problems;
}

/**
 * Runs the whole check; returns problems (empty when it passes).
 * @returns {Promise<string[]>}
 */
export async function checkTokens() {
  /** @type {string[]} */
  const problems = [];
  const themes = await readTokens();
  const canonical = JSON.parse(await readFile(path.join(ROOT, 'tests', 'fixtures', 'design-system.canonical.json'), 'utf8'));
  const norm = (/** @type {string} */ v) => v.replace(/\s+/g, ' ').trim().toLowerCase();
  for (const t of canonical.tokens) {
    const layer = t.theme === 'light' ? themes.light : t.theme === 'reduced' ? themes.reduced : themes.dark;
    const actual = layer.get(t.token);
    if (actual === undefined) problems.push(`tokens.css: ${t.token} missing (${t.theme ?? 'dark'}; ${t.ref})`);
    else if (norm(actual) !== norm(t.value)) problems.push(`tokens.css: ${t.token} is ${actual}, canonical ${t.value} (${t.theme ?? 'dark'}; ${t.ref})`);
  }
  for (const [name, layer] of Object.entries(themes)) {
    for (const k of layer.keys()) {
      try { resolve(`var(${k})`, layer); } catch (e) { problems.push(`tokens.css (${name}): ${/** @type {Error} */ (e).message}`); }
    }
  }
  const magenta = derivedTokens(themes.dark, ['--tribal-magenta', '--color-tribal-magenta']);
  const red = derivedTokens(themes.dark, ['--atni-red', '--color-atni-red']);
  const files = (await readdir(CSS_DIR)).filter((f) => f.endsWith('.css')).sort();
  for (const f of files) {
    const source = await readFile(path.join(CSS_DIR, f), 'utf8');
    problems.push(...lintStylesheet(f, source, { isTokens: f === 'tokens.css', magenta, red }));
  }
  return problems;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const problems = await checkTokens();
  if (problems.length) {
    for (const p of problems) console.error(p);
    console.error(`check:tokens: ${problems.length} problem(s)`);
    process.exit(1);
  }
  console.log('check:tokens: tokens match the canonical design system; no raw colors, radius, dark shadows, or reserved colors out of place');
}
