// @ts-check
/**
 * Pending acceptance for lane L9 (blueprint 12.3). Wave 1 items (snapshot runner, carry-forward, due logic,
 * assemble, deploy.yml gating, actionlint) are real tests in tests/unit/snapshot/ and tests/unit/assemble/.
 * What remains belongs to Wave 3 or to a maintainer action; the lane deletes this file when they land.
 * Owner: lane L9.
 */
import { test } from 'node:test';

const TAG = 'lane:L9 pending';
const ITEMS = [
  'Wave 3: the service worker never registers inside an iframe and honors the kill switch',
  'Wave 3: versioned assets cache-first, HTML and live data network-first (e2e scenario 9)',
  'Wave 3: a page loaded before a code deploy still lazy-imports from the retained generation (e2e scenario 13)',
  'Wave 3: offline.html content and manifest.webmanifest',
  'Wave 3: assemble writes the service worker precache list',
  'maintainer: a push to main runs no deploy job (needs a push approval)',
  'maintainer: reference refresh opens a pull request on a dispatch dry run (needs the reference builders)',
  'Gate V: Pages switched to GitHub Actions, CTHD_PAGES_ACTIONS created, first production deploy succeeds',
];

for (const item of ITEMS) test(`L9: ${item}`, { skip: TAG }, () => {});
