# Production readiness status — beta / release candidate (NOT production-ready)

**Verdict: beta/RC.** This release is a substantial implementation on the Vercel + D1 + KV + Workers stack, but it is **not production-ready** until the live gates in the table below pass. Do not onboard paying customers or store sensitive business mail until they do.

## What the code now includes vs what still needs live verification

| Area | Included in the code | Verification still required (live gate) |
|---|---|---|
| Database | D1 schema (`db/schema.sql`) + seed (`db/seed.sql`) for workspaces, domains, mailboxes, messages, provider state, audit events | Apply schema + seed to the live D1 database and confirm clean execution |
| Auth + MFA | Google OAuth (authorization-code flow) + D1 sessions (opaque httpOnly cookie) + TOTP MFA (RFC 6238, `lib/mfa.ts`) | Live login, session expiry/revocation, TOTP enrolment and recovery-code test |
| Tenant isolation | `requireUser()` guard on all user routes (`lib/guards.ts`); membership checks in every route; application-code enforcement (no database-level row security) | Two-tenant isolation test: two unrelated tenants, malicious/forged workspace and mailbox IDs, cross-mailbox reads — see `tests/tenant-isolation.sql` |
| User suspension | Platform user control API + DB state (`/api/admin/users`) | Enforce the guard on every API/page; verify suspended sessions are denied |
| Workspace control | Suspend/reinstate API (`/api/admin/workspaces/{id}`) | Confirm all operations deny a suspended workspace; test background jobs |
| Plan editor | Platform-admin plan catalog API + audit history (`/api/admin/plans`) | UI, plan migration/proration and billing compatibility |
| Billing / subscription / invoices | Subscription/invoice ledger and verified manual payment event endpoint (`/api/billing`, `/api/admin/payments`) | **Payment gateway: manual ledger only.** No real gateway, no signed payment webhooks, no refunds, no tax invoices, no dunning — a gateway integration is still required before taking money |
| Attachments | Private KV attachment upload/download endpoints, metadata, size/type allow-list (25 MB max value) | Authenticated upload/download test with owner, writer, reader and unrelated tenant; malware scanning still missing |
| Automated backups | D1 export + KV export scripts (`scripts/backup.sh`), age-encrypted, stored as GitHub Actions artifacts (90-day retention); restore drill script (`scripts/restore-drill.sh`) | Configure GitHub secrets, test upload, encryption/retention, and run the restore drill against a staging D1 |
| Monitoring / alerts | Health endpoint (`/api/health`), scheduled monitor workflow (`.github/workflows/monitor.yml`), webhook alert | Configure the external monitor, error tracking, logs and on-call workflow |
| DKIM selector validation | DNS TXT lookup for specified selectors (`/api/domains/dns`) | Correct provider selectors and DNS propagation on `flow99.in` must be confirmed |
| Automated DNS management | Cloudflare record creation API (`PUT /api/domains/dns`) | Zone-scoped credentials, review, idempotent update/delete and real domain tests on `flow99.in` |
| Build / integration / load / isolation | Scripts and test starters (`npm run test:security`, `tests/tenant-isolation.sql`, `tests/load.k6.js`) | Run `npm ci` / typecheck / build, full integration tests, load test and the complete isolation matrix |
| Penetration / security audit | Smoke test scripts and audit schema | Independent penetration test is not performed by generating source code — it has not been run |
| HTML sanitizer | — | **Not included.** No HTML sanitizer for message rendering yet |
| Malware scan | — | **Not included.** No malware scanning for inbound or uploaded attachments yet |

## Build/test execution status
Build verification is run by the coordinator after the route rewrite — see `AUDIT-REPORT.md`. No live D1 apply, two-tenant isolation test, independent pentest, production backup restore, load test, DKIM/DNS verification on `flow99.in`, or payment-gateway integration has been executed. Do not represent any of these as passed.
