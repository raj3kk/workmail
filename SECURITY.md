# Security policy

## Reporting a vulnerability

Do **not** open a public issue for a security vulnerability. Use GitHub's
private vulnerability reporting on this repository (Security → Report a
vulnerability), or email the host's security contact listed in the
repository. Include: what you found, where (route/file), impact, and
reproduction steps. We will acknowledge within 5 business days.

## What is (and is not) verified

- This is a Release Candidate / beta. **No independent penetration test has
  been performed.** `tests/security-smoke.sh` checks only that a handful of
  unauthenticated routes return 401/403 and that `/api/health` returns 200.
  It is not a penetration test.
- Auth: Google OAuth + D1 session cookies + TOTP MFA. Sessions are opaque
  random tokens stored hashed in D1 and revocable server-side.
- Tenant isolation is enforced in application code (membership checks in
  every route) — D1 has no row-level security. The tenant-isolation test
  (`tests/tenant-isolation.sql` + the API checks in
  `docs/PRODUCTION-READINESS-STATUS.md`) must pass before launch.
- Provider secrets are AES-256-GCM encrypted at rest
  (`PROVIDER_CREDENTIAL_ENCRYPTION_KEY`). If that key is lost, stored
  provider credentials cannot be recovered — there is no rotation flow yet.
- Rate limiting in `middleware.ts` is per-instance, in-memory and
  best-effort — not a substitute for a WAF or distributed limiter.
- Known open items (see `docs/PRODUCTION-READINESS-STATUS.md`): no malware
  scanning for attachments/inbound HTML, no HTML sanitizer, no
  provider-native webhook signature verification, manual payment ledger
  only, no load-test pass.

## Secrets

Never commit `.env`, `.env.local`, API tokens, provider keys or the
encryption key. `.env.example` contains placeholders only. Rotate any
credential that is ever exposed, in both the host env and the Cloudflare
Worker secrets.
