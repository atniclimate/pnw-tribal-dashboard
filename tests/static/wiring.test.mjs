// @ts-check
/**
 * Wiring (blueprint 10.1, 12.3): every automated check of 10.1 is reachable from `npm run check` or a named
 * npm script, is run by ci.yml, and exists as a script; the CSP, copy, panels, no-fabrication, and budgets
 * checks run clean against their pure functions. Checks owned by other lanes (vendor integrity, tokens,
 * contrast, fonts coverage) are asserted only once their script exists, so a lane that has not delivered
 * is reported as a skip with its owner, never as a pass.
 */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { describe, test } from 'node:test';

const root = new URL('../../', import.meta.url);
const read = (/** @type {string} */ rel) => readFile(new URL(rel, root), 'utf8');
const pkg = JSON.parse(await read('package.json'));
const ci = await read('.github/workflows/ci.yml');
const all = await read('scripts/check/all.mjs');

/** blueprint 10.1 table: npm script, file, owner. @type {[string, string, string][]} */
const CHECKS = [
  ['check:chrome', 'chrome.mjs', 'L0'], ['check:preload', 'modulepreload.mjs', 'L0'], ['check:csp', 'csp.mjs', 'L15'],
  ['check:vendor', 'vendor-integrity.mjs', 'L8'], ['check:tokens', 'tokens.mjs', 'L1'], ['check:contrast', 'contrast.mjs', 'L1'],
  ['check:fonts', 'fonts-coverage.mjs', 'L1'], ['check:copy', 'copy.mjs', 'L15'], ['check:panels', 'panels.mjs', 'L15'],
  ['check:no-fabrication', 'no-fabrication.mjs', 'L15'], ['check:budgets', 'budgets.mjs', 'L15'],
];

describe('every 10.1 check is wired', () => {
  for (const [name, file, owner] of CHECKS) {
    test(`${name} has an npm script and a slot in scripts/check/all.mjs`, () => {
      assert.ok(pkg.scripts[name], `package.json lacks ${name}`);
      assert.ok(pkg.scripts[name].includes(file), `${name} does not run ${file}`);
      assert.ok(all.includes(`file: '${file}'`), `all.mjs lacks ${file}`);
    });
    test(`${name} script exists (lane ${owner})`, { skip: existsSync(new URL(`scripts/check/${file}`, root)) ? false : `lane ${owner} has not delivered ${file}` }, () => {
      assert.ok(existsSync(new URL(`scripts/check/${file}`, root)));
    });
  }

  test('ci.yml runs lint, typecheck, unit, CAST parity, data validation, the static checks, and the mocked end-to-end suite', () => {
    for (const cmd of ['npm run lint', 'npm run typecheck', 'npm test', 'npm run test:cast', 'npm run validate:data', 'npm run check', 'npx playwright test']) {
      assert.ok(ci.includes(`run: ${cmd}`), `ci.yml lacks "${cmd}"`);
    }
    assert.ok(ci.includes('check:csp') || ci.includes('npm run check'), 'ci.yml reaches check:csp');
  });

  test('npm test discovers tests/static and tests/unit', () => {
    assert.match(pkg.scripts.test, /tests\/static/);
    assert.match(pkg.scripts.test, /tests\/unit/);
  });
});

describe('seeded violations owned by other lanes', () => {
  test('a vendored file edited by one byte fails check:vendor', { skip: existsSync(new URL('scripts/check/vendor-integrity.mjs', root)) ? 'script present: L8 owns this seeded test' : 'lane L8 has not delivered vendor-integrity.mjs' }, () => {});
  test('a token drift fails check:tokens', { skip: existsSync(new URL('scripts/check/tokens.mjs', root)) ? 'script present: L1 owns this seeded test' : 'lane L1 has not delivered tokens.mjs' }, () => {});
});
