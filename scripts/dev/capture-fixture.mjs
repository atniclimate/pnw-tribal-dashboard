// @ts-check
/**
 * Capture a dated, real upstream response as a test fixture.
 *
 *   node scripts/dev/capture-fixture.mjs --source nws-alerts-active --label footprint-active \
 *     --url "https://api.weather.gov/alerts/active?area=WA&status=actual" [--accept application/geo+json] [--ext json]
 *
 * Writes tests/fixtures/upstream/<source>/<YYYY-MM-DD>-<label>.<ext> with the response body exactly as
 * received (byte for byte), plus a sidecar <same name>.meta.json (schema cthd.fixture-meta/1) that records
 * the request, the capture instant, the HTTP status, and the SHA-256 of the body. The date in the file name
 * is the UTC date of the capture. A fixture derived from a capture by a minimal edit is written with
 * deriveFixture(), which records the parent file and every edit; the edit must also be described in the
 * README.md next to it. Never invent a whole payload.
 *
 * Development tool only: it runs on a maintainer's machine, never in the deployed site, which is why it may
 * call fetch directly (see eslint.config.mjs).
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const FIXTURE_ROOT = path.join(ROOT, 'tests', 'fixtures', 'upstream');
export const USER_AGENT = '(atniclimate.github.io/pnw-tribal-dashboard, climate@atnitribes.org)';

/**
 * @typedef {{ sourceId: string, label: string, url: string, accept?: string, ext?: string,
 *             covers?: string[], notes?: string, timeoutMs?: number }} CaptureRequest
 * @typedef {{ schema: 'cthd.fixture-meta/1', sourceId: string, label: string, file: string, url: string,
 *             method: 'GET', requestHeaders: Record<string, string>, capturedAt: string, status: number,
 *             contentType: string | null, lastModified: string | null, bytes: number, sha256: string,
 *             covers: string[], derivedFrom: string | null, edits: string[], notes: string }} FixtureMeta
 */

/** @param {Uint8Array | string} body */
export function sha256(body) {
  return createHash('sha256').update(body).digest('hex');
}

/** @param {string} s */
function assertSafeSegment(s) {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(s)) throw new Error(`unsafe path segment "${s}" (kebab-case only)`);
}

/**
 * Fetch one URL and write the body and its metadata. Throws on HTTP errors so a failed capture never
 * becomes a fixture.
 * @param {CaptureRequest} req
 * @returns {Promise<{ file: string, meta: FixtureMeta, body: Buffer }>}
 */
export async function captureFixture(req) {
  assertSafeSegment(req.sourceId);
  assertSafeSegment(req.label);
  const ext = req.ext ?? 'json';
  /** @type {Record<string, string>} */
  const headers = { 'User-Agent': USER_AGENT, Accept: req.accept ?? 'application/json' };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), req.timeoutMs ?? 60_000);
  let res;
  try {
    res = await fetch(req.url, { headers, signal: controller.signal, redirect: 'follow' });
  } finally {
    clearTimeout(timer);
  }
  const capturedAt = new Date().toISOString();
  const body = Buffer.from(await res.arrayBuffer());
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${req.url}`);
  const name = `${capturedAt.slice(0, 10)}-${req.label}.${ext}`;
  const dir = path.join(FIXTURE_ROOT, req.sourceId);
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, name);
  /** @type {FixtureMeta} */
  const meta = {
    schema: 'cthd.fixture-meta/1',
    sourceId: req.sourceId,
    label: req.label,
    file: name,
    url: req.url,
    method: 'GET',
    requestHeaders: headers,
    capturedAt,
    status: res.status,
    contentType: res.headers.get('content-type'),
    lastModified: res.headers.get('last-modified'),
    bytes: body.length,
    sha256: sha256(body),
    covers: req.covers ?? [],
    derivedFrom: null,
    edits: [],
    notes: req.notes ?? '',
  };
  await writeFile(file, body);
  await writeFile(file.replace(/\.[a-z]+$/, '.meta.json'), JSON.stringify(meta, null, 2) + '\n');
  return { file, meta, body };
}

/**
 * Write a fixture derived from a real capture by a minimal, recorded edit.
 * @param {{ parentFile: string, label: string, edits: string[], covers?: string[], notes?: string,
 *           transform: (text: string) => string }} spec
 */
export async function deriveFixture(spec) {
  assertSafeSegment(spec.label);
  if (spec.edits.length === 0) throw new Error('a derived fixture must record at least one edit');
  const parentMetaPath = spec.parentFile.replace(/\.[a-z]+$/, '.meta.json');
  /** @type {FixtureMeta} */
  const parent = JSON.parse(await readFile(parentMetaPath, 'utf8'));
  const text = spec.transform(await readFile(spec.parentFile, 'utf8'));
  const ext = path.extname(spec.parentFile).slice(1);
  const name = `${parent.capturedAt.slice(0, 10)}-${spec.label}.${ext}`;
  const file = path.join(path.dirname(spec.parentFile), name);
  /** @type {FixtureMeta} */
  const meta = {
    ...parent,
    label: spec.label,
    file: name,
    bytes: Buffer.byteLength(text),
    sha256: sha256(text),
    covers: spec.covers ?? [],
    derivedFrom: parent.file,
    edits: spec.edits,
    notes: spec.notes ?? '',
  };
  await writeFile(file, text);
  await writeFile(file.replace(/\.[a-z]+$/, '.meta.json'), JSON.stringify(meta, null, 2) + '\n');
  return { file, meta };
}

/** @param {string[]} argv */
function parseArgs(argv) {
  /** @type {Record<string, string>} */
  const out = {};
  for (let i = 0; i < argv.length; i += 2) {
    const k = argv[i];
    const v = argv[i + 1];
    if (!k?.startsWith('--') || v === undefined) throw new Error(`bad argument near "${k ?? ''}"`);
    out[k.slice(2)] = v;
  }
  return out;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const a = parseArgs(process.argv.slice(2));
  if (!a.source || !a.label || !a.url) {
    console.error('usage: capture-fixture.mjs --source <id> --label <label> --url <url> [--accept <type>] [--ext json]');
    process.exit(2);
  }
  /** @type {CaptureRequest} */
  const req = { sourceId: a.source, label: a.label, url: a.url };
  if (a.accept) req.accept = a.accept;
  if (a.ext) req.ext = a.ext;
  if (a.covers) req.covers = a.covers.split(',');
  const { file, meta } = await captureFixture(req);
  console.log(`${path.relative(ROOT, file)}  ${meta.bytes} bytes  ${meta.capturedAt}`);
}
