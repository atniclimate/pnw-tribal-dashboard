// @ts-check
/**
 * Pending acceptance for lane L15 (blueprint 12.3). Each item is skipped by its lane tag until the lane
 * delivers; the lane replaces these placeholders with real tests in its own test paths and deletes this
 * file. Owner: lane L15.
 */
import { test } from 'node:test';

const TAG = 'lane:L15 pending';
const ITEMS = [
  "every 10.1 check wired into ci.yml and green",
  "seeded violations fail (panel without provenance, map without the note, MapLibre import outside loader, flyTo or setHTML, blob: in a CSP, edited vendor byte, token drift, Math.random, em dash, unregistered host, lowercase tribal)",
  "check:csp emits worker-src self and tile hosts on map pages",
  "check:budgets measures both map rows",
  "CAST export passes validateSourceRecord; DDM fragment parses",
  "health probe opens and closes issues in dry-run mode",
  "every section 11 document complete in house style",
];

for (const item of ITEMS) test(`L15: ${item}`, { skip: TAG }, () => {});
