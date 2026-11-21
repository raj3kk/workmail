# WorkMail Cloud — Multi-tenant Custom-Domain Webmail SaaS

**Revision:** Hosted-model edition (Vercel + D1 + KV + Workers) · 21 Nov 2026

## Product decision
WorkMail is a custom-domain webmail application. It has **no browser agent, no computer-use agent, no Playwright/Chromium automation, no browser session service, and no automated third-party account creation**. All onboarding is performed through documented user-facing steps and direct, supported provider APIs. The user remains in control of registrar changes, provider signup, account verification, and billing.

**Hosted model:** one hosted instance run by the host (Flow99 / Priyadarshi). The host owns Vercel, Cloudflare (D1/KV/Workers), code, migrations, monitoring and backups. The end user only signs up, adds their domain + DNS records, enters provider API keys and creates mailboxes. The end user never creates a Vercel or Cloudflare account and never runs a migration.

## Core user journey
1. User creates an account with Google sign-in; MFA (TOTP) is enabled before production use.
2. User adds a domain and proves ownership using a TXT record.
3. User publishes MX/SPF/DKIM/DMARC records at their DNS host (the host's DNS APIs are available for host-managed zones; manual DNS is supported).
4. Host's Cloudflare Email Routing + inbound Email Worker deliver inbound mail to WorkMail.
5. User creates accounts with supported outbound providers, creates API keys in each provider dashboard, and enters those keys in WorkMail's secure server-side settings page.
6. WorkMail displays exact provider-supplied SPF/DKIM/DMARC records. User adds them; DNS verification checks them.
7. User creates mailboxes, aliases and catch-all policy.
8. User sends a test message and receives an external test message. WorkMail activates the domain only after both paths pass.

## Architecture
- Web UI + API: Vercel (Next.js 14 + TypeScript). One project, root directory `./` (repo root is the app root). Responsive dashboard and mailbox interface.
- Authentication: Google OAuth (authorization-code flow) + D1 sessions (opaque httpOnly cookie) + TOTP MFA (RFC 6238, any authenticator app). No paid auth service. Do not use a shared bearer token in client-side JavaScript.
- Database: Cloudflare D1 (SQLite via REST API) for workspace, mailbox, message metadata, provider state, audit events and idempotency. Canonical schema: `db/schema.sql` + `db/seed.sql` (one file, not a numbered migration series).
- Tenant isolation: **enforced in application code** — membership checks in every route (`lib/guards.ts`, `requireUser()`). There is no database-level row security; every query must be workspace-scoped by the code that runs it, and isolation must be tested with two unrelated tenants.
- Attachments: Cloudflare KV (25 MB max value). Attachments are served through authenticated app download endpoints after membership checks — never through public or signed object URLs.
- Inbound: Cloudflare Email Routing -> inbound Email Worker (PostalMime) -> authenticated Vercel `/api/inbound` -> D1/KV.
- Outbound: Vercel API provider router. Default order: SendPulse -> Brevo -> Mailjet -> Resend, but only configured, sender-verified and quota-eligible providers are used.
- DNS: host DNS APIs or manual DNS instructions. Never guess DKIM selectors or SPF includes; use provider-returned values.
- Backups: D1 export + KV export, age-encrypted, stored as GitHub Actions artifacts (90-day retention).
- Observability: structured redacted logs, provider attempt ledger, audit events, quota counters and alerts.

## Explicitly out of scope
- Browser agent/computer-use agent or automated navigation of provider dashboards.
- Automated signup, CAPTCHA solving, OTP interception, account verification, or payment/billing actions.
- IMAP/POP mailbox hosting through Cloudflare Email Routing. WorkMail itself stores and serves inbox data.
- Unlimited inbound/outbound email or guaranteed $0 operation.
- Any card-required service. The card-gated object-storage service is not used.

## Workspace and data model
- User: identity, verification, MFA and account status.
- Workspace: owner, plan, limits, locale and timezone.
- Membership: workspace role (owner/admin/member/readonly).
- Domain: normalized domain, Cloudflare zone reference, ownership and DNS verification status.
- Mailbox: local part, full address, display name, catch-all flag and quota.
- Alias: alias address -> mailbox id.
- Provider connection: provider type, encrypted credential reference, sender verification, enabled/priority, last test and provider account reference.
- Message: workspace id, mailbox id, folder, envelope sender/recipient, headers, body reference, timestamps and delivery state.
- Attachment: KV key, MIME type, byte size and scan state.
- Provider attempt: provider, idempotency key, response class, retryable state and timestamp.
- Audit event: actor, workspace, action, target, timestamp and IP hash.

## Security invariants
1. Every tenant-owned record includes `workspace_id`.
2. Resolve workspace membership from the authenticated server-side session; never trust a client-supplied workspace id or role.
3. Scope every query by workspace id and resource id (application code — there is no database-level row security to fall back on).
4. Encrypt provider credentials at rest with AES-256-GCM using a server-held key (`PROVIDER_CREDENTIAL_ENCRYPTION_KEY`). Never return plaintext secrets or log them.
5. Use per-user, minimum-permission Cloudflare API tokens. Never request a registrar password or global Cloudflare password.
6. Protect state-changing endpoints with CSRF controls, strict CORS, rate limits (in middleware) and audit logging.
7. Verify inbound webhooks with HMAC/token and replay protection (`INBOUND_WEBHOOK_TOKEN`, `DELIVERY_WEBHOOK_TOKEN`).
8. Test cross-tenant ID substitution on every endpoint.
9. No server-only secret (encryption key, webhook token, API token) ever appears in client-side JavaScript or the browser bundle.

## Domain and DNS workflow
- Verify domain ownership with a unique TXT challenge.
- Configure MX/routing and inbound Worker only after zone ownership is confirmed.
- Obtain sender verification records from each provider's authenticated API or provider console.
- Enforce one SPF TXT record per hostname; merge authorized mechanisms carefully and remain within SPF DNS lookup limits.
- Verify DKIM selectors and DMARC. Do not activate until records match expected values.
- DNS propagation is variable; show Pending rather than claiming a fixed completion time.

## Mailbox capabilities (target product scope)
Inbox, Unread, Starred, Sent, Drafts, Archive, Spam, Trash; threaded conversations; search; labels; reply/reply-all/forward; attachments; contacts; signatures; read/unread; snooze; filters; import/export; message source; delivery/bounce status. Features must be implemented and tested before being advertised as available.

## Provider fallback rules
- Only configured providers with verified sender identity and available quota are eligible.
- Respect provider terms, daily/monthly quotas, suppressions, and account suspension state.
- 2xx means provider accepted the message, not that the recipient inbox received it.
- Use idempotency keys where supported. A timeout after possible acceptance is ambiguous: mark `unknown`, reconcile via webhook/provider logs, and do not blindly resend through every provider.
- Track accepted, delivered, bounced, complained, deferred, rejected and unknown separately.
- Never send to hard-bounce/complaint suppression entries.

## Production launch gates
Server-side auth and MFA; tenant authorization (application-code guards, two-tenant tested); encrypted secret vault; CSRF/CORS/rate limits; signed inbound events; MIME parsing and size caps; malware scanning; SPF/DKIM/DMARC validation; idempotent delivery; provider webhook reconciliation; backup/restore; retention/deletion/export; observability; integration tests; load tests; independent security review; incident runbooks. A beta/RC build is not production-ready until these gates are implemented and verified — see `PRODUCTION-READINESS-STATUS.md`.
