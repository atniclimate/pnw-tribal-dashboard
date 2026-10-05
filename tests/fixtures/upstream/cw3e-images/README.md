# CW3E Fixtures

Probe bundles are real HTTP HEAD results (see the notes in each sidecar).

## Derived: `2026-10-05-head-probe-ivt-uswc-one-missing-hour.json`

- **Parent:** `2026-10-05-head-probe-ivt-uswc.json`.
- **Edit:** the result for the GFS_25 U.S. West Coast IVT image at cycle 2026100500, forecast hour 84, is set to status 404 (no Last-Modified, no size, text/html). Nothing else changes.
- **Why:** no live cycle had a single missing hour at capture time, and the resolver must prefer the older complete cycle (2026100418) over a newer incomplete one.
- **Follow-up:** replace it with a real capture if CW3E publishes a cycle with a gap.
