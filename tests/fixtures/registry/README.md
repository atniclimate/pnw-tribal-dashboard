# Five-Nation Registry Fixture

A real, minimal registry for tests and local development until lane L5 commits the full registry (blueprint 12.1). It is never deployed, and every record is `review.status: draft`.

| Region | Id | Name (as published by the source) | Source of name and headquarters | Boundary | Time zone (tz-lookup) |
|---|---|---|---|---|---|
| Washington | `us-wa-lummi-tribe-of-the-lummi-reservation` | Lummi Tribe of the Lummi Reservation | BIA Tribal Leaders Directory, OBJECTID 359 | BIA LAR `LAR0069` | America/Los_Angeles |
| Oregon | `us-or-confederated-tribes-of-siletz-indians-of-oregon` | Confederated Tribes of Siletz Indians of Oregon | BIA Tribal Leaders Directory, OBJECTID 343 | BIA LAR `LAR0083` | America/Los_Angeles |
| Idaho | `us-id-shoshone-bannock-tribes-of-the-fort-hall-reservation` | Shoshone-Bannock Tribes of the Fort Hall Reservation | BIA Tribal Leaders Directory, OBJECTID 374 | BIA LAR `LAR0061` | America/Boise |
| Southeast Alaska | `us-ak-organized-village-of-kasaan` | Organized Village of Kasaan | BIA Alaska Native Villages, OBJECTID 173 | none published (point only) | America/Sitka |
| British Columbia | `ca-fn-602` | ?aqam | ISC First Nations location file, band 602; tribal council from the ISC relation file | NRCan Aboriginal Lands (AL_TA BC), six reserves joined through the ISC reserve relation | America/Edmonton |

## Sources and Dates

- BIA Tribal Leaders Directory (Hub GeoJSON export, item modified 09/29/2026; export Last-Modified 10/02/2026), BIA Alaska Native Villages, and BIA Land Area Representations: downloaded 10/04/2026. Only the allowlisted Tribal Leaders Directory fields of blueprint 5.2 were read; no person field is read or written.
- ISC First Nation location, tribal council relation, and reserve relation CSVs (open.canada.ca metadata 04/14/2026; zip members dated 10/04/2026): downloaded 10/04/2026.
- NRCan AL_TA BC shapefile (Last-Modified 09/14/2026): downloaded 10/04/2026. Each reserve part carries the feature's own `REVDATE` as its vintage.
- NWS `/points` captures for the four U.S. headquarters (`tests/fixtures/upstream/nws-points/`, 10/05/2026) supply `nws.wfo`, the forecast, county, and fire zone typed keys, and the radar station.
- The ECCC city page capture (`tests/fixtures/upstream/eccc-citypage-realtime/2026-10-05-bc-cranbrook.json`) supplies the British Columbia Nation's city page site and distance.

## Deliberate Gaps (Filled by Lanes L4, L5, L6, and L7)

- `samples` holds the headquarters point only; interior land-area points come from L5's joins.
- `nws.marineZones`, `eccc.forecastZones`, `gauges`, and `contactIds` are empty; L4, L5, L6, and L7 fill them.
- `preferredName` and `website` are null: no Nation-published name or website was verified for this fixture.
- The British Columbia name carries the ISC `?` placeholder (the Nation's own orthography begins with a glottal stop). The record is flagged `name-orthography-needs-nation-source` and cannot be marked reviewed until `names.yaml` supplies the Nation's published name. It is also flagged `tz-needs-confirmation` (East Kootenay, Q15).
- Boundary coordinates are rounded to five decimals (about one metre).

## Rebuilding

```powershell
node scripts/dev/registry-fixture.mjs --raw <folder of the pinned 10/04/2026 downloads>
```
