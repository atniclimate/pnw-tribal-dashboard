# NWS Active Alerts Fixtures

Captured 10/05/2026 06:23 to 06:24 UTC. See `../README.md` for the case index.

## Derived: `2026-10-05-topup-one-malformed-item.json`

- **Parent:** `2026-10-05-topup-wa-or-id-pz.json` (a real capture of `alerts/active?area=WA,OR,ID,PZ&status=actual`).
- **Edit:** the first feature's `properties.event` value `"Small Craft Advisory"` was replaced with `null` (the first occurrence of the `"event"` key in the file). Every other byte is unchanged.
- **Why:** no live collection contained a malformed item at capture time. The parser must show every valid alert, count the failed item, and mark the source degraded (blueprint 3.7.7).

## Notes

- `2026-10-05-test-messages.json` comes from `alerts?status=test`; the snapshot request uses `status=actual`, and the parser still excludes and counts any Test or Exercise message that slips through.
- The Update chain is a Southeast Alaska marine Small Craft Advisory (`PKZ` zones): `update-chain-current.json` references the messages in `update-chain-ref-1.json` and `update-chain-ref-2.json`.
