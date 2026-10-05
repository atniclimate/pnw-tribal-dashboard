// @ts-check
/**
 * Source health probe. Reads the `health` block of each active source record and judges the response.
 *
 *   node scripts/health/probe-sources.mjs [source-id ...]
 *
 * The record's `health` schema cannot say "reject watermark tiles", so that rule lives here (decision Q10,
 * 10/05/2026): a CARTO tile served without a valid key is HTTP 200, image/png, and larger than the byte
 * minimum, but carries an ETag that begins `wm-` and shows an "API KEY REQUIRED" watermark. Such a response
 * is a failure, never a pass. The key comes from the ATNI_BASEMAP_KEY environment variable; a probe URL that
 * still holds the placeholder is skipped and reported as skipped, not as healthy.
 */
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { CORE_SCHEMA, load as loadYaml } from 'js-yaml';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const KEY_PLACEHOLDER = '<ATNI_BASEMAP_KEY>';
export const KEY_ENV = 'ATNI_BASEMAP_KEY';

/**
 * True when an ETag marks a CARTO watermark tile: the value, with or without the weak prefix and quotes,
 * begins `wm-`.
 * @param {string | null | undefined} etag
 * @returns {boolean}
 */
export function isWatermarkEtag(etag) {
  if (!etag) return false;
  return /^(?:W\/)?"?wm-/.test(etag.trim());
}

/**
 * Judge one probe response against a record's `health` block.
 * @param {{ expectStatus: number, expectAcao: string | null, expectType: string | null, minBytes: number | null, maxBytes: number | null }} health
 * @param {{ status: number, headers: { get(name: string): string | null }, bytes: number }} res
 * @returns {{ ok: boolean, failures: string[] }}
 */
export function judgeProbe(health, res) {
  /** @type {string[]} */
  const failures = [];
  if (res.status !== health.expectStatus) failures.push(`status ${res.status}, expected ${health.expectStatus}`);
  if (health.expectAcao !== null) {
    const acao = res.headers.get('access-control-allow-origin');
    if (acao !== health.expectAcao) failures.push(`Access-Control-Allow-Origin ${acao ?? 'absent'}, expected ${health.expectAcao}`);
  }
  if (health.expectType !== null) {
    const type = (res.headers.get('content-type') ?? '').split(';')[0]?.trim() ?? '';
    if (type !== health.expectType) failures.push(`content type ${type || 'absent'}, expected ${health.expectType}`);
  }
  if (health.minBytes !== null && res.bytes < health.minBytes) failures.push(`${res.bytes} bytes, expected at least ${health.minBytes}`);
  if (health.maxBytes !== null && res.bytes > health.maxBytes) failures.push(`${res.bytes} bytes, expected at most ${health.maxBytes}`);
  const etag = res.headers.get('etag');
  if (isWatermarkEtag(etag)) failures.push(`watermark tile (ETag ${etag}); the basemap key is missing, wrong, or revoked`);
  return { ok: failures.length === 0, failures };
}

/**
 * The probe URL with the basemap key filled in, or null when the key is still a placeholder.
 * @param {string} probe
 * @param {Record<string, string | undefined>} [env]
 * @returns {string | null}
 */
export function resolveProbeUrl(probe, env = process.env) {
  // A probe is a URI, so the record spells the placeholder percent-encoded; the literal form is accepted too.
  const holder = [KEY_PLACEHOLDER, encodeURIComponent(KEY_PLACEHOLDER)].find((p) => probe.includes(p));
  if (!holder) return probe;
  const key = env[KEY_ENV];
  return key ? probe.replace(holder, encodeURIComponent(key)) : null;
}

/**
 * @param {string} [root]
 * @returns {Promise<{ id: string, status: string, health: any }[]>}
 */
export async function loadProbeRecords(root = ROOT) {
  const dir = path.join(root, 'data', 'sources');
  const names = (await readdir(dir)).filter((n) => n.endsWith('.yaml')).sort();
  /** @type {{ id: string, status: string, health: any }[]} */
  const out = [];
  for (const n of names) {
    const rec = /** @type {any} */ (loadYaml(await readFile(path.join(dir, n), 'utf8'), { schema: CORE_SCHEMA }));
    if (rec?.health) out.push({ id: rec.id, status: rec.status, health: rec.health });
  }
  return out;
}

/**
 * @param {{ id: string, health: any }} rec
 * @param {(url: string, init?: RequestInit) => Promise<Response>} [fetchImpl]
 * @param {Record<string, string | undefined>} [env]
 * @returns {Promise<{ id: string, result: 'ok' | 'failed' | 'skipped', failures: string[] }>}
 */
export async function probeRecord(rec, fetchImpl = (url, init) => globalThis.fetch(url, init), env = process.env) {
  const url = resolveProbeUrl(rec.health.probe, env);
  if (!url) return { id: rec.id, result: 'skipped', failures: [`${KEY_ENV} is not set, so the keyed probe was not sent`] };
  try {
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(20_000), headers: { Origin: 'https://atniclimate.github.io' } });
    const bytes = (await res.arrayBuffer()).byteLength;
    const verdict = judgeProbe(rec.health, { status: res.status, headers: res.headers, bytes });
    return { id: rec.id, result: verdict.ok ? 'ok' : 'failed', failures: verdict.failures };
  } catch (e) {
    return { id: rec.id, result: 'failed', failures: [`request failed: ${/** @type {Error} */ (e).message}`] };
  }
}

async function main() {
  const wanted = process.argv.slice(2);
  const records = (await loadProbeRecords()).filter((r) => wanted.length === 0 || wanted.includes(r.id));
  let failed = 0;
  for (const rec of records) {
    const r = await probeRecord(rec);
    if (r.result === 'failed') failed += 1;
    console.log(`${r.result.toUpperCase().padEnd(7)} ${r.id}${r.failures.length ? `: ${r.failures.join('; ')}` : ''}`);
  }
  process.exitCode = failed > 0 ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
