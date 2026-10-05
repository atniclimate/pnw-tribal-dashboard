// @ts-check
/**
 * Compile data/contacts/*.csv into site/data/curated/contacts.json (blueprint 5.3, 6.3).
 *
 * Every file must carry the exact header below. Rows are validated against schemas/contact-row.schema.json,
 * duplicate ids fail the build, rows are mapped onto schemas/contact.schema.json, `needs-reverification` is
 * computed from `review_due`, rows more than 365 days past verification fail, rows with status `conflict`
 * (see data/contacts/conflicts.csv) render only when marked `preferred`, and the named-person and
 * personal-mobile rules are enforced. agencies.yaml is compiled by curated.mjs.
 */
import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { SCHEMA_BASE, loadAjv, parseCsv } from '../check/lib/data-files.mjs';

export const CONTACT_HEADER = Object.freeze('id,scope_level,region,nation_id,agency_id,county_fips,org,office,role,line_type,phone_e164,phone_display,ext,email,url,hours,published_by_nation,person,source_url,source_publisher,source_kind,source_snippet,verified_at,verified_method,status,preferred,review_due,notes'.split(','));

/**
 * One parsed contact CSV row: every CONTACT_HEADER column as a string ('' when empty).
 * @typedef {'id'|'scope_level'|'region'|'nation_id'|'agency_id'|'county_fips'|'org'|'office'|'role'|'line_type'|'phone_e164'|'phone_display'|'ext'|'email'|'url'|'hours'|'published_by_nation'|'person'|'source_url'|'source_publisher'|'source_kind'|'source_snippet'|'verified_at'|'verified_method'|'status'|'preferred'|'review_due'|'notes'} ContactField
 * @typedef {Record<ContactField, string>} ContactRow
 */

const DAY = 86400000;
/** @param {string} iso @returns {number} */
const utc = (iso) => Date.parse(`${iso}T00:00:00Z`);
/** @param {string} iso @param {number} days @returns {string} */
const addDays = (iso, days) => new Date(utc(iso) + days * DAY).toISOString().slice(0, 10);
/** @param {string} v @returns {string | null} */
const orNull = (v) => (v === '' || v === undefined ? null : v);

/**
 * True when the source snippet labels the recorded number as a cell or mobile line.
 * @param {ContactRow} r
 * @returns {boolean}
 */
export function mobileBeforeNumber(r) {
  const digits = r.phone_e164.replace(/\D/g, '').slice(-10);
  for (const m of r.source_snippet.matchAll(/(cell|mobile)\b[^0-9]{0,24}(\(?\d{3}\)?[\s.-]*\d{3}[\s.-]*\d{4})/gi)) {
    if ((m[2] ?? '').replace(/\D/g, '') === digits) return true;
  }
  return false;
}

/**
 * Display order of blueprint 5.3: nation 24/7 and emergency lines, nation main line, county or regional
 * district, state or provincial 24/7, other state or provincial lines, federal lines. (911 is static UI.)
 * @param {ContactRow} r
 * @returns {number}
 */
export function sortWeight(r) {
  const urgent = r.line_type === '24-7' || r.line_type === 'emergency-management' || r.line_type === 'flood-hotline';
  if (r.scope_level === 'nation') return urgent ? 10 : 20;
  if (r.scope_level === 'county' || r.scope_level === 'regional-district') return urgent ? 30 : 35;
  if (r.scope_level === 'state' || r.scope_level === 'province' || r.scope_level === 'regional') return r.line_type === '24-7' ? 40 : 45;
  return r.line_type === '24-7' ? 60 : 65;
}

/**
 * @param {ContactRow} r one validated CSV row
 * @param {string} today ISO date
 * @returns {Record<string, any>}
 */
export function mapRow(r, today) {
  const reviewDue = r.review_due || addDays(r.verified_at, 180);
  const pastDue = utc(today) > utc(reviewDue);
  /** @type {string} */
  let status = r.status;
  if (status === 'verified' && pastDue) status = 'needs-reverification';
  return {
    id: r.id,
    scope: { level: r.scope_level, region: orNull(r.region), nationId: orNull(r.nation_id), agencyId: orNull(r.agency_id), countyFips: orNull(r.county_fips) },
    org: r.org,
    office: orNull(r.office),
    lineType: r.line_type,
    phone: r.phone_e164 ? { e164: r.phone_e164, display: r.phone_display, ext: orNull(r.ext) } : null,
    email: orNull(r.email),
    url: orNull(r.url),
    hours: orNull(r.hours),
    publishedByNation: r.published_by_nation === 'true',
    person: orNull(r.person),
    source: { url: r.source_url, publisher: r.source_publisher || r.org, kind: r.source_kind, snippet: r.source_snippet },
    verification: { verifiedAt: r.verified_at, method: r.verified_method, reviewDue },
    status,
    sortWeight: sortWeight(r),
  };
}

