// @ts-check
/**
 * Pending acceptance for lane L15 (blueprint 12.3), Wave 3 items only. The Wave 1 items (checks wired and
 * seeded violations, check:csp map directives, check:budgets map rows) are real tests in tests/static/.
 * Each item here is skipped by its lane tag until Wave 3 delivers; the lane replaces these placeholders and
 * deletes this file. Owner: lane L15.
 */
import { test } from 'node:test';

const TAG = 'lane:L15 pending (Wave 3)';
const ITEMS = [
  "CAST export passes validateSourceRecord; DDM fragment parses",
  "health probe opens and closes issues in dry-run mode and detects a disabled deploy.yml",
  "every section 11 document complete in house style (public set reduced to README.md and DATA.md by the lean ruling)",
  "motion, a11y, and verify specs cover the interactive map and outline mode",
];

for (const item of ITEMS) test(`L15: ${item}`, { skip: TAG }, () => {});
