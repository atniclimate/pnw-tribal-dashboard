// @ts-check
/**
 * Pending acceptance for lane L9 (blueprint 12.3). Each item is skipped by its lane tag until the lane
 * delivers; the lane replaces these placeholders with real tests in its own test paths and deletes this
 * file. Owner: lane L9.
 */
import { test } from 'node:test';

const TAG = 'lane:L9 pending';
const ITEMS = [
  "dry run writes valid envelopes and a manifest with correct hashes, last",
  "a forced task failure carries forward with the original observedAt and still deploys",
  "with no previous copy the file is rejected and renders Unavailable",
  "due logic skips tasks not yet due",
  "assemble rewrites only HTML attribute paths, copies static to v/<sha12>/, and retains the previous generation",
  "the service worker never registers inside an iframe and honors the kill switch",
  "deploy jobs skip while CTHD_PAGES_ACTIONS is absent",
  "actionlint passes with SHA-pinned actions",
];

for (const item of ITEMS) test(`L9: ${item}`, { skip: TAG }, () => {});
