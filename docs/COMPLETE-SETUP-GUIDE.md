# WorkMail — Complete setup guide (hosted model)

WorkMail is a hosted webmail service for custom domains. **One hosted instance** is run by the host (Flow99 / Priyadarshi). The host owns the Vercel app, the Cloudflare account (D1, KV, Workers, Email Routing), the code, the migrations, monitoring and backups. The end user only signs up, adds their domain and DNS records, enters provider API keys and creates mailboxes.

This is a **beta / release-candidate** implementation, not a certified production email host. Do not onboard paying customers or store sensitive business email until you pass every release gate in section J.

## What is included
- Next.js 14 App Router + TypeScript web app (repo root is the app root).
- Google OAuth (authorization-code flow) + D1 sessions (opaque httpOnly cookie) + TOTP MFA (RFC 6238, any authenticator app).
- Cloudflare D1 schema (`db/schema.sql`) and seed data (`db/seed.sql`) for workspaces, domains, mailboxes, memberships, messages, mailbox permissions, provider secrets, idempotency and usage.
- Tenant isolation enforced in application code: membership checks in every route (see `lib/guards.ts`). There is no database-level row security — every query must be workspace-scoped by the code that runs it.
- Customer settings UI: domains, mailboxes, team membership, mailbox assignment and provider credential setup.
- Initial platform admin dashboard (explicit allowlist only, via `PLATFORM_ADMIN_EMAILS`).
- Outbound provider adapters: SendPulse, Brevo, Mailjet and Resend, sequential priority fallback; ambiguous network timeouts are marked unknown and are not blindly retried.
- Cloudflare Email Worker using PostalMime to normalize inbound messages and forward to Vercel.
- Server-side recipient-to-mailbox mapping; the inbound API does not accept workspace IDs from the Worker.
- AES-256-GCM application-level encryption for stored provider credentials.
- Basic inbox, reader, compose, search, folders and message archive/trash actions.
- Private KV attachment endpoints, contacts/labels/drafts/thread/search APIs, delivery event and suppression ledger, normalized delivery webhook, reconciliation flagger, plan catalog, manual invoice ledger and platform-admin workspace/plan APIs. See `PRODUCT-COMPLETION-REPORT.md`.

## Architecture
- Web UI + API: Vercel (Next.js 14, one project, root directory `./`).
- Authentication: Google OAuth (authorization-code flow) + D1 sessions + TOTP MFA. No paid auth service.
- Database: Cloudflare D1 (SQLite via REST API). No database-level row security — tenant isolation is enforced in application code.
- Attachments: Cloudflare KV (25 MB max value). Object storage is not used.
- Inbound transport: Cloudflare Email Routing → inbound Email Worker (PostalMime) → Vercel `/api/inbound`.
- Outbound transport: per-workspace provider credentials (entered by the user in Settings) → SendPulse/Brevo/Mailjet/Resend.
- DNS: the user publishes DNS records at their DNS host. Cloudflare DNS API automation is available to the host; manual DNS is supported.
- Backups: D1 export + KV export, age-encrypted, stored as GitHub Actions artifacts (90-day retention). No object storage.

## A. Host setup — Cloudflare (D1 + KV)

The host does this once, in the host-owned Cloudflare account. End users never touch Cloudflare.

1. Install Wrangler and sign in: `npm install -g wrangler` then `wrangler login`.
2. Create the D1 database:
   ```bash
   npx wrangler d1 create workmail
   ```
   Note the database ID it returns.
3. Apply the canonical schema and seed data to the live database:
   ```bash
   npx wrangler d1 execute workmail --remote --file=db/schema.sql
   npx wrangler d1 execute workmail --remote --file=db/seed.sql
   ```
   The D1 schema is ONE file (`db/schema.sql` + `db/seed.sql`). There is no numbered migration series.
4. Create the KV namespace for attachments:
   ```bash
   npx wrangler kv namespace create workmail_attachments
   ```
   Note the namespace ID it returns.
