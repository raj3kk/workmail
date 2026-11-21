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

## MFA recovery codes and break-glass (G-28)

- **Recovery codes:** when a user completes TOTP enrolment
  (`POST /api/auth/mfa/verify` with the pending secret), the API returns
  10 single-use recovery codes **once** in that response. They are stored
  only as SHA-256 hashes (`recovery_codes.code_hash`); plain codes are
  never stored, never logged, and never returned again. A code can be
  used at `/api/auth/mfa/verify` in place of a TOTP code; a successful use
  burns it (`used_at` set) and verifies the session exactly like a TOTP
  code. An enrolled user with a fully MFA-verified session can regenerate
  a set via `POST /api/auth/mfa/setup` with
  `{"action": "recovery_codes"}` — old unused codes are revoked on
  regeneration. When the last code is used, the response warns the user
  to regenerate while they still have authenticator access.
- **Break-glass (lost authenticator AND lost recovery codes):** there is
  no self-service reset by design. A platform admin must verify the
  user's identity out of band (through the verified support channel),
  then clear the enrolment directly in D1 — delete the user's
  `recovery_codes` rows and set `users.mfa_secret = NULL` and
  `users.pending_mfa_secret = NULL` — and record the action in
  `admin_actions` with the reason. The user then re-enrols TOTP from
  scratch and receives a fresh set of recovery codes. Never disable MFA
  by editing `platform_user_controls.mfa_required` for one user; that
  flag is organisation policy, not a recovery mechanism. Treat every
  break-glass reset as a security event: log it, tell the user, and ask
  them to store the new recovery codes immediately.
