# WorkMail — Product Completion Report

This package extends the previous starter with five product workstreams on the Vercel + D1 + KV + Workers stack. It is a substantial beta implementation, **not a production certification**. You must apply the D1 schema, configure real services, test provider-specific webhooks, and complete a security review before accepting customer mail.

## Five workstreams

### 1. Attachments (Cloudflare KV)
- Private KV attachment store (25 MB max value, MIME allow-list). Attachments are served through authenticated app download endpoints after membership checks — never through public URLs.
- Authenticated upload endpoint: `POST /api/attachments` (multipart: `file`, `workspace_id`, `mailbox_id`, optional `message_id`).
- Authenticated download endpoint: `GET /api/attachments?id=...&workspace_id=...`.
- Server-side mailbox membership checks; KV keys are workspace/mailbox scoped; metadata stored in `message_attachments`.
- Upload metadata is recorded only when a message id is supplied. Uploads without a message id create a KV object without a metadata row; use only for pre-compose staging if you add a cleanup flow.
- Malware scanning and content-disarm are not included. Do not accept executable files or treat MIME declarations as proof of file safety.

### 2. Email productivity APIs
- Persistent contacts (`GET/POST /api/contacts`).
- Workspace labels (`GET/POST /api/labels`) and message-label relation table.
- Persistent draft create/list/update (`GET/POST/PATCH /api/drafts`).
- Thread retrieval (`GET /api/threads?mailbox_id=...&thread_id=...`).
- Server-side message search endpoint (`GET /api/search?mailbox_id=...&q=...`).
- Messages now have `thread_id`, `scheduled_at`, `deleted_at`, and `updated_at` fields plus search/thread indexes.
- The starter's visual inbox has not been fully redesigned to expose every new endpoint. Advanced filtering automation, safe rich-HTML rendering, full MIME parsing, calendar, signatures, forwarding and scheduled-send execution still need UI/workers. There is no HTML sanitizer yet.

### 3. Delivery lifecycle
- Delivery event ledger supports accepted/sent/delivered/deferred/bounced/complained/rejected/opened/clicked/unknown.
- Normalized authenticated webhook: `POST /api/delivery/webhook`, bearer `DELIVERY_WEBHOOK_TOKEN`.
- Hard bounces and complaints add recipient addresses to a workspace suppression list; outbound send now blocks suppressed recipients.
- Reconciliation endpoint: `POST /api/ops/reconcile`, bearer `OPS_CRON_TOKEN`; flags stale ambiguous jobs for review and deliberately does not blindly resend.
- Provider-specific webhook adapters/signature verification must be implemented and tested against the actual provider dashboard before enabling production callbacks. The normalized webhook token is a shared-secret ingress, not a substitute for each provider's native signature validation.
- Provider failover still does not safely retry ambiguous outcomes. Provider acceptance is not proof of inbox delivery.

### 4. Admin and billing foundation
- Platform admin workspace listing and plan changes: `/api/admin/workspaces` (GET/PATCH; platform admin allowlist only, via `PLATFORM_ADMIN_EMAILS`).
- Plan catalog, subscriptions, invoice ledger and manual approval flow: `/api/billing` (GET/POST/PATCH).
- A customer can request a plan; invoice remains pending. Only a platform admin can mark the invoice paid and activate the subscription. This is a manual ledger workflow, not a payment gateway integration.
- No payment checkout, automated webhook reconciliation, tax invoices, refunds, proration, dunning, suspension workflow or customer-facing admin UI is included. Do not describe manual payment reference entry as payment verification by a gateway.

### 5. Security and operations
- Added application-code tenant-isolation guards for new tables, private KV attachment storage, mailbox authorization checks, role-gated admin APIs, webhook shared secrets, and audit records for admin plan/payment actions.
- Added operational endpoint to flag ambiguous sends.
- Still required before production: independent penetration tests with two unrelated tenants; dependency/SAST/DAST scans; rate limiting/WAF; secret rotation; malware scanning; provider signature adapters; backups and restore drill; retention/deletion jobs; alerting; incident response; legal/privacy review; load testing; and monitoring of queue depth, bounces, complaints and abuse.

## Apply the upgrade
1. Back up the live D1 database (`npx wrangler d1 export` or `npm run backup`).
2. Apply the D1 schema in order: `db/schema.sql`, then `db/seed.sql`:
   ```bash
   npx wrangler d1 execute workmail --remote --file=db/schema.sql
   npx wrangler d1 execute workmail --remote --file=db/seed.sql
   ```
   The D1 schema is ONE file (`db/schema.sql` + `db/seed.sql`), not a numbered migration series.
3. Set `DELIVERY_WEBHOOK_TOKEN` and `OPS_CRON_TOKEN` to long random secrets in Vercel. Never expose them as `NEXT_PUBLIC_*` variables.
4. Confirm the KV namespace exists (`npx wrangler kv namespace list`) and its ID matches `CLOUDFLARE_KV_NAMESPACE_ID`.
5. Configure each provider's native event webhook and build/verify a provider-specific signature adapter before routing it to the normalized delivery webhook.
6. Test uploads and downloads with an owner, mailbox writer, mailbox reader and unrelated tenant. A reader may download; only a writer may upload.
7. Test each plan and manual invoice flow with a non-production workspace. Keep plan changes admin-only.

## Build status
Build verification (coordinator, 2026-11-21): `npm ci` clean, `npm run typecheck` clean (0 errors), `npm run build` PASS with dummy env (33 routes, incl. all /api/* routes). Live D1/KV/Google/provider integration is NOT verified by a build — see `AUDIT-REPORT.md`.

Do not deploy this as a production mail service until all checks in `PRODUCTION-CHECKLIST.md` pass.
