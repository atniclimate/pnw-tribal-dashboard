// @ts-check
/**
 * Pending acceptance for lane L7 (blueprint 12.3). Each item is skipped by its lane tag until the lane
 * delivers; the lane replaces these placeholders with real tests in its own test paths and deletes this
 * file. Owner: lane L7.
 */
import { test } from 'node:test';

const TAG = 'lane:L7 pending';
const ITEMS = [
  "legacy-stages test explains every difference from the May table; CRNW1 carries the 50.7 ft action stage",
  "every invalid or wrong LID replaced",
  "the dashboard displays the NWPS category",
  "null thresholds yield not_defined, never normal",
  "observations older than six hours read Observation not current",
  "a 0 ft reading is not missing; sentinels never display",
  "zero references to waterservices.usgs.gov",
  "WSC stations carry no invented categories",
  "gauges-status.json at most 80 KB gzip",
  "hydrograph image has alt text with latest and crest values and a text table",
];

for (const item of ITEMS) test(`L7: ${item}`, { skip: TAG }, () => {});
