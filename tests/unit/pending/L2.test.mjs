// @ts-check
/**
 * Pending acceptance for lane L2 (blueprint 12.3). Each item is skipped by its lane tag until the lane
 * delivers; the lane replaces these placeholders with real tests in its own test paths and deletes this
 * file. Owner: lane L2.
 */
import { test } from 'node:test';

const TAG = 'lane:L2 pending';
const ITEMS = [
  "fetchJson never throws for network outcomes and never resolves ok on a non-OK status",
  "retries only on network, timeout, 502, 503, and 504",
  "Retry-After honored and capped at 30 s",
  "the limiter serves priority 0 before 3 under contention",
  "dedupe and TTL work",
  "every deriveStatus row has a test",
  "validateSnapshot passes CAST cases plus the two added rules",
  "h() rejects on* and drops unsafe href",
  "safeUrl blocks javascript:, data:, and vbscript:",
  "URL state round-trips and preserves unknown keys and embed",
  "formatAsOf returns 10/04/2026 3:15 PM PDT",
  "zoned day keys correct across both DST transitions in seven zones",
  "zero versus sentinel units",
  "mountPanel always renders a provenance footer",
  "line coverage at least 90 percent for net, status, time, and units",
];

for (const item of ITEMS) test(`L2: ${item}`, { skip: TAG }, () => {});
