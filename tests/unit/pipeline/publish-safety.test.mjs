import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { publishSafety } from '../../../scripts/lib/publish-safety.mjs';

test('release retains official topic resources while withholding unreviewed Safety guidance', async () => {
  const source = await readFile(new URL('../../../site/safety/index.html', import.meta.url), 'utf8');
  const result = publishSafety(source);
  assert.match(result, /data-review-status="official-links"/);
  assert.doesNotMatch(result, /<h3>Before<\/h3>|data-kit-item|twelve inches can carry/);
  assert.equal([...result.matchAll(/class="safety-section"/g)].length, 10);
  assert.match(result, /https:\/\/www.ready.gov\/floods/);
  assert.match(result, /data-panel="safety-active"/);
  assert.match(result, /data-call/);
  assert.match(result, /id="rain-landslide"/);
});

test('reviewed Safety pages are left intact', () => {
  const html = '<main data-review-status="reviewed">Approved guidance</main>';
  assert.equal(publishSafety(html), html);
});

test('unknown draft structure stops publication rather than leaking unreviewed advice', () => {
  assert.throws(() => publishSafety('<p data-review-status="draft">Draft</p>'), /Expected ten/);
});
