# Data Sources

Every source the dashboard uses, who publishes it, and its terms. Each source also has a machine-readable record in `data/sources/` with its owner, terms, attribution, and the date it was last verified; those records are authoritative. Sources marked "pending" stay hidden until their terms are confirmed.

## Tribal Nation and First Nation Information

Boundary lines, headquarters points, and names come from public federal and national sources. They are representations, not jurisdiction, and are not a Tribal Nation's own statement of its land or authority. A Nation may request a correction or removal through the contact listed on the dashboard's Usage page.

## Government Data

| Publisher | Data | Terms |
|---|---|---|
| NOAA National Weather Service | Alerts, forecasts, gridpoint data, zones, radar images, Area Forecast Discussions | U.S. public domain; acknowledge the NWS; do not imply endorsement or present modified content as official |
| NOAA National Water Prediction Service | Gauges, flood categories, hydrograph images, observed and forecast stage/flow series | U.S. public domain |
| NOAA Weather Prediction Center | Precipitation and Excessive Rainfall images | U.S. public domain |
| NOAA NESDIS Center for Satellite Applications and Research | GOES-18 imagery | U.S. public domain |
| National Tsunami Warning Center | Tsunami products | U.S. public domain |
| Federal Emergency Management Agency | OpenFEMA disaster declarations | U.S. public domain; OpenFEMA terms of use |
| Bureau of Indian Affairs | Land Area Representations, Tribal Leaders Directory (office fields only, no personal names), Alaska Native Villages | U.S. public domain; BIA no-warranty and illustrative-only disclaimer |
| U.S. Census Bureau | TIGER/Line AIANNH (legal land areas only, to fill gaps), cartographic boundaries | U.S. public domain |
| Environment and Climate Change Canada | Weather alerts, city page forecasts, radar, hydrometric data, forecast zones | ECCC Data Servers End-use Licence v2.1; attribution required; alert content and intent must not be altered. Water Survey of Canada station history: Open Government Licence - Canada 2.0; provisional observations |
| Indigenous Services Canada | First Nation locations and relation files | Open Government Licence, Canada |
| Natural Resources Canada | Aboriginal Lands (AL_TA) for British Columbia | Open Government Licence, Canada 2.0 |
| Province of British Columbia | EMCR evacuation orders and alerts, EMCR region boundaries; River Forecast Centre advisories and EMBC tsunami notifications (pending written confirmation) | Open Government Licence - British Columbia: "Contains information licensed under the Open Government Licence – British Columbia."; no Provincial endorsement implied |

## Other Data and Imagery

| Publisher | Data | Terms |
|---|---|---|
| CARTO and OpenStreetMap contributors | Dark Matter basemap tiles | Map data ODbL 1.0, "© OpenStreetMap contributors © CARTO"; CARTO free non-commercial tier with an ATNI key |
| Iowa Environmental Mesonet, Iowa State University | NEXRAD mosaic tiles | Public domain; credit appreciated: "Radar: NOAA NWS via Iowa Environmental Mesonet" |
| Center for Western Weather and Water Extremes, Scripps Institution of Oceanography, UC San Diego | Atmospheric river forecasts (link only) | Provided for research and not for operational decisions; linked, never embedded |
| Space Science and Engineering Center, University of Wisconsin-Madison | MIMIC-TPW2 animation (link only) | Copyright reserved, experimental product; linked, never embedded |
| News publishers | Headlines and short summaries on the News page | Each publisher's terms; titles and links only, with short plain-text summaries |

## Fonts and Libraries

The decorative Dashboard photograph, [Low clouds over Lake Chelan](https://npgallery.nps.gov/AssetDetail/5c249b3d1a6a4c609f5a29682cc178ce), is a public-domain NPS Staff image dated June 24, 2013, courtesy of North Cascades National Park Service Complex. Its attribution and file hash ship beside the image. It is archival scenery, not current conditions or a representation of the selected Nation's land.

League Spartan, Roboto, and Noto Sans are licensed under the SIL Open Font License 1.1; the license texts ship beside the font files in `site/static/fonts/`. MapLibre GL JS 6.12.0 (BSD-3-Clause) and topojson-client 3.1.0 (ISC) are vendored with their license files under `site/static/vendor/`.

## Test Captures

Files under `tests/fixtures/upstream/` are dated captures of the public sources above, kept for tests only and never deployed. Files under `tests/fixtures/cast/` are copied from the ATNI-CAST repository and keep its terms.
