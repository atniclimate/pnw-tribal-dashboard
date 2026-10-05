// @ts-check
/**
 * Reference builder 40: Nation boundaries (blueprint 6.2 and 12.3, lane L5, WAVE 2).
 *
 * STUB. Wave 1 pins the boundary inputs (data/registry/inputs.yaml: bia-lar, census-aiannh-2025,
 * nrcan-aboriginal-lands-bc) and records the identifier crosswalk (data/registry/crosswalk-us.json and
 * crosswalk-bc.json), so every Nation already carries the LARID, AIANNHCE, GEOID, and ALCODE keys that this
 * builder will use. It writes nothing and says so (exit code zero, so the reference chain continues; 90-validate reports the pending join).
 *
 * Wave 2 contract (blueprint 4.2 and 6.2): BIA LAR first (`outSR=4326`); Census AIANNH only where LAR has no
 * polygon and only the legal classes (MTFCC G2101 reservations, GEOID suffix R, and G2102 off-reservation trust
 * land, GEOID suffix T); statistical areas (G2120 and higher) stay out
 * while `boundary_policy.census_statistical_areas` is false; BC reserves come from the NRCan polygons joined
 * through the ISC reserve relation (crosswalk-bc.json); every feature carries source, id, and vintage; outputs
 * `site/data/geo/boundaries-overview.topo.json` (at most 600 KB) and `site/data/geo/boundaries/<id>.json`
 * (at most 15 MB in all); `samples` are interior points that fall inside the land areas.
 */
console.log('40-boundaries: SKIPPED (wave 2 stub). Crosswalk identifiers are ready; boundary processing is not built yet.');
