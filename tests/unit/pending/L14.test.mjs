// @ts-check
/**
 * Pending acceptance for lane L14 (blueprint 12.3). Each item is skipped by its lane tag until the lane
 * delivers; the lane replaces these placeholders with real tests in its own test paths and deletes this
 * file. Owner: lane L14.
 */
import { test } from 'node:test';

const TAG = 'lane:L14 pending';
const ITEMS = [
  "feeds with DOCTYPE or ENTITY are rejected",
  "summaries are plain text",
  "non-https links dropped or upgraded only when the https URL answers",
  "per-source status shown; latest-first default",
  "search never loses focus",
  "YouTube items are text links; Reddit only as labeled links",
  "no proxy string anywhere in the repo",
  "archive page makes zero live requests",
  "embed generator output equals the EMBEDDING.md table",
];

for (const item of ITEMS) test(`L14: ${item}`, { skip: TAG }, () => {});
