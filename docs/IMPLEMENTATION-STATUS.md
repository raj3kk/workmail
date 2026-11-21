# Implementation status and production boundary

> **SUPERSEDED — 2026-11-21.** This is a pre-rebuild document. It describes the previous implementation, which was removed on 2026-11-21. Do not use this file as a description of the current code. The current status is in `PRODUCTION-READINESS-STATUS.md`, and the current setup is in `COMPLETE-SETUP-GUIDE.md`.

This repository is the most complete code handoff currently available for WorkMail. It is suitable as a pilot/beta codebase to install, inspect and extend, but it is not a fully production-certified commercial mailbox host.

## Implemented in code
- Next.js 14 + TypeScript app and Vercel configuration.
- Google OAuth (authorization-code flow).
- Workspace bootstrap, owner membership, role tables and RLS migration.
- Mailbox membership and permission model.
- Domain registration and DNS ownership challenge check.
- Mailbox creation and team role assignment for already-registered Google users.
- Per-workspace provider credential encryption using AES-256-GCM.
- Outbound adapters: SendPulse, Brevo, Mailjet and Resend.
- Basic provider priority fallback and idempotency reservation.
- Ambiguous network timeout recorded as `unknown` instead of blind fallback.
- Cloudflare inbound Email Worker with PostalMime normalization.
- Recipient-based server-side mailbox lookup.
- Basic inbox, message reader, compose, search, folder list and archive/trash actions.
- Initial platform admin metrics endpoint protected by explicit allowlist.

## Not implemented or not verified
- No successful dependency install/build certification in this handoff environment.
- SQL migrations have not been verified against a fresh live project.
- RLS and API authorization need independent multi-user/multi-tenant testing.
- No object-storage attachment upload/download or malware scanning.
- No full HTML email sanitization/rendering or robust MIME attachment handling.
- No complete threading, contacts, labels, filters, persistent drafts, forwarding, signatures or full-text search.
- No bounce/complaint webhooks, suppression lists or automated delivery reconciliation.
- Admin panel is metrics/security-event starter, not a complete customer lifecycle control plane.
- Billing, payments, invoices and subscription lifecycle are not implemented.
- Quota accounting needs concurrency hardening and abuse controls.
- Backups, retention jobs, restore drills, monitoring and disaster recovery are not implemented.
- DNS checker does not verify DKIM selectors or independently verify provider sender status.
- Cloudflare Email Routing is transport only; no IMAP/POP mailbox server is included.

## Required environment
See `COMPLETE-SETUP-GUIDE.md` and `.env.example`. The provider encryption key and inbound webhook token must be generated and kept secret by the deployer.

## Release status
Do not describe this as production-ready until install, typecheck, build, migrations, RLS isolation, provider tests, inbound/outbound end-to-end tests, security review and restore drills all pass.