5. Create a Cloudflare API token with only the permissions the app needs (D1 edit, KV edit, Zone DNS edit for the host's zones). Never use a global API key.

## B. Host setup — Google OAuth client

1. In Google Cloud Console, create an OAuth client of type **Web application**.
2. Add the authorized redirect URI `{APP_URL}/auth/callback`, where `{APP_URL}` is the exact public app origin (for example `https://flow99.in` or the Vercel URL during staging).
3. Note the client ID and client secret. They go into the host's Vercel environment as `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`. They are never shown to end users and never committed to the repo.

## C. Host setup — GitHub + Vercel

1. Push the repository to GitHub (`raj3kk/workmail`). The repo root **is** the app root — push the whole repo, not a subfolder.
2. Import the repository in Vercel. Framework preset: Next.js; Root Directory: `./`.
3. Add the host environment variables in Vercel (Production; Preview only if needed; Development if using the Vercel CLI). The full list lives in the root `.env.example` — reference it, do not copy values into docs. The variables are: `NEXT_PUBLIC_APP_URL`, `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_D1_DATABASE_ID`, `CLOUDFLARE_KV_NAMESPACE_ID`, `CLOUDFLARE_API_TOKEN`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `PROVIDER_CREDENTIAL_ENCRYPTION_KEY`, `INBOUND_WEBHOOK_TOKEN`, `DELIVERY_WEBHOOK_TOKEN`, `OPS_CRON_TOKEN`, `PLATFORM_ADMIN_EMAILS`, `MFA_ENFORCEMENT`.
   - `PROVIDER_CREDENTIAL_ENCRYPTION_KEY` — base64-encoded 32-byte key. Generate with `openssl rand -base64 32`. Back it up securely offline before first use. If lost, encrypted provider credentials cannot be decrypted.
   - `INBOUND_WEBHOOK_TOKEN`, `DELIVERY_WEBHOOK_TOKEN`, `OPS_CRON_TOKEN` — long random secrets, generated with `openssl rand -base64 32`. Never reuse one value across environments.
   - `PLATFORM_ADMIN_EMAILS` — comma-separated list of the platform admin email addresses.
4. Deploy. Confirm the build passes (`npm ci`, `npm run typecheck`, `npm run build`).

Do not commit `.env`, `.env.local`, any API token or the encryption key to GitHub. `.env.example` is a template, not live credentials. Env vars belong to the host (deployer), not to end users.

## D. First login and platform admin

1. Visit the app URL and sign in with Google using an email address listed in `PLATFORM_ADMIN_EMAILS`.
2. The first login creates your personal workspace, owner membership and default settings.
3. Visit `/admin`. Only addresses listed in `PLATFORM_ADMIN_EMAILS` can access it. Never grant platform admin to ordinary customers.
4. Enable TOTP MFA for the admin account and test recovery before any customer is onboarded.

## E. Deploy the inbound Cloudflare Email Worker

1. Open `cloudflare/inbound-email-worker/`.
2. Install worker dependencies and deploy with Wrangler using the host Cloudflare account.
3. Set Worker variable `WORKMAIL_API_URL` to the app origin (no trailing slash).
4. Set Worker secret `INBOUND_WEBHOOK_TOKEN` to exactly the same value as Vercel.
5. Configure Cloudflare Email Routing so the domain's incoming email is delivered to this Worker.
6. Send a test email from an unrelated external address.
7. Confirm it appears in the intended mailbox and cannot be read from another workspace/mailbox account.

The Worker normalizes sender, recipient, subject, text and HTML with PostalMime. Cloudflare Email Routing is transport, not an IMAP/POP hosted mailbox — WorkMail stores messages in D1/KV and serves them in its own webmail UI.

## F. User setup — domain and mailbox (what the end user does)

The host has already done everything above. The end user only does this, in the app's Settings UI:

1. Open `/settings` → Custom domains → add `flow99.in` (or their own domain).
2. Copy the `_workmail-verification` TXT host and value shown by WorkMail.
3. Add that TXT record at their DNS provider.
4. Wait for DNS propagation and click Verify.
5. Add MX records required by Cloudflare Email Routing and the chosen provider's instructions.
6. Configure one SPF TXT record at the root. Do not create multiple independent SPF records; merge authorized sender includes and stay within SPF DNS lookup limits.
7. Add DKIM records exactly as shown in each sending provider dashboard.
8. Add DMARC at `_dmarc.flow99.in`; begin with a monitoring policy if still validating delivery, then tighten after review.
9. Verify the sender/domain in the provider's own dashboard.
10. In WorkMail Settings → Providers, enter the provider API key (Mailjet also requires its secret), save it, then use the verification attestation only after provider-side verification is genuinely complete.
11. In Settings → Mailboxes create `hello@flow99.in` (and `support@flow99.in` as needed).
12. Assign only the staff who should access that mailbox.
13. Test sending to an address you control and check the provider delivery logs.

DNS verification checks domain ownership TXT plus presence of MX, SPF and DMARC. It does not independently prove DKIM correctness or provider-side sender verification. The provider confirmation is an explicit human attestation.

Full user-side instructions: see `USER-SETUP-GUIDE.md`.

## G. Roles and access model
- Platform Super Admin: separate allowlist via `PLATFORM_ADMIN_EMAILS`; controls platform metrics.
- Workspace Owner: owns workspace and has owner-level access.
- Workspace Admin: manages workspace settings and team.
- Member: ordinary staff.
- Read-only: read-only staff.
- Mailbox permissions: `read`, `read_write`, `manage`, assigned separately from workspace role.

A workspace membership should not itself expose all mailbox messages. Test this with two separate Google users and at least two mailboxes. Tenant isolation is enforced in application code (`lib/guards.ts`); it requires independent two-tenant testing before public launch.

## H. Provider fallback behavior
- Provider order is configured by priority per workspace.
- A provider success means accepted by provider, not guaranteed inbox delivery.
- Definite HTTP/API rejection can move to the next configured provider.
- Timeout/network ambiguity is recorded as `unknown`; the code intentionally stops rather than blindly sending via another provider, because the first provider may have accepted the message.
- Reconcile unknown outcomes manually against provider logs before retrying.
- Delivery webhooks, bounce/complaint suppression and automated reconciliation are included as a normalized webhook + suppression ledger + stale-job review endpoint; provider-specific webhook signature adapters must still be verified against each provider's dashboard.

## I. Remaining gaps — honest list (not production certified)
- Payment gateway: manual ledger only. No checkout, no payment webhooks, no refunds, no dunning, no tax invoices.
- No IMAP/POP support.
- No malware scan for attachments; no HTML sanitizer for message rendering.
- No full MIME attachment extraction on inbound mail yet; no cleanup flow for pre-compose uploads.
- Full mail client UI gaps: visible threading, filter/rule execution, forwarding/signatures, import/export and scheduled-send worker. Contacts, labels, drafts and search APIs are included but not fully surfaced in the UI.
- Provider-specific webhook signature adapters, unsubscribe management, automated retry/reconciliation worker and delivery analytics UI still need verification.
- Complete platform admin UI, user suspension/deletion, workspace lifecycle controls, support access approvals, audit search and alerting still need verification.
- Quota concurrency hardening, inbound limits, abuse/spam detection and domain reputation controls.
- External penetration test, dependency audit, load test and end-to-end acceptance tests have not been run.
- Build behavior must be verified in the host environment; this release is a beta/RC until the live gates in section J pass.

## J. Mandatory release gate (12 items — do not skip)
1. `npm ci` succeeds.
2. `npm run typecheck` succeeds.
3. `npm run build` succeeds.
4. `db/schema.sql` + `db/seed.sql` applied to the live D1 database; seed data present.
5. Two workspaces cannot read each other's domains, mailboxes, messages, members or provider configuration.
6. Two users in one workspace cannot read each other's mailboxes unless explicitly assigned.
7. Read-only role cannot send, modify or delete messages.
8. API rejects forged workspace/mailbox IDs and unauthorized roles.
9. Inbound test stores message only in the recipient's mailbox.
10. Outbound test verifies provider acceptance, failure fallback and unknown-timeout behavior.
11. Secret scanning confirms no keys in client bundle, Git history or logs.
12. Suspension is enforced on every guarded route, and the backup + restore drill is tested (D1 export + KV export, age-encrypted, restored to a staging D1).

## Important
This is a hosted service run by Flow99. The host supplies and configures the Vercel, Cloudflare, Google OAuth and DNS accounts. The end user supplies only their domain, DNS records and provider API keys. No credentials are included in this repo. No unlimited or free email delivery is promised; quotas, provider approval, domain reputation and hosting plan limits apply. See `DEPLOY-CHECKLIST.md` for the step-by-step host deploy checklist.
