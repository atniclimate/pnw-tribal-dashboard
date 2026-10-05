# Cascadia Tribal Hazard Dashboard

Weather, flood, and hazard information for Tribal Nations and First Nations across Cascadia: Washington, Oregon, Idaho, British Columbia, northern California, western Montana, northern Nevada, and Southeast Alaska. Built by ATNI Climate, Affiliated Tribes of Northwest Indians, for use on phones over poor connections.

**Live site:** https://atniclimate.github.io/pnw-tribal-dashboard/

## Status

The live site serves the May 2026 dashboard (`index.html`). The rebuilt multi-page dashboard is in development under `site/` and replaces it at launch. Pages under `site/` are incomplete and are not indexed by search engines until launch.

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

At launch, every page also has its own snippet (with `?embed=1` for a view without site navigation) on the dashboard's Embed page.

## Repository

| Path | Contents |
|---|---|
| `index.html` | The May 2026 dashboard, live until launch |
| `site/` | The new dashboard: HTML pages, scripts, styles, and fonts |
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
```

## Data

Every panel names its source and an "as of" time. Boundaries and headquarters points come from public federal and national sources and are representations, not jurisdiction. See `DATA.md`.

## License and Credit

Copyright 2026 ATNI Climate, Affiliated Tribes of Northwest Indians. All rights reserved; see `LICENSE`. Lead developer: Patrick A. Freeland. To cite this work, see `CITATION.cff`.

This dashboard succeeds IndigenousACCESS.org, built during the December 2025 atmospheric river events.
