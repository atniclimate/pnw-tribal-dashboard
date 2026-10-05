# ECCC GeoMet Weather Alert Fixtures

Captured 10/05/2026 06:25 UTC.

- `2026-10-05-bc-province-filter.json`: the registered British Columbia request (`filter=properties.province=BC&limit=500`). **No British Columbia alert was in effect at capture**, so the collection is empty (`numberMatched: 0`). This is the honest "BC quiet" case.
- `2026-10-05-canada-with-geometry.json`: every Canadian alert in effect (24: Quebec 19, Newfoundland and Labrador 3, Nova Scotia 1, Yukon 1), with polygons. These carry the English and French blocks (`alert_name_en`, `alert_name_fr`, `alert_text_en`, `alert_text_fr`, and the rest) that the bilingual cases need.
- `2026-10-05-canada-skip-geometry.json`: the same request with `skipGeometry=true` (`geometry: null`).
- `2026-10-05-canada-truncated-limit-5.json`: `limit=5`, so `numberMatched` (24) exceeds the five features returned and a `next` link is present.

**Follow-up:** capture a British Columbia alert with geometry when one is in effect (storm season), and add it here; the parser tests should then include a BC-specific golden output.
