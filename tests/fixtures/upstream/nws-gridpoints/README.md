# NWS Gridpoint Fixtures

`2026-10-05-sew-lummi-hq.json` is a real capture of `forecastGridData` (`/gridpoints/SEW/127,126`) for the Lummi Tribe of the Lummi Reservation headquarters point, captured 10/05/2026 06:25 UTC.

## Derived: `2026-10-05-sew-lummi-hq-shifted-27-days-dst.json`

- **Parent:** `2026-10-05-sew-lummi-hq.json`.
- **Edit:** every timestamp of the form `YYYY-MM-DDTHH:MM:SS+00:00` (the start of each `validTime` interval, `updateTime`, `validTimes`, and `generatedAt`) was shifted forward by exactly 27 days (648 hours), so the series runs from 10/31/2026 into November and spans the 11/01/2026 09:00 UTC end of daylight saving time in `America/Los_Angeles`. ISO 8601 durations, values, units, and geometry are unchanged.
- **Why:** a live gridpoint covers about seven days, so no real capture can span 11/01/2026 until about 10/25/2026. The QPF aggregator's zoned day bucketing must be tested across the transition (blueprint 3.14).
- **Follow-up:** capture a real gridpoint after 10/25/2026 that spans the transition, and retire this derived file.
