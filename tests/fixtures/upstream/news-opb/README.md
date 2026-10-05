# Oregon Public Broadcasting Feed Fixtures

`2026-10-05-rss.xml` is a real capture of the Oregon Public Broadcasting RSS feed (`https://www.opb.org/arc/outboundfeeds/rss/?outputType=xml`), 10/05/2026 06:25 UTC. Its items carry HTML in `content:encoded`, which the news task must reduce to plain text.

## Derived: `2026-10-05-rss-javascript-link.xml`

- **Parent:** `2026-10-05-rss.xml`.
- **Edit:** the `<link>` element of the first `<item>` was replaced with `<link>javascript:alert(1)</link>`. Every other byte is unchanged.
- **Why:** no live feed carries a `javascript:` link. The news task must drop any link that is not https (blueprint 5.8).

## Derived: `2026-10-05-rss-doctype-entity.xml`

- **Parent:** `2026-10-05-rss.xml`.
- **Edits:** a DOCTYPE declaration with one internal ENTITY (`x`, value "expanded") was inserted after the XML declaration, and the first item's title now ends with `&x;`.
- **Why:** no live feed declares a DOCTYPE or ENTITY. The news task must reject the whole feed before parsing (blueprint 12.3, lane L14).

## Derived: `2026-10-05-rss-http-link.xml`

- **Parent:** `2026-10-05-rss.xml`.
- **Edit:** the first item's `<link>` begins with `http://` instead of `https://`. Every other byte is unchanged.
- **Why:** the live feed uses https links. The news task upgrades an http link only when the https address answers.

## Sibling Feed Captures (Lane L14, 10/05/2026)

Real captures of the other feeds the news task reads sit beside this folder: `news-kiro7`, `news-global-bc`, `news-cbc-bc`, `news-idaho-oem`, and `news-youtube-pnwwx`. The CBC capture was made with the shorter `pnw-tribal-dashboard/1.0` User-Agent because www.cbc.ca gave no response to the shared project header (see its sidecar).
