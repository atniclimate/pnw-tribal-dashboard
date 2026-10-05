// @ts-check
/**
 * Pending acceptance for lane L11 (blueprint 12.3). Each item is skipped by its lane tag until the lane
 * delivers; the lane replaces these placeholders with real tests in its own test paths and deletes this
 * file. Owner: lane L11.
 */
import { test } from 'node:test';

const TAG = 'lane:L11 pending';
const ITEMS = [
  "filters use registry fields and round-trip through URL state",
  "cards show description and What to Do verbatim with zone-correct times and the Francais toggle",
  "Show on Map focuses the alert",
  "one disaster with 30 county rows renders once with 30 areas",
  "Tribal requests flagged; no active inferred",
  "curated status computed per 5.7",
  "BC candidate sections hidden while the flag is off",
  "tsunami notices pinned",
];

for (const item of ITEMS) test(`L11: ${item}`, { skip: TAG }, () => {});
