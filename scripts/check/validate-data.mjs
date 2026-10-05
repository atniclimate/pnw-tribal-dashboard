// @ts-check
/**
 * validate:data (blueprint 6.6, 10.1). Schema gate over every file in schemas/catalog.json, the
 * named-person guard over data/, site/data/, and tests/fixtures/registry/, plus the gates of blueprint 6.6
 * that run in CI: cross-references, names, honesty, contacts freshness, the person rule, and the
 * footprint-ratified warning. The id-stability, count-drift, headquarters-drift, and live-payload gates
 * belong to the reference refresh and the deploy (lanes L5 and L9) and are not run here.
 *
 * Every gate is a pure function of a corpus (see `loadCorpus`), so tests seed violations in memory.
 * A gate whose input files do not exist yet reports nothing; absence is never a pass for a file that
 * exists, only for a lane that has not delivered it. Owner: lane L15 (after L0's skeleton).
 *
 * Environment: CTHD_TODAY (YYYY-MM-DD) pins "today" for the freshness gate in tests.
 */
import path from 'node:path';
import { readdir, readFile } from 'node:fs/promises';
import { ROOT, isMain } from './lib/pages.mjs';
import { SCHEMA_BASE, expand, loadAjv, loadCatalog, parseDataFile, personKeyHits } from './lib/data-files.mjs';

const GUARDED_DIRS = ['data', 'site/data', 'tests/fixtures/registry'];
const DAY_MS = 86_400_000;

/** Local-part words that mark a role mailbox, so `emergency.management@` is not read as a person. */
const ROLE_WORDS = new Set([
  'admin', 'alerts', 'climate', 'contact', 'dispatch', 'emergency', 'environmental', 'fire', 'general', 'hazard', 'hazards',
  'health', 'info', 'management', 'natural', 'office', 'operations', 'planning', 'police', 'program', 'public', 'resources',
  'safety', 'services', 'support', 'tribal', 'utilities', 'water', 'works', 'natural-resources', 'duty', 'officer', 'oem',
]);

