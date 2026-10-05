// @ts-check
/**
 * Shared helpers for the forecast tests (not a test file). The source registry comes from data/sources/*.yaml,
 * the upstream payloads from the dated captures in tests/fixtures/upstream, and `installFetch` answers the
 * browser modules' requests from them, so URLs and headers are asserted against the real registry records.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { CORE_SCHEMA, load } from 'js-yaml';
import { registerSources } from '../../../site/static/js/core/sources.js';
import { clearMemoryCache } from '../../../site/static/js/core/net.js';

export const ROOT = new URL('../../../', import.meta.url);

/** Registers every source record. */
export function loadRegistry() {
  const dir = new URL('data/sources/', ROOT);
  const records = readdirSync(dir).filter((f) => f.endsWith('.yaml')).map((f) => /** @type {any} */ (load(readFileSync(new URL(f, dir), 'utf8'), { schema: CORE_SCHEMA })));
  registerSources(records);
  return records;
}

/**
 * @param {string} source fixture folder
 * @param {string} name file name
 * @returns {any}
 */
export function fixture(source, name) {
  return JSON.parse(readFileSync(new URL(`tests/fixtures/upstream/${source}/${name}`, ROOT), 'utf8'));
}

/**
 * Answers fetch() from a list of [matcher, response] pairs; an unmatched request is a network error.
 * @param {[(url: string) => boolean, { status?: number, body?: unknown, headers?: Record<string, string> }][]} routes
 * @returns {{ calls: { url: string, headers: Record<string, string> }[], restore: () => void }}
 */
export function installFetch(routes) {
  const original = globalThis.fetch;
  /** @type {{ url: string, headers: Record<string, string> }[]} */
  const calls = [];
  clearMemoryCache();
  globalThis.fetch = /** @type {any} */ (async (/** @type {string} */ input, /** @type {RequestInit} */ init) => {
    const url = String(input);
    calls.push({ url, headers: /** @type {Record<string, string>} */ ({ ...(init?.headers ?? {}) }) });
    const hit = routes.find(([match]) => match(url));
    if (!hit) throw new TypeError(`no route for ${url}`);
    const { status = 200, body = {}, headers = {} } = hit[1];
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
  });
  return { calls, restore: () => { globalThis.fetch = original; clearMemoryCache(); } };
}

/**
 * @param {string} needle
 * @returns {(url: string) => boolean}
 */
export const urlHas = (needle) => (url) => url.includes(needle);
