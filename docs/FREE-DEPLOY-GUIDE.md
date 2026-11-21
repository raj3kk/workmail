# Free-tier deployment guide (no card)

WorkMail runs on free tiers only. **No card is required for any part of this stack.** Free does not mean unlimited — every layer below has hard limits, and exceeding them pauses or rejects traffic instead of billing you.

## The stack

| Layer | Service | What it does |
|---|---|---|
| Web UI + API | Vercel (Next.js 14) | One project, root directory `./` (repo root is the app root) |
| Database | Cloudflare D1 | Workspaces, domains, mailboxes, messages, provider state, audit events |
| Attachments | Cloudflare KV | Message attachments, 25 MB max value |
| Inbound mail | Cloudflare Email Routing → Email Worker | PostalMime normalization → Vercel `/api/inbound` |
| Auth | Google OAuth + D1 sessions + TOTP MFA | No paid auth service |
| Outbound mail | User-owned provider accounts | SendPulse / Brevo / Mailjet / Resend, keys entered per workspace in Settings |
| Backups | GitHub Actions artifacts | D1 export + KV export, age-encrypted, 90-day retention |

## Free-tier limits

| Service | Free limit |
|---|---|
| Cloudflare Workers | 100,000 requests/day |
| Cloudflare D1 | 5 GB total storage; 5,000,000 rows read/day; 100,000 rows written/day; 10 databases |
| Cloudflare KV | 1 GB storage; 100,000 reads/day; 1,000 writes/day; 25 MB max value |
| SendPulse | 12,000 messages/month |
| Brevo | 300 sends/day |
| Mailjet | 6,000 messages/month; 200/day |
| Resend | 3,000 messages/month; 100/day |

Limits are per the providers' published free plans as of November 2026 and can change. Always check the live plan pages before launch. Provider quotas are not additive guarantees — the router only uses providers that are configured, sender-verified and quota-eligible.

## Deploy steps (host)

1. Create the D1 database and apply the schema: `npx wrangler d1 create workmail`, then `npx wrangler d1 execute workmail --remote --file=db/schema.sql` and `--file=db/seed.sql`.
2. Create the KV namespace: `npx wrangler kv namespace create workmail_attachments`.
3. Deploy the inbound Email Worker from `cloudflare/inbound-email-worker/` (install its `postal-mime` dependency first) and set its `WORKMAIL_API_URL` variable and `INBOUND_WEBHOOK_TOKEN` secret. Connect it to the Cloudflare Email Routing rule for the domain.
4. Import the repo in Vercel (Framework: Next.js, Root Directory: `./`) and set the host env vars listed in the root `.env.example`. Provider API keys are **not** env vars — each workspace enters its own keys in Settings, encrypted server-side.
5. Add exact SPF/DKIM/DMARC records from each provider dashboard. Keep one SPF record at the root.
6. Test with a mailbox you control before production: inbound from an external address, outbound to an external address, and a provider-failure fallback check.

## What "free" does not cover

- **Domain registration/renewal** costs money; a domain is not free because hosting is.
- **Outbound email beyond the quotas above** — provider free quotas are conditional on account eligibility, sender verification and acceptable-use policy.
- **Attachment scanning, spam filtering, bounce handling beyond the built-in ledger, retention controls and production-grade security review** still need implementation or verification — see `PRODUCTION-READINESS-STATUS.md`.
- **Backups beyond 90-day artifact retention** — export and archive older backups yourself if you need longer retention.
- **Support/SLA** — there is none on any of these free tiers.

Object storage is not part of this stack: the card-gated object-storage service is not used, precisely because enabling it requires a card/PayPal on file. Attachments live in KV instead.
