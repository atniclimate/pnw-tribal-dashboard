// @ts-check
/**
 * Compile resources.yaml, declarations/curated.yaml, news-sources.yaml, imagery/products.yaml, and
 * events/*.yaml into site/data/curated/*.json (blueprint 6.3).
 *
 * L0 baseline: each present input is validated against its schema and written as a curated envelope
 * (`{ schema: 'cthd.curated.<kind>/1', generatedAt, items }`), so lanes adding inputs never break
 * `npm run dev`. Owner after Wave 0: lane L6, which adds the 6.6 honesty rules (no curated value without
 * a source; event items rejected from resources.yaml; reviewBy at most 30 days after verifiedAt).
 */
import { readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { SCHEMA_BASE, loadAjv, parseDataFile } from '../check/lib/data-files.mjs';

/** @type {{ kind: string, input: string, schema: string, many?: boolean }[]} */
const INPUTS = [
  { kind: 'agencies', input: 'data/agencies.yaml', schema: 'agencies.schema.json' },
  { kind: 'resources', input: 'data/resources.yaml', schema: 'resources.schema.json' },
  { kind: 'declarations', input: 'data/declarations/curated.yaml', schema: 'declarations-curated.schema.json' },
  { kind: 'news-sources', input: 'data/news-sources.yaml', schema: 'news-sources.schema.json' },
  { kind: 'imagery-products', input: 'data/imagery/products.yaml', schema: 'imagery-products.schema.json' },
  { kind: 'events', input: 'data/events', schema: 'event.schema.json', many: true },
];

const DAY = 86400000;
const EVENT_ITEM = /\b(state of (local )?emergency|emergency (declaration|proclamation)|disaster declaration|proclamation of emergency)\b|\bresolution\s*#?\s*\d/i;
const SIMULATED = /\bsimulat(ed|ing|ion)\b|\bplaceholder\b|\bsample data\b/i;

/**
 * Blueprint 6.6 honesty rules for the curated inputs that lane L6 owns. Pure; returns one message per problem.
 * @param {string} kind agencies | resources | declarations | events | other
 * @param {any} value the parsed, schema-valid input
 * @returns {string[]}
 */
export function honestyProblems(kind, value) {
  /** @type {string[]} */
  const out = [];
  const items = Array.isArray(value) ? value : [value];
  const days = (/** @type {string} */ a, /** @type {string} */ b) => (Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY;
  if (kind === 'agencies') {
    const ids = new Set();
    for (const a of items) { if (ids.has(a.id)) out.push(`agencies: duplicate id ${a.id}`); ids.add(a.id); }
    for (const a of items) if (a.parentId && !ids.has(a.parentId)) out.push(`agencies: ${a.id} names unknown parentId ${a.parentId}`);
  }
  if (kind === 'resources') {
    const ids = new Set();
    for (const r of items) {
      if (ids.has(r.id)) out.push(`resources: duplicate id ${r.id}`);
      ids.add(r.id);
      if (EVENT_ITEM.test(`${r.title} ${r.description}`)) out.push(`resources: ${r.id} reads as an event item; event items belong in data/events/`);
      if (SIMULATED.test(`${r.title} ${r.description}`)) out.push(`resources: ${r.id} reads as simulated data`);
      if (r.status === 'seasonal' && r.validUntil < r.validFrom) out.push(`resources: ${r.id} ends before it starts`);
    }
  }
  if (kind === 'declarations') {
    const ids = new Set();
    for (const d of items) {
      if (ids.has(d.id)) out.push(`declarations: duplicate id ${d.id}`);
      ids.add(d.id);
      if (!d.source?.url) out.push(`declarations: ${d.id} has no source`);
      const gap = days(d.verifiedAt, d.reviewBy);
      if (gap < 0 || gap > 30) out.push(`declarations: ${d.id} reviewBy must be 0 to 30 days after verifiedAt (got ${gap})`);
      if (SIMULATED.test(`${d.title} ${d.source?.title ?? ''}`)) out.push(`declarations: ${d.id} reads as simulated data`);
      if (d.effectiveUntil && d.effectiveUntil < d.issuedOn) out.push(`declarations: ${d.id} ends before it was issued`);
    }
  }
  if (kind === 'events') {
    for (const e of items) {
      for (const en of e.entries) {
        if (en.linkStatus === 'dead' && !en.archiveUrl) out.push(`events: ${e.id} entry "${en.title}" is dead and has no archived copy`);
        if (en.date < e.period.start.slice(0, 4) + '-01-01') out.push(`events: ${e.id} entry "${en.title}" predates the event year`);
      }
    }
  }
  return out;
}

/**
 * @param {import('./all.mjs').CompileContext} ctx
 * @returns {Promise<import('./all.mjs').CompileResult>}
 */
export async function compileCurated(ctx) {
  const ajv = await loadAjv();
  /** @type {string[]} */
  const outputs = [];
  for (const spec of INPUTS) {
    /** @type {string[]} */
    let files = [];
    if (spec.many) {
      try { files = (await readdir(path.join(ctx.root, spec.input))).filter((n) => n.endsWith('.yaml')).sort().map((n) => `${spec.input}/${n}`); } catch { /* absent */ }
    } else {
      try { await readdir(path.dirname(path.join(ctx.root, spec.input))); files = (await readdir(path.dirname(path.join(ctx.root, spec.input)))).includes(path.basename(spec.input)) ? [spec.input] : []; } catch { /* absent */ }
    }
    if (files.length === 0) continue;
    const validate = ajv.getSchema(SCHEMA_BASE + spec.schema);
    if (!validate) throw new Error(`schema ${spec.schema} missing`);
    /** @type {unknown[]} */
    const items = [];
    for (const rel of files) {
      const value = await parseDataFile(rel);
      if (!validate(value)) throw new Error(`${rel}: ${(validate.errors ?? []).map((e) => `${e.instancePath || '/'} ${e.message}`).join('; ')}`);
      const honesty = honestyProblems(spec.kind, value);
      if (honesty.length) throw new Error(`${rel}: ${honesty.join('; ')}`);
      if (spec.many) items.push(value); else items.push(...(Array.isArray(value) ? value : [value]));
    }
    const out = path.join(ctx.outDir, `${spec.kind}.json`);
    await writeFile(out, JSON.stringify({ schema: `cthd.curated.${spec.kind}/1`, generatedAt: ctx.generatedAt, items }) + '\n');
    outputs.push(out);
  }
  return { outputs, skipped: outputs.length ? null : 'no curated inputs yet (lanes L6, L12, L14)' };
}
