# ATNI-CAST alert mappings

The exported tables are the audit record for normalization. A parser records the
table `name` and `version` in every alert's `provenance.mappingApplied`. Band,
posture, and confidence are independent dimensions. Product titles never supply an
impact band.

## NWS CAP (`atni-cast-nws-cap` 1.0.0)

| CAP field | Source value | ATNI-CAST value |
| --- | --- | --- |
| severity | Extreme | band `extreme` |
| severity | Severe | band `severe` |
| severity | Moderate | band `moderate` |
| severity | Minor | band `minor` |
| severity | Unknown, absent, or unrecognized | band `unstated` |
| urgency | Immediate | posture `act-now` |
| urgency | Expected or Future | posture `prepare` |
| urgency | Past | posture `ended` |
| urgency | Unknown, absent, or unrecognized | posture `monitor` |
| certainty | Observed | confidence `observed` |
| certainty | Likely | confidence `likely` |
| certainty | Possible | confidence `possible` |
| certainty | Unlikely, Unknown, absent, or unrecognized | confidence `unknown` |

For posture only, an active NWS event designation ending in `Emergency` or
`Warning` maps to `act-now`, `Watch` maps to `prepare`, and `Advisory` or
`Statement` maps to `monitor`. This supports legacy and emerging advisory forms.
An ended lifecycle overrides those rules with `ended`; otherwise the event rule
overrides the urgency fallback. The event designation never affects band.

## ECCC CAP (`atni-cast-eccc-cap` 1.0.0)

Band uses the first recognized value in this strict order:

1. `MSC_Impact`: Extreme -> `extreme`; High or Severe -> `severe`; Medium or
   Moderate -> `moderate`; Low or Minor -> `minor`.
2. `Colour`: Red -> `extreme`; Orange -> `severe`; Yellow -> `moderate`; Green ->
   `minor`.
3. Base CAP severity, using the NWS CAP severity rows above.

Unrecognized values fall through to the next field. If no field has a recognized
value, band is `unstated`. Titles such as "Orange Watch" are not parsed for band.
Urgency and certainty use the same CAP mappings as NWS. Posture may use the same
designation suffix rules, independently of band.

ECCC English and French `<info>` blocks are preserved separately under their BCP-47
keys, normally `en-CA` and `fr-CA`. The parser records ECCC as
`translationAuthority`; it must not synthesize a missing language block.
The table also recognizes the live-corpus French values `modéré` and `jaune` as
`moderate`; additional localized vocabulary remains subject to corpus validation.

## Lifecycle transitions

Messages are processed in arrival order and compared by the source CAP `sent`
instant. `alertId` is `agency:originalId`; it is never reused. CAP references alias
every update/cancel message to the original event identity. When the original has
fallen outside a replay window, the first namespaced CAP reference supplies the root
identity without fabricating the missing alert.

| Current state | Incoming message | Result |
| --- | --- | --- |
| none | alert | Create one `active` event identity. |
| active | newer update | Add a `superseded` tombstone for the prior current message; make the update current and `active`. |
| active | newer cancel | Add a `cancelled` tombstone for the prior current message; retain the cancellation as current with state `cancelled`. |
| cancelled or expired | newer agency message | Resolve to the same identity and apply its explicit newer lifecycle state; never reuse an alert ID. |
| active | `expires` at or before resolver `asOf` | Retain the current alert with state `expired`. |
| any | duplicate alert ID | Reject as `duplicate-id`. |
| any | message whose `sent` is equal to or older than current | Reject as `older-sent`; do not change current state or tombstones. |

Tombstones preserve identity and ordering metadata, not synthesized alert content.
Zone coverage is recorded as `geometryBasis: "zone"` with the source geocodes. A
resolved zone polygon is honest administrative coverage and must remain visually
distinct from source-supplied polygon precision.

## Event groups

An `AlertEventGroup` contains an ID, optional watershed, member alert IDs, and the
labeled highest member band with total member count. It is metadata only. Member
alerts retain their separate agencies, original designations, geometries, and
timestamps. `unstated` is ignored while finding a ranked maximum and is returned
only when every member is `unstated`; it is never ordered against ranked bands.
