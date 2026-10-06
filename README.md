# Cascadia Tribal Hazard Dashboard

Weather, flood, and hazard information for Tribal Nations and First Nations across Cascadia: Washington, Oregon, Idaho, British Columbia, northern California, western Montana, northern Nevada, and Southeast Alaska. Built by ATNI Climate, Affiliated Tribes of Northwest Indians, for use on phones over poor connections.

**Live site:** https://atniclimate.github.io/pnw-tribal-dashboard/

## Status

The multi-page dashboard is published from `site/` by GitHub Actions. Deployments require passing CI for the exact source commit. Public agency snapshots refresh every ten minutes, with failed or stale sources identified on the page. The previous dashboard remains available at [Classic](https://atniclimate.github.io/pnw-tribal-dashboard/classic/).

Choose a Nation to view local alerts, forecasts, rivers, and verified contacts. Share the resulting URL to preserve that selection. Safety currently provides official agency resources; additional editorial guidance awaits review.

The current source revision adds an interactive map workspace with layer controls, selectable alerts and gauges, forecast plots, and river history charts. The map loads after alerts have painted; low-data mode keeps it on request. Local outlines remain available while a basemap key is unavailable. Charts support pointer and keyboard inspection and a data table. These changes remain unreleased until their exact commit passes CI and deploys.

## Embed on Squarespace

Paste this into a Squarespace Code Block:

```html
<iframe
  src="https://atniclimate.github.io/pnw-tribal-dashboard/"
  title="Cascadia Tribal Hazard Dashboard"
  style="width:100%;height:90vh;min-height:600px;border:0;display:block;"
  loading="lazy"
  allow="geolocation"
  referrerpolicy="strict-origin-when-cross-origin"
></iframe>
```

Every page has its own snippet (with `?embed=1` for a view without site navigation) on the [Embed page](https://atniclimate.github.io/pnw-tribal-dashboard/embed/).

## Repository

| Path | Contents |
|---|---|
| `site/` | The published dashboard: HTML pages, scripts, styles, and fonts |
| `site/classic/` | The previous dashboard, retained temporarily as a fallback |
| `schemas/` | JSON Schemas for every data file |
| `scripts/` | Data compile, snapshot, and check scripts |
| `tests/` | Unit and browser tests, with dated captures of the public sources |
| `DATA.md` | Every data source and its terms |

## Local Development

Requires Node.js 24 (see `.nvmrc`). In PowerShell:

```powershell
npm ci
npm run dev       # serves the new dashboard locally
npm run verify    # lint, typecheck, tests, data validation, and checks
npm run test:e2e  # browser checks; CI also includes WebKit
```

## Data

Every panel names its source and an "as of" time. Boundaries and headquarters points come from public federal and national sources and are representations, not jurisdiction. See `DATA.md`.

## License and Credit

Copyright 2026 ATNI Climate, Affiliated Tribes of Northwest Indians. All rights reserved; see `LICENSE`. Lead developer: Patrick A. Freeland. To cite this work, see `CITATION.cff`.

This dashboard succeeds IndigenousACCESS.org, built during the December 2025 atmospheric river events.
