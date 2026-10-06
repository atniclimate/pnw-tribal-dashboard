// @ts-check
/**
 * Zero references to the decommissioned USGS legacy waterservices host (blueprint 12.3, L7). NWPS and
 * api.waterdata.usgs.gov are the sanctioned sources. Owner: lane L7.
 *
 * Scope: every shipped or build file in the repository except site/classic/ (the preserved legacy page,
 * retired at Gate V), the root index.html (the legacy dashboard that Gate V replaces), node_modules, and
 * test result folders. This file and fixtures are excluded because they must name the host to forbid it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const SKIP_DIRS = new Set(['node_modules', '.git', '.cache', 'test-results', 'playwright-report', 'classic', 'fixtures', 'docs', 'reports', '_site']);
const TEXT = /\.(m?js|json|ya?ml|html|css|md|cff|csv|txt)$/;
const HOST = ['waterservices', 'usgs', 'gov'].join('.');

/** @param {string} dir @param {string[]} out */
function walk(dir, out) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walk(path.join(dir, e.name), out); } else if (TEXT.test(e.name)) out.push(path.join(dir, e.name));
  }
  return out;
}

test('zero references to the decommissioned USGS waterservices host', () => {
  const self = fileURLToPath(import.meta.url);
  const hits = walk(ROOT, [])
    .filter((f) => f !== self && path.relative(ROOT, f) !== 'index.html')
    .filter((f) => readFileSync(f, 'utf8').includes(HOST))
    .map((f) => path.relative(ROOT, f));
  assert.deepEqual(hits, []);
});

test('the hydrology sources name only NWPS, ECCC, and the new USGS host', () => {
  const dir = path.join(ROOT, 'data', 'sources');
  for (const n of readdirSync(dir).filter((x) => /^(nwps|eccc-hydrometric)-.*\.yaml$/.test(x))) {
    const text = readFileSync(path.join(dir, n), 'utf8');
    for (const m of text.matchAll(/https?:\/\/([^/\s'"]+)/g)) {
      assert.ok(['api.water.noaa.gov', 'water.noaa.gov', 'api.weather.gc.ca', 'wateroffice.ec.gc.ca', 'atniclimate.github.io', 'api.waterdata.usgs.gov'].includes(String(m[1])), `${n}: unexpected host ${String(m[1])}`);
    }
  }
});
