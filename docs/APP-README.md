# WorkMail — app README (D1 + KV)

This repository is a deployable **beta / release-candidate implementation**, not a certified production email host. It includes a Next.js App Router UI, Google OAuth + D1 sessions + TOTP MFA, application-code tenant isolation, inbox listing/reading, compose/send API, provider failover adapters (SendPulse → Brevo → Mailjet → Resend), domain registration endpoint and authenticated inbound webhook.

## Removed by design
No browser agent, computer-use agent, Playwright/Chromium automation, automatic provider account signup, CAPTCHA/OTP automation, or automated billing.

## Stack
- Next.js 14 + TypeScript (Vercel, one project, root directory `./`)
- Cloudflare D1 (SQLite) — workspaces, domains, mailboxes, messages, memberships, provider state, audit events
- Cloudflare KV — attachments (25 MB max value)
- Google OAuth (authorization-code flow) + D1 sessions (opaque httpOnly cookie) + TOTP MFA (RFC 6238)
- Cloudflare Email Routing / Email Worker (inbound transport, PostalMime)
- Provider APIs (outbound): SendPulse → Brevo → Mailjet → Resend
- Tenant isolation is enforced in application code (`lib/guards.ts` — membership checks in every route). There is no database-level row security.

## Layout
The repo root **is** the app root. There is no nested app folder to push separately.

