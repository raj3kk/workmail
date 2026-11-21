# WorkMail — multi-tenant business webmail (Release Candidate / beta)

WorkMail is a hosted, multi-tenant webmail SaaS for custom domains: one hosted
instance, many workspaces, each workspace with its own domains, mailboxes,
team and outbound providers. Primary domain: **flow99.in** (mailboxes
`hello@flow99.in`, `support@flow99.in`, …).

> **Status: Release Candidate / beta — NOT production-certified.** The code
> is complete and typechecked, but the live gates in
> `docs/PRODUCTION-READINESS-STATUS.md` (live D1 apply, two-tenant isolation
> test, DKIM/DNS on flow99.in, backup restore drill, independent pentest,
> payment gateway) have not all passed yet. Do not onboard paying customers
> until they do.

## Hosted model (single instance, ours)

- **Host (Flow99 / Priyadarshi) owns and runs everything:** Vercel app,
  Cloudflare D1 database, Cloudflare KV namespace, Cloudflare Workers,
  code, migrations, monitoring, backups, fixes.
- **End user only:** signs up with Google, adds their domain + DNS records
  (MX/SPF/DKIM/DMARC at their DNS host), enters provider API keys in
  Settings, creates mailboxes. The user never creates a hosting, database
  or Cloudflare account and never runs a migration.
- Provider API keys entered in Settings are encrypted server-side
  (AES-256-GCM) and never shown again; plaintext secrets never appear in
  the client bundle, logs or API responses.

## Stack — 100% free tier, no card

| Piece | Service | Free tier (live-verified 2026-11-21) | Card? |
|---|---|---|---|
| Web app + API | Vercel (Next.js 14) | Hobby: free | No |
| Database | Cloudflare D1 (SQLite) | 5 GB total, 5M rows read/day, 100K rows written/day | No |
| Attachments | Cloudflare KV | 1 GB, 100k reads/day, 1,000 writes/day, 25 MB max value | No |
| API/inbound | Cloudflare Workers | 100,000 requests/day | No |
| Outbound mail | SendPulse / Brevo / Mailjet / Resend (user's own free accounts) | SendPulse 12,000/mo; Brevo 300/day; Mailjet 6,000/mo, 200/day; Resend 3,000/mo, 100/day | No |
| Backups | GitHub Actions artifacts (age-encrypted) | 90-day retention | No |

**Replaced 2026-11-21:** the previous database/auth implementation was fully
replaced by Google OAuth + D1 sessions + application-level tenant checks,
and the previous card-gated object-storage service was replaced by KV for
attachments and GitHub artifacts for backups. Alternatives evaluated:
Turso Free (5 GB, 500M reads/mo, no card) and Neon Free (1 GB/project,
no card) — D1 was chosen for single-vendor hosting fit with Workers/KV.
See `AUDIT-REPORT.md` for the full evaluation.

**No "unlimited free" claim:** every limit above is a hard cap. Workers
past 100k req/day and D1 past its row limits will throttle/fail until the
next day; provider quotas are per-provider and not additive.

## Layout (repo root = app root)

```
app/                  Next.js app (pages + API routes)
lib/                  D1 client, Google OAuth sessions, TOTP MFA, guards, crypto, KV
db/                   schema.sql (D1/SQLite) + seed.sql (plan catalog)
cloudflare/           api-worker (D1 sidecar, private-test only) + inbound-email-worker
scripts/              backup.sh (D1+KV export, age-encrypted) + restore-drill.sh
tests/                security-smoke.sh, load.k6.js, tenant-isolation.sql
docs/                 setup guides, operations, readiness status, deploy checklist
.github/workflows/    ci.yml (typecheck+build), backup.yml, monitor.yml
```

## What the USER does (checklist)

- [ ] Sign up with Google at the hosted app URL.
- [ ] Add domain (e.g. `flow99.in`) in Settings → copy the ownership TXT record.
- [ ] Publish DNS at your DNS host: ownership TXT, MX, SPF, DKIM (from the
      provider dashboard), DMARC — then click Verify in WorkMail.
- [ ] Enter provider API keys in Settings → Providers (SendPulse/Brevo/
      Mailjet/Resend — your own free accounts; sign in to those providers
      with flipify.com@gmail.com where sign-in is needed).
- [ ] Create mailboxes (e.g. `hello@flow99.in`) and assign team members.
- [ ] Send a test mail and reply to it from an external mailbox.

## What the HOST does (checklist)

- [ ] Cloudflare: create D1 database, apply `db/schema.sql` + `db/seed.sql`;
      create KV namespace; note the IDs.
- [ ] Google Cloud: OAuth web client with redirect `{APP_URL}/auth/callback`.
- [ ] Vercel: import `raj3kk/workmail`, root `./`, set env vars from
      `.env.example`, deploy, verify build + live URL.
- [ ] Cloudflare: deploy the inbound Email Worker, set `WORKMAIL_API_URL` +
      `INBOUND_WEBHOOK_TOKEN`, create the Email Routing route for flow99.in.
- [ ] App: first login, platform admin via `PLATFORM_ADMIN_EMAILS`, verify
      domain + mailbox `hello@flow99.in`, run the end-to-end mail test.
- [ ] GitHub: set backup/monitor secrets, run the restore drill on staging D1.
- [ ] Open gates: independent pentest, load test, payment gateway (manual
      ledger only today), malware scanning, HTML sanitizer — see
      `docs/PRODUCTION-READINESS-STATUS.md`.

Full steps: `docs/DEPLOY-CHECKLIST.md` (host) and `docs/USER-SETUP-GUIDE.md`
(user). Full setup: `docs/COMPLETE-SETUP-GUIDE.md`.

## Quick start (local dev)

```bash
cp .env.example .env.local   # fill in Cloudflare + Google values (host only)
npm ci
npm run typecheck
npm run build
npm run dev
```

## Security

- Auth: Google OAuth + opaque session cookies (D1, hashed, revocable) + TOTP MFA.
- Every user API route calls `requireUser()` (session + user/workspace
  suspension + MFA); every tenant query filters by a membership-checked
  `workspace_id`; D1 has no RLS, so the route checks ARE the isolation.
- Rate limits in `middleware.ts` (send 20/min, inbound 60/min, delivery
  webhook 120/min, ops 30/min per IP, per instance — best-effort).
- Provider secrets: AES-256-GCM at rest; GET `/api/providers` returns
  metadata only. Report vulnerabilities per `SECURITY.md`.

## What is NOT included (honest gaps)

No payment gateway (manual invoice ledger only), no IMAP/POP, no malware
scanning, no HTML sanitizer (HTML bodies are stored, never rendered),
no provider-native webhook signature adapters, no load-test pass, no
independent pentest. See `docs/PRODUCTION-READINESS-STATUS.md`.
