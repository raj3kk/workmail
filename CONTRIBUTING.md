# Contributing

WorkMail is a hosted single-instance product (see README.md). Contributions
are welcome as pull requests against `main`.

## Ground rules

- **Free tier, no card, forever:** no new paid service, no service that
  requires a card/PayPal on file, no third-party database/auth service,
  and no card-gated object storage. If a change needs a
  new dependency or service, say so in the PR and show its free limits.
- **Tenant isolation is code, not the database:** D1 has no row-level
  security. Every route that touches tenant data must filter by a
  membership-checked `workspace_id` (or a mailbox the caller can access)
  and must call `requireUser()` first. Add a test or a checklist note for
  any new route.
- **Secrets never travel:** never return a provider secret, token or
  verification token from an API; never log one; never put one in a doc.
- **Verify before claiming:** run `npm ci`, `npm run typecheck`,
  `npm run build` and `bash tests/security-smoke.sh` (with `BASE_URL`)
  before opening a PR. CI runs typecheck + build on every push/PR.
- **Docs stay consistent:** if a change affects setup, update
  `docs/COMPLETE-SETUP-GUIDE.md` and `docs/DEPLOY-CHECKLIST.md` in the
  same PR. One stack, one naming, one env naming everywhere.
