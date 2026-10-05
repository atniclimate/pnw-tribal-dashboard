# Alert replay fixtures

Fixtures in this directory are parser/replay inputs, not authoritative live alerts.
Every file carries `_fixture.synthetic` and provenance notes.

`nws-zone-update.live-sanitized.json` and
`eccc-bilingual.live-sanitized.json` are minimized from the captured corpus files
named in their metadata. Long public safety text and most geometry/geocodes were
omitted, while identifiers and mapping-relevant values were retained.

The two `.synthetic.json` files remain useful for a complete NWS update/cancel chain
and counterfactual ECCC precedence values not present in this capture. Validate the
synthetic chain against a live cancellation, and validate ECCC impact/colour values
beyond the captured moderate/yellow pair before treating those cases as conformance
fixtures.
