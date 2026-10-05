# NWS Zone Fixtures

Captured 10/05/2026 06:23 to 06:24 UTC.

## Fire and Public Zones Sharing a Code

Zone listings from `api.weather.gov/zones?type=fire` and `?type=forecast` on 10/05/2026 showed that fire-weather and public forecast zone codes **never coincide in Washington (39 fire zones, 68 public), Oregon (43, 56), Idaho (20, 47), Montana (32, 83), Nevada (20, 26), or Wyoming (43, 58)**, while **California shares 106 codes** between the two types (170 fire zones, 209 public). Codes alone are therefore ambiguous only in California, but typed keys are still required everywhere because the API, not the dashboard, defines the code spaces.

No fire-weather alert in California was active at capture, so the collision case pairs a real public-zone alert with both zone records for the same code:

- `../nws-alerts-active/2026-10-05-public-zone-code-shared-with-fire-zone.json`: a Heat Advisory naming `forecast:CAZ503`.
- `2026-10-05-forecast-caz503.json` and `2026-10-05-fire-caz503.json`: the public and fire-weather zones with code `CAZ503`, which describe different areas.

A relevance or geometry lookup keyed by `CAZ503` alone would draw or match the wrong area; keyed by `forecast:CAZ503` it cannot.

The fire-zone alert case is `../nws-alerts-active/2026-10-05-fire-zone-red-flag-warning.json` (a Red Flag Warning naming `fire:MTZ123` and `fire:MTZ124`) with `2026-10-05-fire-mtz123.json`; `zones/forecast/MTZ123` does not exist (HTTP 404).
