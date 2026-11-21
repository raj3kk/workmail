# WorkMail production operations and release gates

This package implements administrative control APIs, TOTP MFA enforcement, configurable plans, manual payment ledger, DKIM DNS validation, optional Cloudflare DNS record creation, health/alert endpoints, and D1 + KV backup/restore automation. It is **not a production certification** — it is a beta/RC.

## Apply the D1 schema
Apply `db/schema.sql`, then `db/seed.sql`, to the D1 database with Wrangler:
```bash
npx wrangler d1 execute workmail --remote --file=db/schema.sql
npx wrangler d1 execute workmail --remote --file=db/seed.sql
```
Test each in staging first, with a rollback plan (re-export the D1 database before applying). The platform admin allowlist is `PLATFORM_ADMIN_EMAILS` — a host env var, populated out-of-band by the host. There is no numbered migration series; the D1 schema is one file.

## User and workspace suspension
Platform admin APIs:
- `GET/PATCH /api/admin/users` with `{user_id,suspended,reason,mfa_required}`
- `PATCH /api/admin/workspaces/{id}` with `{suspended,reason}`

Suspension is enforced by `requireUser()` (in `lib/guards.ts`) on routes that adopt that guard. Audit every other route and add the same guard before public launch. Suspension does not erase data. Tenant isolation is enforced in application code — there is no database-level row security to fall back on, so the guard audit is mandatory.

## Plans, billing and payment
- `GET/POST /api/admin/plans`: platform-admin plan catalog editor. Prices are integer minor currency units (INR paise).
- `GET/POST /api/admin/payments`: payment event ledger. Only an administrator-verified `payment_succeeded` event activates the related subscription. **No real payment gateway is bundled** — this is a manual ledger only. Configure and verify a gateway webhook before taking money. Never trust browser payment claims.
- Subscription cancellation, refunds, tax invoices, payment-provider signatures, proration and dunning need a chosen payment gateway and legal/tax configuration.

## MFA (TOTP)
`requireUser()` checks TOTP MFA (RFC 6238, any authenticator app, `lib/mfa.ts`) when a user's `mfa_required` flag is enabled. Enroll administrators, test recovery codes and session refresh. The guard must be applied to every sensitive route; audit routes not using it. `MFA_ENFORCEMENT=true` enforces MFA platform-wide. Do not rely on the UI alone.

## Backups and restore
Backups are D1 export + KV export, age-encrypted, stored as GitHub Actions artifacts with 90-day retention. No object storage is used.

Add these GitHub repository secrets: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_D1_DATABASE_ID`, `CLOUDFLARE_KV_NAMESPACE_ID`, `AGE_RECIPIENT` (age public key). The workflow encrypts the exports with age before upload. Keep the matching age private key offline and test decryption. The backup workflow runs daily (`npm run backup` / `bash scripts/backup.sh`). Run the restore drill monthly against a disposable staging D1 database (`npm run restore:drill` / `bash scripts/restore-drill.sh`). Store backup checksums and verify restore success; a D1 export alone does not back up KV objects — both exports must be verified.

## Monitoring and alerting
Set `OPS_CRON_TOKEN` and optional `ALERT_WEBHOOK_URL`. Set GitHub secrets `WORKMAIL_APP_URL` and `OPS_CRON_TOKEN`; the monitor workflow (`.github/workflows/monitor.yml`) polls every 10 minutes. For real production observability, add an external uptime monitor, error tracker (e.g. Sentry), log retention, paging policy and alert ownership. Do not expose the cron token.

## DNS and DKIM
`POST /api/domains/dns` accepts `domain_id` and optional `dkim_selectors`; it checks TXT, MX, SPF, DMARC and DKIM selector TXT records using Google Public DNS-over-HTTPS. DKIM cannot be guessed: pass selectors published by the actual sending provider. `PUT /api/domains/dns` creates TXT/MX/CNAME records through Cloudflare when `CLOUDFLARE_API_TOKEN` and the zone ID are configured. Use a zone-scoped token with DNS edit permission. Review record values before sending requests. DNS creation is not automatic provider DKIM provisioning and does not guarantee propagation/deliverability.

## Test commands
- `npm ci && npm run typecheck && npm run build`
- `npm run test:security` (`bash tests/security-smoke.sh`) with `BASE_URL` pointing to staging
- Execute `tests/tenant-isolation.sql` using two seeded tenants and distinct authenticated sessions; extend to SELECT/INSERT/UPDATE/DELETE for every tenant-owned table (application-code guards — there is no database-level row security)
- `npm run test:load` (`k6 run -e BASE_URL=https://staging.flow99.in tests/load.k6.js`)
- `npm run restore:drill` against a disposable staging D1 — never production
- Run OWASP ZAP / Burp authenticated DAST, dependency audit, secret scan, SAST and independent penetration test. Fix all critical/high findings.

## Non-negotiable release gates
1. Apply the D1 schema in staging and production with a rollback plan.
2. Confirm every route enforces authentication, MFA and suspension; no server-only secret in browser bundles.
3. Complete two-tenant isolation tests for all tables and KV objects.
4. Verify provider webhook signatures, payment webhook signatures (when a gateway exists), replay protection and idempotency.
5. Complete malware scanning for inbound attachments, abuse controls and deliverability tests.
6. Complete backup restore drill including KV objects, not just the D1 export.
7. Complete load test at expected peak, alert runbook, incident response, privacy/terms and legal review.

A successful build or static test does not prove production readiness. Do not onboard real customer mailboxes until all release gates are signed off.

## Outbound retry policy (G-23)

`/api/send` writes one `outbound_jobs` row per send (payload + provider +
status). `POST /api/ops/reconcile` (Bearer `OPS_CRON_TOKEN`) consumes due
rows on every tick via `lib/retry.ts` `processDueOutboundJobs()`:

- **Retried:** only `queued`/`retry` rows whose `next_attempt_at` has
  passed. Each attempt re-runs the shared send pipeline (`executeSend`),
  so domain verification, monthly cap, suppression and per-provider caps
  are re-checked, and a fresh idempotency key (`retry:<job-id>:<n>`) is
  used — the original key is already marked `failed`, and a `failed`
  outcome means no provider accepted the mail, so the retry cannot
  duplicate a delivery.
- **Backoff:** 1m, 5m, 15m, 30m, 60m between attempts; **max 5 attempts**,
  then the job is `failed` (terminal).
- **`unknown` is NEVER auto-retried.** A provider timeout means the mail
  may already have been delivered; retrying could duplicate it. `unknown`
  rows are flagged by reconcile for manual/provider-log reconciliation
  only. The same rule applies to a retry attempt that itself times out.
- **`failed` is terminal:** suppression, definitive rejection, bad
  payload, suspended workspace, or attempts exhausted. A `failed` job is
  never retried automatically.
- **Claiming:** jobs are claimed with `locked_at` before work starts so
  two concurrent reconcile ticks cannot retry the same job. A job stuck
  in `processing` for >15 minutes is flagged `unknown` by reconcile.
- **Audit:** every transition updates `attempts`, `next_attempt_at`,
  `last_error`, `provider` and `message_id` on the job row. The
  idempotency key remains the source of truth for the send outcome.
