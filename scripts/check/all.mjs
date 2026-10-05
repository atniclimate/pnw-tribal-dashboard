// @ts-check
/**
 * `npm run check`: runs every static check of blueprint 10.1 that exists, in a fixed order, and lists the
 * ones whose owning lane has not delivered them yet. A present check that fails fails the run; a pending
 * check is reported by name and owner, never silently passed. Owner: lane L0.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { ROOT } from './lib/pages.mjs';

/** @type {{ name: string, file: string, args?: string[], owner: string }[]} */
const CHECKS = [
  { name: 'check:chrome', file: 'chrome.mjs', owner: 'L0' },
  { name: 'check:preload', file: 'modulepreload.mjs', owner: 'L0' },
  { name: 'check:csp', file: 'csp.mjs', args: ['--check'], owner: 'L15' },
  { name: 'check:vendor', file: 'vendor-integrity.mjs', owner: 'L8' },
  { name: 'check:tokens', file: 'tokens.mjs', owner: 'L1' },
  { name: 'check:contrast', file: 'contrast.mjs', owner: 'L1' },
  { name: 'check:fonts', file: 'fonts-coverage.mjs', owner: 'L1' },
  { name: 'check:copy', file: 'copy.mjs', owner: 'L15' },
  { name: 'check:panels', file: 'panels.mjs', owner: 'L15' },
  { name: 'check:no-fabrication', file: 'no-fabrication.mjs', owner: 'L15' },
  { name: 'check:budgets', file: 'budgets.mjs', owner: 'L15' },
];

let failed = 0;
/** @type {string[]} */
const pending = [];
for (const c of CHECKS) {
  const file = path.join(ROOT, 'scripts', 'check', c.file);
  if (!existsSync(file)) { pending.push(`${c.name} (lane ${c.owner})`); continue; }
  const r = spawnSync(process.execPath, [file, ...(c.args ?? [])], { cwd: ROOT, stdio: 'inherit' });
  if (r.status !== 0) { failed += 1; console.error(`${c.name} FAILED`); }
}
if (pending.length) console.log(`check: not yet delivered: ${pending.join(', ')}`);
if (failed) { console.error(`check: ${failed} check(s) failed`); process.exit(1); }
console.log(`check: ${CHECKS.length - pending.length} present check(s) passed`);
