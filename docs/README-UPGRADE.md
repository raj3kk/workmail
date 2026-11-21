# WorkMail upgrade package

Start with `COMPLETE-SETUP-GUIDE.md`, then read `PRODUCT-COMPLETION-REPORT.md` for the five added workstreams and the exact remaining release gates. The app source to place at the root of your GitHub repository is the whole repository — repo root is the app root (there is no nested app folder to extract).

**D1 schema:** one file — `db/schema.sql` + `db/seed.sql`. There is no numbered migration series.

**Important:** this is a beta code package. Build verification is run by the coordinator after the route rewrite — see `AUDIT-REPORT.md`. Do not onboard paying customers or handle sensitive production mail until the release checklist passes.

## Latest production-controls package
See `PRODUCTION-OPERATIONS.md`, `PRODUCTION-READINESS-STATUS.md`, and the D1 schema in `db/schema.sql`. This release adds administrative suspension, workspace controls, a plan editor API, verified manual payment event ledger, TOTP MFA guard helper (`lib/guards.ts` + `lib/mfa.ts`), DKIM selector checks, Cloudflare DNS record creation, health/alert endpoints, encrypted scheduled D1 + KV backup scaffolding, restore drill script, and security/load/isolation test starters.

**Important:** these are implementation foundations, not a production certification. Build and live integration tests were not completed in this environment. Follow every release gate before handling customer email.
