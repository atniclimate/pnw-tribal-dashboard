// @ts-check
/**
 * Pending acceptance for lane L10 (blueprint 12.3). Each item is skipped by its lane tag until the lane
 * delivers; the lane replaces these placeholders with real tests in its own test paths and deletes this
 * file. Owner: lane L10.
 */
import { test } from 'node:test';

const TAG = 'lane:L10 pending';
const ITEMS = [
  "Constrained and Storm timing targets",
  "e2e scenarios 1 to 7 on the Dashboard",
  "picker passes APG combobox behavior tests and the phone sheet",
  "footprint and Nation modes for WA, ID, BC, and Southeast Alaska Nations",
  "every panel= value renders alone",
  "the root URL framed without parameters renders chrome-less",
  "banner copy matches 3.8 for every state in a fixture matrix",
];

for (const item of ITEMS) test(`L10: ${item}`, { skip: TAG }, () => {});