/**
 * Validate and compile parsed CSV rows from all files.
 * @param {{ file: string, header: string[], rows: ContactRow[] }[]} files
 * @param {{ today: string, validateRow: (row: unknown) => string[], validateItem: (item: unknown) => string[] }} opts
 * @returns {{ items: Record<string, any>[], held: string[] }}
 */
export function compileRows(files, opts) {
  /** @type {string[]} */
  const problems = [];
  /** @type {Map<string, string>} */
  const seen = new Map();
  /** @type {Record<string, any>[]} */
  const items = [];
  /** @type {string[]} */
  const held = [];
  for (const f of files) {
    if (f.header.join(',') !== CONTACT_HEADER.join(',')) problems.push(`${f.file}: header differs from the contact CSV header (blueprint 5.3)`);
    for (const [i, r] of f.rows.entries()) {
      const at = `${f.file} row ${i + 2}`;
      for (const e of opts.validateRow(r)) problems.push(`${at}: ${e}`);
      if (seen.has(r.id)) problems.push(`${at}: duplicate id ${r.id} (also in ${seen.get(r.id)})`);
      else seen.set(r.id, f.file);
      if (r.person && r.published_by_nation !== 'true') problems.push(`${at}: person requires published_by_nation true`);
      if (r.phone_e164 && (/\b(cell|mobile)\b/i.test(`${r.office} ${r.role}`) || mobileBeforeNumber(r))) problems.push(`${at}: the recorded number looks like a personal mobile number (blueprint 5.3)`);
      if (r.verified_at && utc(opts.today) - utc(r.verified_at) > 365 * DAY) problems.push(`${at}: verification is more than 365 days old`);
      if (r.status === 'conflict' && r.preferred !== 'true') { held.push(r.id); continue; }
      const item = mapRow(r, opts.today);
      for (const e of opts.validateItem(item)) problems.push(`${at}: ${e}`);
      items.push(item);
    }
  }
  if (problems.length) throw new Error(`contacts: ${problems.length} problem(s)\n  ${problems.join('\n  ')}`);
  items.sort((a, b) => a.sortWeight - b.sortWeight || a.id.localeCompare(b.id));
  return { items, held };
}

/**
 * @param {import('./all.mjs').CompileContext} ctx
 * @returns {Promise<import('./all.mjs').CompileResult>}
 */
export async function compileContacts(ctx) {
  const dir = path.join(ctx.root, 'data', 'contacts');
  /** @type {string[]} */
  let csvs = [];
  try { csvs = (await readdir(dir)).filter((n) => n.endsWith('.csv')).sort(); } catch { /* no inputs yet */ }
  if (csvs.length === 0) return { outputs: [], skipped: 'no data/contacts/*.csv yet' };
  const ajv = await loadAjv();
  const vRow = ajv.getSchema(`${SCHEMA_BASE}contact-row.schema.json`);
  const vItem = ajv.getSchema(`${SCHEMA_BASE}contact.schema.json`);
  if (!vRow || !vItem) throw new Error('contact schemas are not registered');
  /** @param {import('ajv').ValidateFunction} v @returns {(x: unknown) => string[]} */
  const errs = (v) => (x) => (v(x) ? [] : (v.errors ?? []).map((e) => `${e.instancePath || '/'} ${e.message}`));
  const files = [];
  for (const n of csvs) {
    const text = await readFile(path.join(dir, n), 'utf8');
    const header = (text.replace(/^\uFEFF/, '').split(/\r?\n/, 1)[0] ?? '').split(',');
    files.push({ file: `data/contacts/${n}`, header, rows: /** @type {ContactRow[]} */ (parseCsv(text)) });
  }
  const { items, held } = compileRows(files, { today: ctx.generatedAt.slice(0, 10), validateRow: errs(vRow), validateItem: errs(vItem) });
  const out = path.join(ctx.outDir, 'contacts.json');
  await writeFile(out, `${JSON.stringify({ schema: 'cthd.curated.contacts/1', generatedAt: ctx.generatedAt, items })}\n`);
  if (held.length) console.log(`compile:contacts held back ${held.length} conflict row(s): ${held.join(', ')}`);
  return { outputs: [out], skipped: null };
}
