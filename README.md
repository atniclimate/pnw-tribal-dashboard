# PNW Tribal Weather Dashboard

Live weather, hazard, and flood-monitoring dashboard for Pacific Northwest Tribal Nations. Single-file static site (HTML + CSS + JS), served via GitHub Pages.

**Live**: https://atniclimate.github.io/pnw-tribal-dashboard/

## Embedding on a Squarespace site

Drop the snippet below into a single Code Block. Tested on Squarespace 7.1 / Plus plan; works on any plan that allows iframes.

```html
<iframe
  src="https://atniclimate.github.io/pnw-tribal-dashboard/"
  title="PNW Tribal Weather Dashboard"
  style="width:100%;height:90vh;min-height:600px;border:0;display:block;"
  loading="lazy"
  allow="geolocation"
  referrerpolicy="strict-origin-when-cross-origin"
></iframe>
```

## What it shows

- **Active alerts** (NWS) for OR, WA, ID — auto-refreshed every minute, filterable by hazard category.
- **Interactive map** with three views: current radar, 3-day precipitation forecast, and river-gauge flooding status.
- **Tribal reservation boundaries** overlaid from a curated GeoJSON.
- **7-day forecast** for the selected Tribal community (NWS Points API).
- **QPF precipitation map** from NOAA NWRFC (Today / 3-Day / 7-Day).
- **Curated seasonal road closures** (winter passes only, displayed Nov-May).
- **Emergency contacts and resource links.**

The "Daily Breakdown" panel is labeled **SAMPLE** — those values are illustrative only until we wire up real NWS gridpoint QPF data.

## Data sources

- [NWS / weather.gov](https://www.weather.gov) — alerts, point forecasts
- [USGS Water Services](https://waterservices.usgs.gov) — real-time gauge heights
- [NOAA NWRFC](https://www.nwrfc.noaa.gov) — QPF maps
- [NOAA WPC](https://www.wpc.ncep.noaa.gov) — backup QPF imagery
- [Iowa Environmental Mesonet](https://mesonet.agron.iastate.edu) — radar and forecast tile layers
- [CARTO Basemaps](https://carto.com) — dark base tiles
- Tribal boundaries: BIA Federal Register 89 FR 944 (Jan 2024), simplified GeoJSON hosted at `atniclimate/maps`

## Local development

```powershell
# Open directly in a browser (everything is in one file)
Start-Process index.html

# Or serve over HTTP if you want fetch() to work the same as production
python -m http.server 8000
# then open http://localhost:8000/
```

## Deploy

Pushing to `main` automatically updates the Pages site. No build step.

## License

Code: MIT. Tribal boundary data: per BIA terms.