/** @param {string} dir repository-relative @returns {Promise<string[]>} */
async function walkData(dir) {
  /** @type {string[]} */
  const out = [];
  /** @param {string} rel */
  async function walk(rel) {
    let entries;
    try { entries = await readdir(path.join(ROOT, rel), { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const r = `${rel}/${e.name}`;
      if (e.isDirectory()) await walk(r);
      else if (/\.(json|ya?ml|csv)$/.test(e.name)) out.push(r);
    }
  }
  await walk(dir);
  return out;
}

/** @param {string} rel @returns {Promise<unknown>} undefined when the file is absent */
async function readIf(rel) {
  try { return await parseDataFile(rel); } catch (e) {
    if (/** @type {NodeJS.ErrnoException} */ (e).code === 'ENOENT') return undefined;
    throw e;
  }
}

/** @param {string} dir @param {RegExp} re @returns {Promise<string[]>} */
async function listDir(dir, re) {
  try { return (await readdir(path.join(ROOT, dir))).filter((n) => re.test(n)).sort().map((n) => `${dir}/${n}`); } catch { return []; }
}

/** @param {string} dir repository-relative @returns {Promise<string[]>} every .js file under dir */
async function walkJs(dir) {
  /** @type {string[]} */
  const out = [];
  /** @param {string} rel */
  async function walk(rel) {
    let entries;
    try { entries = await readdir(path.join(ROOT, rel), { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const r = `${rel}/${e.name}`;
      if (e.isDirectory()) { if (e.name !== 'vendor') await walk(r); } else if (e.name.endsWith('.js')) out.push(r);
    }
  }
  await walk(dir);
  return out;
}

/**
 * @typedef {{ file: string, rec: Record<string, any> }} Located
 * @typedef {{
 *   sourceIds: Set<string> | null,
 *   nations: Located[],
 *   productionNationIds: Set<string> | null,
 *   contacts: Located[],
 *   agencyIds: Set<string> | null,
 *   eventIds: Set<string> | null,
 *   resources: Located[],
 *   declarations: Located[],
 *   gaugeIds: Set<string> | null,
 *   footprint: Record<string, any> | null,
 *   fetchIds: { file: string, id: string }[],
 *   registryFiles: Set<string>,
 * }} Corpus
 */

/** @returns {Promise<Corpus>} */
export async function loadCorpus() {
  const srcFiles = await listDir('data/sources', /\.ya?ml$/);
  /** @type {Set<string> | null} */
  let sourceIds = null;
  if (srcFiles.length) {
    sourceIds = new Set();
    for (const f of srcFiles) { const r = /** @type {any} */ (await readIf(f)); if (r?.id) sourceIds.add(String(r.id)); }
  }
  /** @type {Located[]} */
  const nations = [];
  /** @type {Set<string>} */
  const registryFiles = new Set();
  for (const base of ['site/data/registry', 'tests/fixtures/registry']) {
    for (const f of await listDir(`${base}/nations`, /\.json$/)) nations.push({ file: f, rec: /** @type {any} */ (await readIf(f)) });
    for (const f of await walkData(`${base}/geo`)) registryFiles.add(f);
  }
  const prodNations = nations.filter((n) => n.file.startsWith('site/data/registry/'));
  const productionNationIds = prodNations.length ? new Set(prodNations.map((n) => String(n.rec.id))) : null;
  /** @type {Located[]} */
  const contacts = [];
  for (const f of await listDir('data/contacts', /\.csv$/)) {
    const rows = /** @type {any[]} */ (await readIf(f)) ?? [];
    rows.forEach((rec, i) => contacts.push({ file: `${f} row ${i + 2}`, rec }));
  }
  const agencies = /** @type {any[] | undefined} */ (await readIf('data/agencies.yaml'));
  const eventFiles = await listDir('data/events', /\.ya?ml$/);
  const eventIds = eventFiles.length ? new Set(await Promise.all(eventFiles.map(async (f) => String(/** @type {any} */ (await readIf(f))?.id)))) : null;
  const resources = /** @type {any[]} */ ((await readIf('data/resources.yaml')) ?? []).map((rec, i) => ({ file: `data/resources.yaml #${i + 1}`, rec }));
  const declarations = /** @type {any[]} */ ((await readIf('data/declarations/curated.yaml')) ?? []).map((rec, i) => ({ file: `data/declarations/curated.yaml #${i + 1}`, rec }));
  const gauges = /** @type {any} */ (await readIf('site/data/ref/gauges.json'));
  const footprint = /** @type {any} */ ((await readIf('data/pipeline/footprint.yaml')) ?? null);
  /** @type {{ file: string, id: string }[]} */
  const fetchIds = [];
  for (const f of await walkJs('site/static/js')) {
    const text = await readFile(path.join(ROOT, f), 'utf8');
    for (const m of text.matchAll(/fetchJson\(\s*['"]([a-z0-9-]+)['"]/g)) fetchIds.push({ file: f, id: m[1] ?? '' });
  }
  return {
    sourceIds, nations, productionNationIds, contacts, agencyIds: agencies ? new Set(agencies.map((a) => String(a.id))) : null,
    eventIds, resources, declarations, gaugeIds: gauges ? new Set(gauges.gauges.map((/** @type {any} */ g) => String(g.id))) : null,
    footprint, fetchIds, registryFiles,
  };
}

/** @typedef {{ problems: string[], warnings: string[] }} Findings */

/**
 * Cross-references (blueprint 6.6): ids must resolve. Source ids are checked only for production data;
 * the five-Nation fixture predates the source records its owner registers.
 * @param {Corpus} c @returns {Findings}
 */
export function crossReferences(c) {
  /** @type {Findings} */
  const f = { problems: [], warnings: [] };
  const contactIds = new Set(c.contacts.map((x) => String(x.rec.id)));
  // Until lane L5 commits the production registry there is nothing for Nation ids to resolve against; say so
  // once as a warning rather than failing every contact row. Fixture-only Nation ids never stand in for it.
  const knownNations = c.productionNationIds;
  if (!knownNations && (c.contacts.length || c.resources.length || c.declarations.length)) {
    f.warnings.push('site/data/registry/nations is not committed yet; Nation id references were not resolved');
  }
  for (const n of c.nations) {
    const prod = n.file.startsWith('site/data/registry/');
    const regRoot = path.posix.dirname(path.posix.dirname(n.file));
    const ref = n.rec.boundary?.detailRef;
    if (ref && !c.registryFiles.has(`${regRoot}/${ref}`)) f.problems.push(`${n.file}: boundary.detailRef ${ref} does not resolve`);
    if (c.contacts.length) for (const id of n.rec.contactIds ?? []) if (!contactIds.has(id)) f.problems.push(`${n.file}: contactIds ${id} does not resolve`);
    if (c.gaugeIds) for (const id of n.rec.gauges ?? []) if (!c.gaugeIds.has(id)) f.problems.push(`${n.file}: gauges ${id} does not resolve`);
    if (prod && c.sourceIds) {
      const ids = [n.rec.hq?.sourceId, ...(n.rec.boundary?.parts ?? []).map((/** @type {any} */ p) => p.sourceId)].filter(Boolean);
      for (const id of ids) if (!c.sourceIds.has(id)) f.problems.push(`${n.file}: sourceId ${id} is not registered`);
    }
  }
  for (const x of c.contacts) {
    if (knownNations && x.rec.nation_id && !knownNations.has(x.rec.nation_id)) f.problems.push(`${x.file}: nation_id ${x.rec.nation_id} does not resolve`);
    if (x.rec.agency_id && c.agencyIds && !c.agencyIds.has(x.rec.agency_id)) f.problems.push(`${x.file}: agency_id ${x.rec.agency_id} does not resolve`);
  }
  for (const x of c.resources) {
    if (knownNations && x.rec.nationId && !knownNations.has(x.rec.nationId)) f.problems.push(`${x.file}: nationId ${x.rec.nationId} does not resolve`);
  }
  for (const x of c.declarations) {
    if (knownNations && x.rec.issuer?.nationId && !knownNations.has(x.rec.issuer.nationId)) f.problems.push(`${x.file}: issuer.nationId ${x.rec.issuer.nationId} does not resolve`);
    if (x.rec.eventId && c.eventIds && !c.eventIds.has(x.rec.eventId)) f.problems.push(`${x.file}: eventId ${x.rec.eventId} does not resolve`);
  }
  if (c.sourceIds) for (const { file, id } of c.fetchIds) if (!c.sourceIds.has(id)) f.problems.push(`${file}: fetchJson('${id}') names an unregistered source`);
  return f;
}

/**
 * Names (blueprint 6.6): no U+FFFD anywhere; no question mark in a `reviewed` name (a draft name with one
 * is a warning, because the five-Nation fixture carries a source's ASCII rendering); a name never equals
 * an alias of the same Nation or of another Nation (aliases are search keys, never displayed).
 * @param {Corpus} c @returns {Findings}
 */
export function nameGates(c) {
  /** @type {Findings} */
  const f = { problems: [], warnings: [] };
  /** @type {Map<string, string>} */
  const aliasOwner = new Map();
  for (const n of c.nations) for (const a of n.rec.aliases ?? []) aliasOwner.set(String(a).toLowerCase(), n.rec.id);
  for (const n of c.nations) {
    const names = [n.rec.name, n.rec.preferredName].filter((s) => typeof s === 'string');
    for (const name of names) {
      if (name.includes('�')) f.problems.push(`${n.file}: name contains U+FFFD`);
      if (name.includes('?')) {
        const msg = `${n.file}: name "${name}" contains "?"`;
        if (n.rec.review?.status === 'reviewed') f.problems.push(msg); else f.warnings.push(`${msg} (review status ${n.rec.review?.status ?? 'unknown'})`);
      }
    }
    const owner = aliasOwner.get(String(n.rec.name).toLowerCase());
    if (owner) f.problems.push(`${n.file}: name equals a listed short form (alias of ${owner})`);
  }
  return f;
}

/**
 * Honesty (blueprint 6.6): a curated value without a source, a curated declaration without `source.url`,
 * an event item in `resources.yaml`.
 * @param {Corpus} c @returns {Findings}
 */
export function honestyGates(c) {
  /** @type {Findings} */
  const f = { problems: [], warnings: [] };
  for (const x of c.resources) {
    if (!x.rec.sourceUrl && !x.rec.url) f.problems.push(`${x.file}: curated resource has no source`);
    if (!x.rec.verifiedAt) f.problems.push(`${x.file}: curated resource has no verifiedAt`);
    if (['event', 'events', 'archive'].includes(String(x.rec.category)) || 'issuedOn' in x.rec || 'date' in x.rec) f.problems.push(`${x.file}: an event item belongs in the archive file, not resources.yaml`);
  }
  for (const x of c.declarations) {
    if (!x.rec.source?.url) f.problems.push(`${x.file}: curated declaration has no source.url`);
  }
  return f;
}

/** @param {string} url @returns {string} lower-case host without www, or '' */
function host(url) {
  try { return new URL(url).hostname.toLowerCase().replace(/^www\./, ''); } catch { return ''; }
}

/**
 * Contacts freshness and the person rule (blueprint 5.3, 6.6).
 * @param {Corpus} c @param {Date} today @returns {Findings}
 */
export function contactGates(c, today) {
  /** @type {Findings} */
  const f = { problems: [], warnings: [] };
  /** @type {Map<string, string>} */
  const websiteHost = new Map();
  for (const n of c.nations) if (typeof n.rec.website === 'string') websiteHost.set(n.rec.id, host(n.rec.website));
  for (const x of c.contacts) {
    const r = x.rec;
    const verified = Date.parse(r.verified_at ?? '');
    if (Number.isFinite(verified) && today.getTime() - verified > 365 * DAY_MS) f.problems.push(`${x.file}: verified_at ${r.verified_at} is more than 365 days old`);
    const due = Date.parse(r.review_due ?? '');
    if (Number.isFinite(due) && due < today.getTime()) f.warnings.push(`${x.file}: review_due ${r.review_due} has passed (renders with the Verification Due tag)`);
    const nationHost = websiteHost.get(r.nation_id ?? '') ?? '';
    const publishedOnNationDomain = String(r.published_by_nation).toLowerCase() === 'true' && nationHost !== '' && host(r.source_url ?? '') === nationHost;
    if (r.person && String(r.person).trim() !== '' && !publishedOnNationDomain) {
      f.problems.push(`${x.file}: person value needs published_by_nation true and a source on the Nation's own domain`);
    }
    const local = String(r.email ?? '').split('@')[0]?.toLowerCase() ?? '';
    const parts = local.split(/[._-]/).filter(Boolean);
    if (r.email && parts.length >= 2 && parts.every((p) => /^[a-z]{2,}$/.test(p)) && !parts.some((p) => ROLE_WORDS.has(p)) && !publishedOnNationDomain) {
      f.problems.push(`${x.file}: email local part "${local}" looks like a person without a Nation-domain source`);
    }
  }
  return f;
}

/** @param {Corpus} c @returns {Findings} */
export function footprintGate(c) {
  /** @type {Findings} */
  const f = { problems: [], warnings: [] };
  if (c.footprint && c.footprint.ratified !== true) f.warnings.push('data/pipeline/footprint.yaml has ratified: false (maintainer gate; warning only)');
  return f;
}

/**
 * @param {Corpus} c @param {Date} [today]
 * @returns {Findings}
 */
export function allGates(c, today = new Date()) {
  /** @type {Findings} */
  const out = { problems: [], warnings: [] };
  for (const g of [crossReferences(c), nameGates(c), honestyGates(c), contactGates(c, today), footprintGate(c)]) {
    out.problems.push(...g.problems);
    out.warnings.push(...g.warnings);
  }
  return out;
}

export async function validateData() {
  const ajv = await loadAjv();
  /** @type {string[]} */
  const problems = [];
  /** @type {string[]} */
  const warnings = [];
  let files = 0;
  for (const entry of await loadCatalog()) {
    const validate = ajv.getSchema(SCHEMA_BASE + entry.schema);
    if (!validate) { problems.push(`schema ${entry.schema} is not registered`); continue; }
    for (const pattern of entry.files) {
      for (const rel of await expand(pattern)) {
        files += 1;
        let value;
        try { value = await parseDataFile(rel); } catch (e) { problems.push(`${rel}: ${/** @type {Error} */ (e).message}`); continue; }
        const targets = entry.format === 'csv-rows' && Array.isArray(value) ? value.map((row, i) => ({ row, at: `row ${i + 2}` })) : [{ row: value, at: '' }];
        for (const { row, at } of targets) {
          if (!validate(row)) {
            for (const err of validate.errors ?? []) problems.push(`${rel}${at ? ` ${at}` : ''}: ${err.instancePath || '/'} ${err.message ?? ''} (${entry.schema})`);
          }
        }
      }
    }
  }
  for (const dir of GUARDED_DIRS) {
    for (const rel of await walkData(dir)) {
      let value;
      try { value = await parseDataFile(rel); } catch { continue; }
      for (const hit of personKeyHits(value)) problems.push(`${rel}: named-person key ${hit} (blueprint 6.6)`);
    }
  }
  const today = process.env.CTHD_TODAY ? new Date(`${process.env.CTHD_TODAY}T00:00:00Z`) : new Date();
  const g = allGates(await loadCorpus(), today);
  problems.push(...g.problems);
  warnings.push(...g.warnings);
  return { files, problems, warnings };
}

if (isMain(import.meta.url)) {
  const { files, problems, warnings } = await validateData();
  for (const w of warnings) console.warn(`validate:data warning ${w}`);
  if (problems.length) {
    for (const p of problems) console.error(`validate:data ${p}`);
    console.error(`validate:data failed: ${problems.length} problem(s) in ${files} file(s)`);
    process.exit(1);
  }
  console.log(`validate:data ok (${files} files; schema, named-person, cross-reference, names, honesty, contacts, and footprint gates; ${warnings.length} warning(s))`);
}
