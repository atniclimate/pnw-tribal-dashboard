// @ts-check
/**
 * Shared helpers for the alert engine tests (lane L3): dated fixture loading and golden outputs.
 *
 * Golden files live in tests/fixtures/alerts/expected/. Each holds a normalizer's output for one dated
 * capture, with every alert's text replaced by the SHA-256 of its `sourceLanguage` JSON (the text is
 * verbatim upstream content and already in the capture). Regenerate after a reviewed change with
 *   $env:UPDATE_GOLDEN = '1'; node --test tests/unit/alerts/golden.test.mjs
 * and review the diff before committing.
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
export const UPSTREAM = path.join(ROOT, 'tests', 'fixtures', 'upstream');
export const EXPECTED = path.join(ROOT, 'tests', 'fixtures', 'alerts', 'expected');

/**
 * A dated capture and its sidecar.
 * @param {string} source
 * @param {string} name file name without the date prefix, for example 'footprint-active.json'
 * @returns {{ body: any, text: string, meta: { capturedAt: string, url: string, file: string } }}
 */
export function fixture(source, name) {
  const file = path.join(UPSTREAM, source, `2026-10-05-${name}`);
  const text = readFileSync(file, 'utf8');
  const meta = JSON.parse(readFileSync(file.replace(/\.(json|xml)$/, '.meta.json'), 'utf8'));
  let body = null;
  if (file.endsWith('.json')) body = JSON.parse(text);
  return { body, text, meta };
}

/**
 * The normalizer context for a capture: fetched and evaluated at its own capture instant.
 * @param {{ capturedAt: string }} meta
 * @returns {{ fetchedAt: string, now: Date }}
 */
export function ctxOf(meta) {
  return { fetchedAt: meta.capturedAt, now: new Date(meta.capturedAt) };
}

/** @param {unknown} v @returns {string} */
export function sha256(v) {
  return createHash('sha256').update(JSON.stringify(v)).digest('hex');
}

/**
 * Alerts for golden files: the fields the engine derives, in the clear, plus the SHA-256 of the whole
 * normalized alert (text, geometry, parameters, and every other field), so any change shows as a diff.
 * @param {any[]} alerts
 * @returns {any[]}
 */
export function goldenAlerts(alerts) {
  return alerts.map((a) => ({
    alertId: a.alertId,
    eventId: a.eventId,
    messageType: a.messageType,
    references: a.references,
    event: a.event,
    designation: a.designation,
    band: a.band,
    posture: a.posture,
    confidence: a.confidence,
    categories: a.categories,
    zones: a.zones,
    jurisdictions: a.jurisdictions,
    marine: a.marine,
    geometryBasis: a.provenance?.coverage?.geometryBasis,
    languages: Object.keys(a.sourceLanguage ?? {}),
    webUrl: a.webUrl,
    mappingApplied: a.provenance?.mappingApplied,
    sha256: sha256(a),
  }));
}

/**
 * Compare with (or, under UPDATE_GOLDEN=1, write) a golden file.
 * @param {string} name file name under tests/fixtures/alerts/expected/
 * @param {unknown} actual
 */
export function assertGolden(name, actual) {
  const file = path.join(EXPECTED, name);
  const json = `${JSON.stringify(actual, null, 1)}\n`;
  if (process.env.UPDATE_GOLDEN === '1' || !existsSync(file)) {
    if (process.env.UPDATE_GOLDEN !== '1') assert.fail(`golden ${name} is missing; run with UPDATE_GOLDEN=1 and review it`);
    mkdirSync(EXPECTED, { recursive: true });
    writeFileSync(file, json, 'utf8');
    return;
  }
  assert.deepEqual(JSON.parse(json), JSON.parse(readFileSync(file, 'utf8')), `output differs from golden ${name}`);
}

/**
 * A registry fixture Nation record.
 * @param {string} id
 * @returns {import('../../../site/static/js/types.js').NationRecord}
 */
export function fixtureNation(id) {
  return JSON.parse(readFileSync(path.join(ROOT, 'tests', 'fixtures', 'registry', 'nations', `${id}.json`), 'utf8'));
}

/** Deterministic pseudo-random numbers for property tests (mulberry32). @param {number} seed */
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * The footprint zone index for these tests: the typed keys of the footprint capture's Washington, Oregon,
 * Idaho, Puget Sound and coast, and Southeast Alaska zones (a test input, not the L4 reference).
 */
export function testFootprintUgc() {
  const keys = new Set();
  for (const f of fixture('nws-alerts-active', 'footprint-active.json').body.features) {
    for (const u of f.properties.affectedZones ?? []) {
      const m = /zones\/(forecast|county|fire)\/((WA|OR|ID|AK|PZ|PK)[CZ]\d{3})$/.exec(u);
      if (!m) continue;
      const code = /** @type {string} */ (m[2]);
      if (code.startsWith('AKZ') && Number(code.slice(3)) > 400) continue;
      keys.add(/^P[ZK]Z/.test(code) ? `marine:${code}` : `${m[1]}:${code}`);
    }
  }
  return { schema: 'cthd.footprint-ugc/1', generatedAt: '2026-10-05T06:23:39Z', zones: [...keys].sort(), edgeCodes: [], marineToRegion: {} };
}
