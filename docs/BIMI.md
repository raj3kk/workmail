# BIMI — Brand Indicators for Message Identification (flow99.in)

## What BIMI is

BIMI lets a mailbox provider display the sender's brand logo next to
authenticated emails in the inbox. It works on top of DMARC: a domain
publishes a DNS TXT record at `default._bimi.<domain>` pointing at a
hosted SVG logo. Mailbox providers that support BIMI fetch that record,
verify DMARC alignment, and show the logo.

## Prerequisites (already in place)

- DMARC for flow99.in is at enforcement: `p=quarantine` (BIMI requires
  at least `p=quarantine` or `p=reject`).
- SPF and DKIM are published and aligned for flow99.in mail.
- The logo is hosted by WorkMail itself at
  `https://workmail-delta.vercel.app/bimi-logo.svg` — no third-party
  hosting, no VMC purchased.

## The published record

| Field | Value |
|---|---|
| Name | `default._bimi.flow99.in` |
| Type | TXT |
| TTL | 3600 |
| Content | `v=BIMI1; l=https://workmail-delta.vercel.app/bimi-logo.svg; a=;` |

The `a=` tag is empty: no Verified Mark Certificate (VMC) is attached.
That is deliberate — this is the free, VMC-free part of BIMI only.

## The logo

`public/bimi-logo.svg` — Flow99 mark, BIMI-compliant:

- SVG Tiny 1.2 profile (`version="1.2" baseProfile="tiny"`)
- Square canvas: `viewBox="0 0 512 512"`
- No `<script>`, no external references, no animations, standalone valid XML
- Design: the official Flow99 lockup (2026-11-22) — black "Flow" text
  plus interlocking tricolor "99" ribbons (saffron / silver-white /
  green), drawn as flat vector shapes (BIMI forbids raster images, so
  the glass-ribbon render is a flat-vector rendition). White
  background, readable at 32px. Replaces the old navy "99" mark, which
  the owner retired as the wrong logo.

## How to check it

Public DNS (no login needed):

```
https://dns.google/resolve?name=default._bimi.flow99.in&type=TXT
```

The answer should contain:

```
"v=BIMI1; l=https://workmail-delta.vercel.app/bimi-logo.svg; a=;"
```

Logo URL (live after the next deploy):

```
https://workmail-delta.vercel.app/bimi-logo.svg
```

It must return the SVG with `Content-Type: image/svg+xml` (or
`text/xml`-family). If the record is not visible in the DoH answer yet,
it is still propagating — wait and re-check; do not claim it verified
until the DoH answer shows it.

BIMI record validators (e.g. the BIMI Group's lookup tool) can also be
used to confirm the record parses and the logo fetches.

## Honesty section — what this does and does NOT do

**Gmail displays a BIMI logo ONLY with a paid VMC (Verified Mark
Certificate, ~$1,000/year) PLUS a registered trademark — without a VMC,
Gmail will NOT show the logo.** This setup has no VMC and no trademark
filing, so Gmail will not display the Flow99 logo from this record.
Do not claim otherwise to anyone.

**Apple Mail, Yahoo Mail and Fastmail can display BIMI without a VMC.**
For those providers, this free record is enough (provided DMARC stays
at enforcement and the logo stays reachable).

This setup is the free, VMC-free part of BIMI only. Buying a VMC (and
registering a trademark first) is a separate, paid decision for the
owner — roughly $1,000/year — and is NOT part of this work.

## Gravatar note

**Gmail does not use Gravatar for sender logos — Gravatar is NOT a
replacement for BIMI.** Setting a Gravatar for the sending address does
not make Gmail show a brand logo. The only Gmail path to a displayed
brand logo is BIMI with a VMC (see above).

## Maintenance

- If the logo file changes, keep the URL identical
  (`/bimi-logo.svg`) — the DNS record points at that URL.
- If the hosting domain changes, update the `l=` value in the DNS
  record to the new logo URL.
- If DMARC is ever relaxed below `p=quarantine`, BIMI stops working
  everywhere — do not relax it.
- If a VMC is ever bought, add its URL to the `a=` tag
  (`a=https://<vmc-url>;`) and update this doc.
