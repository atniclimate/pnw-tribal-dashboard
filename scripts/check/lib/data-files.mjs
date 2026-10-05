// @ts-check
/**
 * Schema loading, catalog globbing, and data-file parsing shared by validate-data, the schema tests, and
 * later checks. Owner: lane L0.
 */
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormatsCjs from 'ajv-formats';
import { CORE_SCHEMA, load as loadYaml } from 'js-yaml';
import { ROOT } from './pages.mjs';

export const SCHEMA_DIR = path.join(ROOT, 'schemas');
export const SCHEMA_BASE = 'https://atniclimate.github.io/pnw-tribal-dashboard/schemas/';

/** Keys that may never appear in any data file (named-person guard, blueprint 6.6). */
/** ajv-formats is CommonJS; its function is both module.exports and exports.default. */
const addFormats = addFormatsCjs.default;

export const PERSON_KEYS = Object.freeze(['firstname', 'lastname', 'middlename', 'salutation', 'suffix', 'aka', 'jobtitle', 'dateelected', 'nextelection']);

/**
 * An Ajv 2020-12 instance with formats and every schema in schemas/ registered by $id.
 * @returns {Promise<import('ajv/dist/2020.js').Ajv2020>}
 */
export async function loadAjv() {
  // Strict, except two checks that reject idiomatic if/then subschemas (required and type in `then`).
  const ajv = new Ajv2020({ allErrors: true, strict: true, strictTypes: false, strictRequired: false, allowUnionTypes: true });
  addFormats(ajv);
  for (const name of (await readdir(SCHEMA_DIR)).filter((n) => n.endsWith('.schema.json')).sort()) {
    ajv.addSchema(JSON.parse(await readFile(path.join(SCHEMA_DIR, name), 'utf8')));
  }
  return ajv;
}

/**
 * @returns {Promise<{ schema: string, files: string[], format?: string }[]>}
 */
export async function loadCatalog() {
  return JSON.parse(await readFile(path.join(SCHEMA_DIR, 'catalog.json'), 'utf8')).entries;
}

/**
 * Expand a repository-relative pattern where `*` matches within one segment.
 * @param {string} pattern
 * @returns {Promise<string[]>} repository-relative paths with forward slashes
 */
export async function expand(pattern) {
  const parts = pattern.split('/');
  /** @type {string[]} */
  let current = [''];
  for (let i = 0; i < parts.length; i += 1) {
    const part = parts[i] ?? '';
    const last = i === parts.length - 1;
    /** @type {string[]} */
    const next = [];
    for (const base of current) {
      if (!part.includes('*')) { next.push(base ? `${base}/${part}` : part); continue; }
      const re = new RegExp(`^${part.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*')}$`);
      let entries = [];
      try { entries = await readdir(path.join(ROOT, base), { withFileTypes: true }); } catch { continue; }
      for (const e of entries) if (re.test(e.name) && (last ? e.isFile() : e.isDirectory())) next.push(base ? `${base}/${e.name}` : e.name);
    }
    current = next;
  }
  /** @type {string[]} */
  const existing = [];
  for (const rel of current) {
    try { await readFile(path.join(ROOT, rel)); existing.push(rel); } catch { /* absent */ }
  }
  return existing.sort();
}

/**
 * Minimal RFC 4180 CSV parser (quoted fields, doubled quotes, CRLF).
 * @param {string} text
 * @returns {Record<string, string>[]}
 */
export function parseCsv(text) {
  /** @type {string[][]} */
  const rows = [];
  /** @type {string[]} */
  let row = [];
  let field = '';
  let quoted = false;
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') { field += '"'; i += 1; } else if (ch === '"') quoted = false; else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(field); field = ''; } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i += 1;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += ch;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  const [head, ...body] = rows.filter((r) => !(r.length === 1 && r[0] === ''));
  if (!head) return [];
  return body.map((r) => {
    if (r.length !== head.length) throw new Error(`CSV row has ${r.length} fields, header has ${head.length}`);
    return Object.fromEntries(head.map((h, j) => [h, r[j] ?? '']));
  });
}

/**
 * Parse a data file by extension.
 * @param {string} rel repository-relative path
 * @returns {Promise<unknown>}
 */
export async function parseDataFile(rel) {
  const text = await readFile(path.join(ROOT, rel), 'utf8');
  if (rel.endsWith('.json')) return JSON.parse(text);
  // YAML 1.2 core schema: unquoted dates stay strings (no timestamp coercion), yes/no stay strings.
  if (rel.endsWith('.yaml') || rel.endsWith('.yml')) return loadYaml(text, { schema: CORE_SCHEMA });
  if (rel.endsWith('.csv')) return parseCsv(text);
  throw new Error(`no parser for ${rel}`);
}

/**
 * Every object key in a parsed value that is on the named-person deny list, with its path.
 * @param {unknown} value
 * @param {string} [at]
 * @returns {string[]}
 */
export function personKeyHits(value, at = '$') {
  /** @type {string[]} */
  const hits = [];
  if (Array.isArray(value)) value.forEach((v, i) => hits.push(...personKeyHits(v, `${at}[${i}]`)));
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      if (PERSON_KEYS.includes(k.toLowerCase())) hits.push(`${at}.${k}`);
      hits.push(...personKeyHits(v, `${at}.${k}`));
    }
  }
  return hits;
}
