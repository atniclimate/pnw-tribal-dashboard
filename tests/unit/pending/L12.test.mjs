// @ts-check
/**
 * Pending acceptance for lane L12 (blueprint 12.3). Each item is skipped by its lane tag until the lane
 * delivers; the lane replaces these placeholders with real tests in its own test paths and deletes this
 * file. Owner: lane L12.
 */
import { test } from 'node:test';

const TAG = 'lane:L12 pending';
const ITEMS = [
  "QPF passes May 2026 parity and Nation-zone DST tests",
  "14 periods labeled 7-Day; AFD collapsed",
  "BC city page forecast with distance",
  "WPC and ERO labels exact",
  "CW3E resolution chooses the newest complete cycle; browser fallback tested",
  "GOES 300 px still auto, 600 px on tap, MP4 on tap with Pause",
  "no image over 150 KB without a tap",
  "radar nearest station by haversine",
  "every image stamped",
];

for (const item of ITEMS) test(`L12: ${item}`, { skip: TAG }, () => {});