| Path | What it is |
|---|---|
| `app/` | Next.js App Router UI + API routes |
| `lib/` | Auth, D1 client (`lib/db.ts`), KV client (`lib/kv.ts`), guards (`lib/guards.ts`), MFA (`lib/mfa.ts`), crypto |
| `db/schema.sql` | Canonical D1 schema (ONE file) |
| `db/seed.sql` | Seed data |
| `cloudflare/inbound-email-worker/` | Inbound Email Worker (PostalMime) |
| `scripts/` | `backup.sh`, `restore-drill.sh` (D1 + KV exports) |
| `tests/` | `security-smoke.sh`, `tenant-isolation.sql`, `load.k6.js` |
| `.env.example` | Full host env var list (template only, no live values) |
| `docs/` | All guides (this file's siblings) |

## 1. Configure environment
Copy the root `.env.example` to `.env.local` for local development. The full host env var list lives there — see it, do not duplicate it here. The variables are: `NEXT_PUBLIC_APP_URL`, `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_D1_DATABASE_ID`, `CLOUDFLARE_KV_NAMESPACE_ID`, `CLOUDFLARE_API_TOKEN`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `PROVIDER_CREDENTIAL_ENCRYPTION_KEY`, `INBOUND_WEBHOOK_TOKEN`, `DELIVERY_WEBHOOK_TOKEN`, `OPS_CRON_TOKEN`, `PLATFORM_ADMIN_EMAILS`, `MFA_ENFORCEMENT`.

Notes:
- `PROVIDER_CREDENTIAL_ENCRYPTION_KEY` is a 32-byte base64 key; generate with `openssl rand -base64 32` and back it up securely — losing it makes stored provider credentials unrecoverable.
- Env vars belong to the host (deployer), not to end users. Never commit `.env.local`.
- Per-workspace provider credentials are stored AES-256-GCM encrypted using `PROVIDER_CREDENTIAL_ENCRYPTION_KEY`. This is application-level encryption, not a managed KMS/HSM. Rotate keys only with a migration/re-encryption plan.

## 2. Create the D1 database and apply the schema
```bash
npx wrangler d1 create workmail
npx wrangler d1 execute workmail --remote --file=db/schema.sql
npx wrangler d1 execute workmail --remote --file=db/seed.sql
```
For local development, use `npx wrangler d1 execute workmail --local --file=db/schema.sql` (and `--file=db/seed.sql`).

Create the KV namespace for attachments:
```bash
npx wrangler kv namespace create workmail_attachments
```

## 3. Run locally
```bash
npm ci
cp .env.example .env.local
npm run dev
```
Open http://localhost:3000. Google login needs a working Google OAuth client with `http://localhost:3000/auth/callback` as an authorized redirect URI.

## 4. Push to GitHub and deploy to Vercel
1. Create a new GitHub repository (for example `raj3kk/workmail`).
2. Push the whole repository (repo root is the app root).
3. Import the repository in https://vercel.com/new.
4. Framework preset: Next.js. Root Directory: `./`.
5. Add the host environment variables in Vercel → Project → Settings → Environment Variables. Never commit `.env.local`.
6. Deploy. Add the Vercel production URL to the Google OAuth client's authorized redirect URIs (`{APP_URL}/auth/callback`), then redeploy if needed.

## 5. First mailbox setup
1. Sign in with Google using an email listed in `PLATFORM_ADMIN_EMAILS`. The first login creates a workspace and owner membership.
2. Open Settings and add your domain (`flow99.in`).
3. Configure the domain's DNS manually at your DNS host. Add MX, SPF, DKIM and DMARC records exactly as shown by your selected inbound/outbound providers. Do not create multiple SPF TXT records at the root.
4. Verify sender/domain in each provider dashboard.
5. In Settings → Providers, enter each provider's API key. Provider keys are per-workspace in Settings — they are **not** global environment variables.
6. In Settings → Mailboxes, create the mailbox (for example `hello@flow99.in`) via the UI. Do not create mailboxes with raw SQL.
7. Assign mailbox access to team members. A workspace membership alone does not grant message access.
8. Test sending only to an address you control. Check provider delivery logs and DNS authentication.

## 6. Inbound email
The `/api/inbound` endpoint accepts normalized message JSON and requires `X-Inbound-Token: INBOUND_WEBHOOK_TOKEN`. It maps the recipient email address to an active mailbox on the server; callers cannot supply workspace or mailbox IDs. The Cloudflare Email Worker parses MIME with PostalMime and forwards the recipient and message. Configure `WORKMAIL_API_URL` and `INBOUND_WEBHOOK_TOKEN` as Worker variable/secret. The worker still needs a real Cloudflare Email Routing destination and end-to-end delivery test.

## 7. Security hardening and admin setup
1. Set `PROVIDER_CREDENTIAL_ENCRYPTION_KEY` to a securely generated 32-byte base64 key. Never commit it. Back it up in a secure secret manager.
2. Platform admin is granted only to email addresses listed in `PLATFORM_ADMIN_EMAILS`. Open `/admin` for platform metrics. This route is deny-by-default.
3. In Settings, add a domain, publish the displayed `_workmail-verification` TXT record, then verify it. Add the MX, SPF and DMARC records required by your chosen providers. DKIM records must be copied from each provider dashboard. DNS verification is not a substitute for provider-side sender verification.
4. Connect a provider from Settings. After you verify the sender/domain in that provider's own dashboard, use the explicit confirmation control. This is an admin attestation, not an API-side provider verification.
5. Every user route enforces `requireUser()` from `lib/guards.ts`, including suspension and MFA checks. Audit any route that does not use it before public launch.

## 8. Cloudflare inbound worker
From `cloudflare/inbound-email-worker`, install dependencies and deploy with Wrangler. Configure `WORKMAIL_API_URL` as a Worker variable and `INBOUND_WEBHOOK_TOKEN` as a Worker secret. Configure the Cloudflare Email Routing rule to deliver to this Worker. Test with an external sender and verify the message appears only in the intended mailbox.

## Important limitations before production
- This build is a beta/RC foundation, not an end-to-end production mailbox platform.
- No IMAP/POP support; Cloudflare Email Routing is transport, not a hosted mailbox.
- No malware scanning for attachments; no HTML sanitizer for message rendering.
- No complete MIME attachment extraction on inbound mail, threading engine, contacts/labels UI, spam filtering, provider-native webhook signature adapters, export/retention controls or backup restore verification beyond the drill script.
- Inbound worker → mailbox mapping and token verification must be completed and tested.
- Outbound fallback is sequential. Network timeouts can have ambiguous delivery outcomes; implement idempotency/reconciliation before retrying production mail to prevent duplicates.
- Admin/member invitation, billing (manual ledger only, no payment gateway), rate limits, anti-abuse, quotas, audit UI, observability, data export and disaster recovery are not complete.
- Run dependency/security scans, tenant-isolation tests, provider sandbox tests, deliverability checks, load tests and restore drills before real customer data.

No system can guarantee uninterrupted delivery or unlimited free email. Provider limits, sender verification, domain reputation, Cloudflare quotas and Vercel plan limits apply.
