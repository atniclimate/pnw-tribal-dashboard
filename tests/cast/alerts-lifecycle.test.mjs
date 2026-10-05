// @ts-check
/**
 * CAST parity for the lifecycle resolver (blueprint 10.1, 3.7.7). `resolveAlertLifecycle` must equal CAST's
 * resolver (run from CAST's own TypeScript) on CAST's test cases and on generated message sequences; the
 * dashboard render rule `resolveLifecycle` must render the same current set on CAST's cases (ADR 0007
 * diverges only where CAST would hide a valid segment).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolveLifecycle } from '../../site/static/js/alerts/lifecycle.js';
import { resolveAlertLifecycle } from '../../site/static/js/alerts/mapping.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const castLifecycle = await import(pathToFileURL(path.join(ROOT, 'tests', 'fixtures', 'cast', 'alerts-schema', 'src', 'lifecycle.ts')).href);

/**
 * CAST's test helper `alert()`, as written in alerts-schema/src/index.test.ts.
 * @param {string} alertId @param {string} sent @param {'alert' | 'update' | 'cancel'} [messageType] @param {string[]} [references]
 * @returns {any}
 */
function alert(alertId, sent, messageType = 'alert', references = []) {
  return {
    alertId, eventId: alertId, sourceId: 'nws', sent, messageType, references, lifecycleState: 'active',
    event: 'Flood Warning', originalDesignation: 'Flood Warning', band: 'severe', posture: 'act-now', confidence: 'likely',
    effective: sent, expires: '2026-07-18T00:00:00Z', geometry: null,
    sourceLanguage: { 'en-US': { headline: 'Flood Warning', description: 'River flooding is expected.' } },
    translationAuthority: 'National Weather Service',
    provenance: { agency: 'nws', originalId: alertId.replace('nws:', ''), fetchedAt: '2026-07-17T12:00:00Z',
      mappingApplied: { name: 'atni-cast-nws-cap', version: '1.0.0' }, coverage: { geometryBasis: 'zone', geocodes: ['WAZ001'] } },
  };
}

const CASES = {
  olderSent: () => {
    const original = alert('nws:original', '2026-07-17T10:00:00Z');
    const newest = alert('nws:newest', '2026-07-17T12:00:00Z', 'update', [original.alertId]);
    const delayed = alert('nws:delayed', '2026-07-17T11:00:00Z', 'update', [original.alertId]);
    return [original, newest, delayed];
  },
  updateCancel: () => {
    const original = alert('nws:original', '2026-07-17T10:00:00Z');
    const update = alert('nws:update', '2026-07-17T11:00:00Z', 'update', [original.alertId]);
    const cancel = alert('nws:cancel', '2026-07-17T12:00:00Z', 'cancel', [update.alertId]);
    return [original, update, cancel];
  },
  outsideWindow: () => [alert('nws:update', '2026-07-17T11:00:00Z', 'update', ['nws:original'])],
};

test('resolveAlertLifecycle equals CAST on CAST\'s own cases, with and without asOf', () => {
  for (const [name, make] of Object.entries(CASES)) {
    for (const asOf of [undefined, '2026-07-17T23:00:00Z', '2026-07-18T00:00:00Z']) {
      assert.deepEqual(JSON.parse(JSON.stringify(resolveAlertLifecycle(make(), asOf))), JSON.parse(JSON.stringify(castLifecycle.resolveAlertLifecycle(make(), asOf))), `${name} ${asOf}`);
    }
  }
  const r = resolveAlertLifecycle(CASES.olderSent());
  assert.deepEqual(r.rejected, [{ alertId: 'nws:delayed', eventId: 'nws:original', reason: 'older-sent' }]);
});

test('resolveAlertLifecycle equals CAST on generated sequences', () => {
  let seed = 7;
  const r = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  for (let i = 0; i < 2000; i += 1) {
    const n = 1 + Math.floor(r() * 6);
    /** @type {any[]} */
    const msgs = [];
    for (let k = 0; k < n; k += 1) {
      /** @type {string[]} */
      const refs = msgs.length > 0 && r() < 0.6 ? [msgs[Math.floor(r() * msgs.length)].alertId] : r() < 0.1 ? ['nws:outside'] : [];
      /** @type {string} */
      const type = refs.length === 0 ? 'alert' : r() < 0.3 ? 'cancel' : 'update';
      /** @type {string} */
      const id = r() < 0.05 && msgs.length > 0 ? msgs[0].alertId : `nws:m${i}-${k}`;
      msgs.push(alert(id, `2026-07-17T${String(10 + Math.floor(r() * 4)).padStart(2, '0')}:00:00Z`, /** @type {any} */ (type), refs));
    }
    const asOf = r() < 0.5 ? undefined : '2026-07-18T00:00:00Z';
    assert.deepEqual(JSON.parse(JSON.stringify(resolveAlertLifecycle(msgs, asOf))), JSON.parse(JSON.stringify(castLifecycle.resolveAlertLifecycle(msgs, asOf))));
  }
});

test('the dashboard render rule shows the same current alerts as CAST on CAST\'s cases', () => {
  const at = new Date('2026-07-17T13:00:00Z');
  for (const [name, make] of Object.entries(CASES)) {
    const castCurrent = castLifecycle.resolveAlertLifecycle(make()).events
      .filter((/** @type {any} */ e) => e.lifecycleState === 'active' && e.current)
      .map((/** @type {any} */ e) => e.current.alertId).sort();
    const ours = resolveLifecycle(make(), at).current.map((a) => a.alertId).sort();
    assert.deepEqual(ours, castCurrent, name);
  }
});
