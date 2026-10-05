# Oregon Public Broadcasting Feed Fixtures

`2026-10-05-rss.xml` is a real capture of the Oregon Public Broadcasting RSS feed (`https://www.opb.org/arc/outboundfeeds/rss/?outputType=xml`), 10/05/2026 06:25 UTC. Its items carry HTML in `content:encoded`, which the news task must reduce to plain text.

## Derived: `2026-10-05-rss-javascript-link.xml`

- **Parent:** `2026-10-05-rss.xml`.
- **Edit:** the `<link>` element of the first `<item>` was replaced with `<link>javascript:alert(1)</link>`. Every other byte is unchanged.
- **Why:** no live feed carries a `javascript:` link. The news task must drop any link that is not https (blueprint 5.8).
