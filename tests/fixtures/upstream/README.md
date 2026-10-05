# Upstream Fixtures

Dated, real captures of the public sources the dashboard reads, for tests only (never deployed). Each capture is stored byte for byte as received, with a sidecar `<name>.meta.json` (schema `schemas/fixture-meta.schema.json`) that records the request URL and headers, the capture instant (`capturedAt`, UTC), the HTTP status, the size, and the SHA-256. File names start with the UTC date of the capture. `tests/unit/fixtures/upstream.test.mjs` verifies every hash.

All captures in this first set were made on 10/05/2026 between 06:23 and 06:26 UTC (10/04/2026, 11:23 PM to 11:26 PM PDT) with `scripts/dev/capture-fixture.mjs`.

## Derived Fixtures

When a live capture could not produce a required case, the fixture was made by a minimal, recorded edit of a real capture (`derivedFrom` and `edits` in its metadata), and the README.md in the same folder explains the edit. No payload was invented.

| Folder | Derived file | Why |
|---|---|---|
| `nws-alerts-active` | `2026-10-05-topup-one-malformed-item.json` | No live collection contained a malformed item |
| `nws-gridpoints` | `2026-10-05-sew-lummi-hq-shifted-27-days-dst.json` | No live gridpoint can span the 11/01/2026 transition until about 10/25/2026 |
| `news-opb` | `2026-10-05-rss-javascript-link.xml` | No live feed carries a `javascript:` link |

## Cases Covered (Blueprint 12.3, Lane L0)

| Case | Fixture |
|---|---|
| NWS footprint collection (the snapshot request of blueprint 3.7.3) | `nws-alerts-active/2026-10-05-footprint-active.json` (180 alerts) |
| Browser top-up request 1 | `nws-alerts-active/2026-10-05-topup-wa-or-id-pz.json` |
| Null-geometry zone alert | most items in the two collections above |
| Fire-zone alert | `nws-alerts-active/2026-10-05-fire-zone-red-flag-warning.json`, zone `nws-zones-api/2026-10-05-fire-mtz123.json` |
| Fire and public zones sharing a code | `nws-alerts-active/2026-10-05-public-zone-code-shared-with-fire-zone.json` with `nws-zones-api/2026-10-05-forecast-caz503.json` and `2026-10-05-fire-caz503.json` (see `nws-zones-api/README.md`) |
| Marine alerts | Southeast Alaska `PKZ` Small Craft Advisories in the footprint collection and the Update chain |
| Update chain | `nws-alerts-active/2026-10-05-update-chain-current.json` with `update-chain-ref-1.json` and `update-chain-ref-2.json` |
| Cancel messages and a paginated collection | `nws-alerts-active/2026-10-05-cancel-collection-page-1.json` (with `pagination.next`) and `page-2.json` |
| Test messages | `nws-alerts-active/2026-10-05-test-messages.json` (KEEPALIVE, CAP status Test) |
| Malformed item | `nws-alerts-active/2026-10-05-topup-one-malformed-item.json` (derived) |
| ECCC bilingual, with and without geometry, truncated | `eccc-geomet-weather-alerts/` (see its README.md: no British Columbia alert was in effect) |
| NTWC Atom | `ntwc-atom/2026-10-05-paaq-atom.xml` |
| BC River Forecast Centre | `bc-rfc-flood-advisories/` (every basin at No Advisory at capture) |
| EMCR evacuation orders and alerts | `bc-emcr-evacuations/2026-10-05-all-orders-alerts.json` (16 records) |
| NWPS gauge box and a gauge with null thresholds | `nwps-gauges/2026-10-05-bbox-skagit-nooksack.json`, `2026-10-05-gauge-hutw1-null-thresholds.json` |
| NWS gridpoint across a DST transition | `nws-gridpoints/2026-10-05-sew-lummi-hq-shifted-27-days-dst.json` (derived) and its real parent |
| ECCC city page | `eccc-citypage-realtime/2026-10-05-bc-cranbrook.json` |
| OpenFEMA multi-county rows | `openfema-declarations/2026-10-05-dr-4906-wa-multi-county.json` (49 rows); Tribal requests in `2026-10-05-tribal-requests-footprint-states.json` |
| RSS with HTML summaries and a `javascript:` link | `news-opb/2026-10-05-rss.xml` and the derived `2026-10-05-rss-javascript-link.xml` |
| NWS points and point forecast for registry fixture Nations | `nws-points/`, `nws-forecast/` |

## Adding a Fixture

```powershell
node scripts/dev/capture-fixture.mjs --source nws-alerts-active --label my-case --url "https://api.weather.gov/alerts/active?area=WA&status=actual" --accept application/geo+json
```
