import assert from 'node:assert/strict';
import { test } from 'node:test';
import { nationPatch, scopeKey, workspaceState } from '../../../site/static/js/pages/dashboard-state.js';
import { serializeQuery } from '../../../site/static/js/core/url-state.js';

test('location changes clear previous features and exact forecast period while retaining useful preferences', () => {
  const before = '?n=us-wa-old&j=bc&a=old-alert&g=nwps:OLD&day=2026-10-05&period=2026-10-05T06:00Z&units=metric&view=forecast&utm_source=shared';
  const after = serializeQuery(nationPatch('ca-fn-602'), before);
  const params = new URLSearchParams(after);
  assert.equal(params.get('n'), 'ca-fn-602');
  for (const key of ['j', 'a', 'g', 'day', 'period']) assert.equal(params.has(key), false);
  assert.equal(params.get('units'), 'metric');
  assert.equal(params.get('view'), 'forecast');
  assert.equal(params.get('utm_source'), 'shared');
});
test('browser history scope excludes chart, feature, and layer interactions', () => {
  const a = workspaceState('?n=ca-fn-602&view=overview');
  const b = workspaceState('?n=ca-fn-602&view=rivers&g=nwps:MVEW1&layers=outlines,radar&units=metric');
  assert.equal(scopeKey(a), scopeKey(b));
  assert.notEqual(scopeKey(a), scopeKey(workspaceState('?n=us-wa-lummi-tribe-of-the-lummi-reservation')));
  assert.notEqual(scopeKey(a), scopeKey(workspaceState('?j=bc')));
});
test('unsupported views and ranges resolve deliberately without invalid graph state', () => {
  const state = workspaceState('?view=ar&range=100&grange=never&gmetric=random&day=2026-10-05');
  assert.equal(state.view, 'overview');
  assert.equal(state.range, undefined); assert.equal(state.grange, undefined); assert.equal(state.gmetric, undefined);
  assert.equal(state.day, '2026-10-05');
});
