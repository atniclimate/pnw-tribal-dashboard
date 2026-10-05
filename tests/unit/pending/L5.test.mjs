// @ts-check
/**
 * Pending acceptance for lane L5 (blueprint 12.3). Wave 1 delivered the registry, ids, names, crosswalks, and
 * gates (tests/unit/registry/registry.test.mjs). What remains is wave 2 (boundaries and joins); each item is
 * skipped by its lane tag until the lane delivers, then replaced by a real test. Owner: lane L5.
 */
import { test } from 'node:test';

const TAG = 'lane:L5 pending';
const ITEMS = [
  'every boundary feature carries source, id, and vintage',
  'overview at most 600 KB raw; detail files at most 15 MB total',
  'samples fall inside land areas',
  'NWS zone keys or ECCC linkage on every record (needs L4 outputs)',
];

for (const item of ITEMS) test(`L5: ${item}`, { skip: TAG }, () => {});
