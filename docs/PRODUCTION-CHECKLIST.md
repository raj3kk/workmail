# Production readiness gate

> **Note on `[x]`:** `[x]` means code is present in the repo, NOT that it is verified — verification needs the live gate evidence listed in `PRODUCTION-READINESS-STATUS.md`.

Do not launch paid/public multi-tenant service until every item is verified.

- [ ] Per-workspace provider credential vault using envelope encryption; no global shared API keys.
- [ ] Sender address is explicitly selected and verified for the sending workspace; no arbitrary From.
- [ ] Add per-user/workspace rate limits, daily quotas, abuse/spam controls and suppression list.
- [ ] Add idempotency key + provider reconciliation for ambiguous timeout responses; avoid blind retry duplicates.
- [ ] Complete inbound MIME parsing, recipient-to-mailbox mapping, signed worker-to-app request and replay protection.
- [x] Add private KV attachment upload/download endpoints, metadata, size/type allow-list and authenticated download endpoints.
- [ ] Add malware scanning/content disarm and inbound MIME attachment extraction before enabling production attachment handling.
- [ ] Add threading, RFC Message-ID/In-Reply-To, folders, stars, archive/trash semantics and pagination.
- [x] Add normalized delivery event ledger, bounce/complaint suppression, authenticated webhook ingress and stale-job review endpoint.
- [ ] Add provider-native webhook signature adapters, unsubscribe flow and automated reconciliation/retry workers.
- [x] Add role-gated workspace plan/admin APIs and manual subscription/invoice approval ledger.
- [ ] Add workspace member invite flow, full admin UI, account suspension/deletion/export and audit search UI.
- [ ] Add retention policy, backups, restore drill, monitoring, alerts and incident response.
- [ ] Test tenant isolation (application-code guards) with two unrelated accounts and malicious IDs.
- [ ] Test OAuth callback, revoked sessions, domain verification, SPF/DKIM/DMARC, delivery, provider outages and quota exhaustion.
- [ ] Run dependency audit, secret scan, SAST, DAST, load tests and deliverability tests.
- [ ] Confirm legal/privacy terms, anti-abuse policy and provider acceptable-use compliance.

This checklist is not a claim that the items are done. It is a release gate.

## Additional release gates (D1 schema)
- [ ] Apply `db/schema.sql` + `db/seed.sql` and verify application-code isolation as owner, admin, member, read-only and an unrelated tenant user.
- [ ] Confirm mailbox assignments prevent cross-mailbox reads, updates and sends.
- [ ] Confirm platform admin is deny-by-default and only explicit `PLATFORM_ADMIN_EMAILS` entries can access `/admin`.
- [ ] Generate and back up `PROVIDER_CREDENTIAL_ENCRYPTION_KEY`; test decrypt/rotation recovery.
- [ ] Verify provider sender identity in provider dashboard before recording sender-verification attestation.
- [ ] Test idempotent send retry, provider 429/5xx, network timeout (unknown state), and delivery reconciliation.
- [ ] Verify inbound worker token, recipient-to-mailbox mapping, duplicate Message-ID handling and cross-tenant rejection.
- [ ] Add malware scanning for attachments before enabling attachment storage or download.
- [ ] Implement and test billing provider webhooks before charging customers.
- [ ] Complete penetration testing and privacy/legal review before public onboarding.

## Product completion (D1 schema)
- [ ] Apply `db/schema.sql` + `db/seed.sql` (one file, not a numbered migration series).
- [ ] Test attachment read/write access with owner, writer, read-only and unrelated tenant users.
- [ ] Configure provider-native delivery webhook signature validation before forwarding normalized events.
- [ ] Test manual invoice lifecycle; do not accept client-side payment claims as proof of payment.
- [ ] Configure Vercel secrets `DELIVERY_WEBHOOK_TOKEN` and `OPS_CRON_TOKEN`.
- [ ] Verify KV attachment MIME/size limits and implement malware scanning before public release.
