// @ts-check
/**
 * Pending acceptance for lane L1 (blueprint 12.3). Each item is skipped by its lane tag until the lane
 * delivers; the lane replaces these placeholders with real tests in its own test paths and deletes this
 * file. Owner: lane L1.
 */
import { test } from 'node:test';

const TAG = 'lane:L1 pending';
const ITEMS = [
  "token and contrast checks pass, including the Severe ink correction and the extreme keyline",
  "fonts coverage passes on the 60-name fixture of hard U.S. and BC names",
  "latin woff2 total at most 90 KB",
  "gallery shows every component in every state at 360 and 1280 px with no horizontal scroll and axe clean",
  "reduced motion honored",
  "embed mode hides chrome and keeps provenance, including framed without a parameter",
  "embed.js at most 1 KB gzip and ignores other origins and non-matching sources",
  "no raw hex outside tokens.css",
  "CSS within budget",
];

for (const item of ITEMS) test(`L1: ${item}`, { skip: TAG }, () => {});
