# ATNI-CAST Parity Fixtures

Byte-for-byte copies of ATNI-CAST source files and fixtures at the commit recorded in `UPSTREAM.json` (blueprint 10.1). They are inputs for `npm run test:cast`: the JavaScript ports in `site/static/js/core/status.js` and `site/static/js/alerts/*` must reproduce CAST's results on CAST's own cases (core-status validation cases; NWS and ECCC band, posture, and confidence mappings). Do not edit these files; refresh them by copying again from a newer CAST commit and updating `UPSTREAM.json`, which `tests/cast/upstream-hashes.test.mjs` checks.

Files whose names contain `synthetic` are CAST's own constructed test inputs, labeled as such by CAST; they are not dashboard data.
