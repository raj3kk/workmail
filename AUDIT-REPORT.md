# WorkMail — Final Audit Report (2026-11-21)

**Verdict: Release Candidate / beta. Code gates pass (typecheck + build +
zero-reference sweep + schema tests). Live gates are still open — see §7.
Do not onboard paying customers until §7 passes.**

This report covers the original ZIP audit, every fix applied, the permanent
replacement of the old database/auth/storage stack, the parallel-slice audit,
and the exact remaining work (mostly live-account steps for the parent).

Original inputs: `WorkMail-Production-Controls-Release-Candidate.zip`
(129 entries / 79 files) + Hindi manual
`WorkMail-Production-Readiness-and-Setup-Manual-HI.pdf` (verdict:
PRODUCTION RELEASE BLOCKED). The manual's Hindi prose is unrecoverable
(broken font — every Hindi word renders as ■); only English headings,
paths and variable names survived extraction.

---

## 1. What the ZIP contained (audit of the original code)

Next.js 14 app (`serverless-work-email/`, ~1,288 lines), 26 API routes,
4 Postgres migrations (0001–0004), 2 Cloudflare Workers, 2 GitHub
workflows, 3 tests, 17 docs. The docs were unusually honest: almost every
one says "beta / NOT production-certified / release BLOCKED". The real
problems were stale/contradictory docs, wrong paths, and defects the docs
did not mention.

### Top gaps found (with evidence)

| # | Severity | Finding | Evidence |
|---|---|---|---|
| 1 | HIGH | `next.config.mjs` unparseable — build could not start | File was one line of literal `\n` sequences; `node --check` → `SyntaxError: Invalid or unexpected token` |
| 2 | HIGH | `.gitignore` non-functional (same literal-`\n` corruption) | `od -c` showed one 72-byte line; `node_modules/`, `.next/`, `.env` all committable |
| 3 | HIGH | `domains/dns` PUT dead scope check — any workspace admin could create arbitrary DNS records in the shared Cloudflare zone | `app/api/domains/dns/route.ts:4`: checked `b.domain` (never sent by clients) instead of the DB row `d.domain`; no ownership verification |
| 4 | HIGH | Suspension enforced on 5 of 26 handlers; no DB policy referenced `suspended_at` | `lib/guards.ts` `requireUser()` was the only suspension check; RLS never enforced it |
| 5 | HIGH | Cloudflare api-worker SQL broken against its own schema | `mailbox` column does not exist (real: `mailbox_id`); `workspace_id NOT NULL` omitted; `delivery_attempts` insert used nonexistent `success`/`detail` columns → every inbound/send/list call 500'd, and a successful send was reported as failed (duplicate-send risk) |
| 6 | HIGH | 7 read endpoints RLS-only, no in-route membership check | `contacts`/`domains`/`mailboxes`/`drafts`/`search`/`threads`/`labels` GET |
| 7 | MEDIUM | No rate limiting anywhere (0 matches for rate/throttle) | Token endpoints + `/api/send` brute-forceable |
| 8 | MEDIUM | MFA effectively unenforced | Default off (`MFA_ENFORCEMENT=false`); `requireUser()` only blocked already-enrolled users; `/mfa-required` redirect loop (page not exempt); no enrolment UI |
| 9 | MEDIUM | `mailboxes` POST `assign_to` unvalidated — any user UUID could get `manage` | `app/api/mailboxes/route.ts:3` |
| 10 | MEDIUM | Next.js 14.2.15 in CVE-2025-29927 range | `package.json:18` |
| 11 | MEDIUM | Migrations not re-runnable | All 4 files: `CREATE POLICY` with no preceding `DROP POLICY IF EXISTS` — second run dies at the first policy |
| 12 | MEDIUM | `message_attachments` write policy allowed `read`-only members to write | 0002 used `can_access_mailbox` instead of `can_write_mailbox` |
| 13 | MEDIUM | Plan mismatch: `enterprise` allowed by a check constraint but absent from `plan_catalog` | 0002 vs 0003 seed — any `enterprise` subscription violated the FK |
| 14 | MEDIUM | `workmail_is_suspended` was an oracle for any authenticated user | 0004 granted EXECUTE to `authenticated` with no auth check inside |
| 15 | MEDIUM | `restore-drill.sh` had no decrypt step (backups are `.age` only) and only a name-based non-prod guard | `pg_restore` fed the encrypted file directly |
| 16 | MEDIUM | `backup.sh` left plaintext dumps behind on failure (no trap/mktemp) | `rm -f` ran only on success |
| 17 | MEDIUM | `backup.yml` wrong path; `monitor.yml` invalid YAML | `bash scripts/backup.sh` from repo root (script lives nested); monitor.yml `ScannerError` line 13 col 65 (`: ` in plain scalar) |
| 18 | MEDIUM | `package.json` test scripts pointed at nonexistent paths | `tests/` at repo root, scripts run from `serverless-work-email/` |
| 19 | MEDIUM | No `package-lock.json` anywhere; no LICENSE/SECURITY.md/CONTRIBUTING/CI | Non-reproducible installs |
| 20 | LOW | `tenant-isolation.sql` did not test isolation | Probed as table owner (RLS bypassed) and checked "does workspace B have any message" |
| 21 | LOW | Docs contradictions (12 found) | e.g. setup guide listed 3 migrations (there were 4); `IMPLEMENTATION-STATUS.md` stale on 5+ points; app README told deployers to set global provider keys the Next app never reads; `FREE-DEPLOY-GUIDE` used wrong var `API_WORKER_URL` |

**What was done well (kept):** AES-256-GCM provider-secret encryption with
random IV + auth tag; timing-safe token compares on inbound/delivery
webhooks; `/api/send` idempotency reserve with request-hash binding,
suppression check, verified-domain gate, unknown-outcome handling;
attachments `authorized()` checks + signed-URL expiry + filename
sanitisation; admin mutations writing audit rows; inbox never rendering
stored HTML.

---

## 2. Permanent replacement — old stack removed, new stack in place

On 2026-11-21 the user ordered the **permanent, full** replacement of the
old database/auth/storage stack. This is not a workaround: no file in the
pushed repo references the old services (verified by the zero-reference
sweep in §6 — the only historical mentions are in this report).

### What was removed

- **The old hosted-database service** (Auth, Postgres, row-level security,
  Storage, all client libraries, all env vars, all 4 migrations, all doc
  references). Replaced by: **Google OAuth (authorization-code flow) +
  Cloudflare D1 (SQLite) + opaque session cookies + TOTP MFA**.
- **The old card-gated object-storage service** (attachments + backups).
  Replaced by: **Cloudflare KV** for attachments and **age-encrypted
  GitHub Actions artifacts** for backups.

### Why the object-storage service is out — card required (live research)

Live-verified 2026-11-21: the object-storage service's free allowance is
10 GB + 1M Class A / 10M Class B ops with $0 egress — **but enabling it
requires a payment method (card/PayPal) on file**. The allowance is free;
the activation is card-gated. The user will not provide a card, so the
service is permanently out for both attachments and backups.

### Replacement chosen: Cloudflare D1 + KV + Workers (+ Vercel hosting)

| Piece | Service | Free tier (live-verified 2026-11-21) | Card? |
|---|---|---|---|
| Web app + API | Vercel (Next.js 14) | Hobby, free | No |
| Database | Cloudflare D1 (SQLite) | 5 GB total, 5M rows read/day, 100K rows written/day, 10 DBs | No |
| Attachments | Cloudflare KV | 1 GB, 100k reads/day, 1,000 writes/day, 25 MB max value | No |
| API/inbound | Cloudflare Workers | 100,000 requests/day | No |
| Outbound mail | SendPulse / Brevo / Mailjet / Resend (user's own free accounts) | 12,000/mo; 300/day; 6,000/mo, 200/day; 3,000/mo, 100/day | No |
| Backups | GitHub Actions artifacts (age-encrypted) | 90-day retention | No |

### Alternatives evaluated (and why D1 won)

- **Turso (libSQL) Free — 5 GB, 100 DBs, 500M reads/mo, 10M writes/mo,
  no card (GitHub signup).** More generous on reads than D1 and a real
  option. Rejected as primary because it is a second vendor with a second
  token/account, and it does not integrate with Workers/KV/Pages the way
  D1 does. Kept as the documented fallback if D1 limits ever bind.
- **Neon Free — 1 GB/project, 100 CU-hours/mo, no card.** Postgres
  dialect would have eased the migration, but 1 GB/project and
  compute that sleeps (cold starts) make it the weakest fit for a
  always-on inbox; also a second vendor.
- **D1 chosen** for single-vendor hosting fit: one Cloudflare account
  holds the database, the KV namespace and the Workers; one API token
  (D1 Edit + KV Edit) serves the app; no card anywhere.

### What the replacement changed in code

- `lib/db.ts` (new): D1 over the Cloudflare REST API; parameterised SQL
  only; `dbQuery/dbOne/dbRun/dbBatch`, `newId()`, `nowIso()`, JSON helpers.
- `lib/auth.ts` (new): Google OAuth code exchange + userinfo; D1 `users`
  + `sessions` tables; opaque random session tokens stored hashed,
  httpOnly cookie, 30-day expiry, server-side revocation; first-login
  workspace/membership/settings/subscription creation (previously a DB
  trigger); first platform admin via `PLATFORM_ADMIN_EMAILS` env (no
  manual SQL).
- `lib/mfa.ts` (new): TOTP (RFC 6238, SHA-1, 30 s, ±1 window), dependency-free.
- `lib/kv.ts` (new): KV over REST API (`kvPut/kvGet/kvDelete`); keys
  `att/<workspace>/<mailbox>/<uuid>-<name>`; 25 MB cap matches KV's max value.
- `lib/guards.ts` (rewritten): `requireUser(req)` — session → user
  suspension → workspace suspension → MFA (enrolled secret requires a
  verified session; `MFA_ENFORCEMENT=true` requires enrolment);
  `requirePlatformAdmin`, `workspaceRole`, `canAccessMailbox`, `listWorkspaceIds`.
- `db/schema.sql` + `db/seed.sql` (new, canonical): all 33 tables converted
  to SQLite (TEXT UUIDs, TEXT ISO timestamps, INTEGER booleans, TEXT JSON);
  `pending_mfa_secret` on users; `updated_at` triggers (the old migrations
  added the columns but never maintained them); FK indexes the old
  migrations lacked; enterprise plan row seeded **inactive, price 0**
  (a platform admin must price + activate it before sale).
- `middleware.ts` (rewritten): rate limiting only (send 20/min, inbound
  60/min, delivery webhook 120/min, ops 30/min, callback 30/min, per IP,
  per instance, best-effort). Auth/suspension/MFA live in `requireUser()`
  per route. The old `/mfa-required` redirect loop is fixed (page exempt).
- All 26 original API routes rewritten to D1 + 7 new routes
  (`/api/messages` GET, `/api/messages/[id]` PATCH, `/api/auth/login`,
  `/logout`, `/session`, `/mfa/setup`, `/mfa/verify`).
- Pages rewritten to API calls (no direct database access from the browser).
- `scripts/backup.sh` / `restore-drill.sh`: D1 export + KV export,
  age-encrypted, GitHub artifacts (90-day retention); restore into a
  disposable D1 only, with an ID-mismatch guard.
- `cloudflare/api-worker`: SQL fixed to the canonical schema; logs to
  `delivery_events` (the old `delivery_attempts` table does not exist);
  sender mailbox must resolve or the call 404s (no NULL `mailbox_id`).
  Header states it is a single-workspace/private-test sidecar, not a
  multi-tenant API.
- `cloudflare/schema.sql` (stale subset) deleted; canonical schema is
  `db/schema.sql` only.
- Env: `.env.example` rewritten (Cloudflare + Google + Vercel only).
  Deploy target stays **Vercel** (per the final order — no Pages switch).
- Docs: all of `docs/` rewritten to the hosted model (Vercel + D1 + KV +
  Workers, flow99.in primary); `docs/DEPLOY-CHECKLIST.md` added.

### Known trade-offs of the replacement (honest)

- **No database-level row security.** D1 has no RLS. Tenant isolation is
  enforced ONLY by application code (membership/mailbox checks in every
  route). A missing check is a real cross-tenant hole — this is why the
  tenant-isolation test and the per-route audit matter, and why the
  pentest gate stays open.
- **Rate limiting is per-instance, in-memory.** Not a WAF/distributed limiter.
- **D1 REST API latency:** every query is an HTTPS call to Cloudflare
  (plus the app's own round trip). Fine for this scale; watch the 5M
  reads/day budget if traffic grows.
- **KV eventual consistency + 1,000 writes/day:** attachment uploads are
  capped by KV writes; a burst of >1,000 uploads/day will fail.
- **Backups live in GitHub artifacts (90 days).** No long-term retention
  until a separate decision is made.

---

## 3. Fixes applied (original-ZIP issues → resolution)

| # | Fix |
|---|---|
| 1 | `next.config.mjs` rewritten with real newlines + security headers (CSP, HSTS, X-Frame-Options DENY, Referrer/Permissions-Policy, nosniff) |
| 2 | `.gitignore` rewritten with real newlines + full coverage (node_modules, .next, .env*, .vercel, Wrangler state) |
| 3 | `next-env.d.ts` rewritten with real newlines |
| 4 | DNS PUT: validates `record_name` against the DB domain + requires verified ownership/DNS; logs to `dns_change_log` |
| 5 | Suspension: `requireUser()` on every user route + middleware-independent; admin-users PATCH mirrors suspension to `users.suspended_at` (the old route wrote a table the guard never read) |
| 6 | RLS-only GETs now enforce membership/`canAccessMailbox` in-route (domains/mailboxes filter by `listWorkspaceIds()`; contacts/labels/threads/drafts/search enforce access) |
| 7 | Rate limiting added in middleware (see §2) |
| 8 | MFA: TOTP enrolment + verify routes and UI (settings + `/mfa-required`); redirect loop fixed; `MFA_SETUP_REQUIRED` code when enforcement is on and the user never enrolled |
| 9 | `mailboxes` POST validates `assign_to` is a workspace member |
| 10 | Next.js bumped `14.2.15` → `^14.2.25` (CVE-2025-29927); `package-lock.json` generated |
| 11 | Migrations replaced by re-runnable D1 schema (idempotent `IF NOT EXISTS`; triggers guarded) |
| 12 | Attachments write now requires write permission (via `canAccessMailbox(write=true)`) |
| 13 | Enterprise plan row seeded (inactive, price 0) so the FK is satisfiable |
| 14 | Suspension check is server-side SQL only (no oracle: no client-callable function) |
| 15 | Restore drill: decrypt step added; guard refuses unless the restore D1 ID differs from production |
| 16 | Backup: mktemp + trap cleanup; plaintext dump can never survive a failed run |
| 17 | `backup.yml`: correct D1/KV export + artifact upload; `monitor.yml`: YAML fixed (folded block scalar) + `--max-time 15` |
| 18 | `package.json` test scripts now correct from repo root (`tests/` at root) |
| 19 | LICENSE (MIT), SECURITY.md, CONTRIBUTING.md, CI workflow (typecheck + build + YAML validation) added |
| 20 | Tenant-isolation test rewritten for D1 (schema sanity + documented API-level proof; the old role-based test was meaningless) |
| 21 | Docs: 12 contradictions fixed (migration counts, provider-key guidance, var names, stale status doc bannered SUPERSEDED, duplicate product report de-duplicated); `domains` GET no longer returns `verification_token`; `providers` GET returns metadata only; no route returns a plaintext credential; zero `console.log` of secrets |
| 22 | Secret-handling audit: settings provider form uses `type="password"` inputs, clears keys after save, lists metadata only; send decrypts server-side only; no secret in logs/bundle/responses |

Behaviour changes vs the old routes (deliberate, with reason): domains POST
no longer returns `verification_token` inside `data` (TXT value still
returned once); attachments GET streams KV bytes instead of a signed URL
(KV has no signed URLs); drafts PATCH now has the owner override (POST
already had it); search escapes `%`/`_` instead of replacing them with
spaces; send usage counter increments atomically; team GET takes an
optional `?workspace_id` and resolves emails via a `users` join; MFA
verify bypasses `requireUser` (otherwise enrolled-but-unverified users
could never clear the MFA_REQUIRED state — the old deadlock).

---

## 4. Parallel-slice audit (per the 2026-11-21 18:43/18:47 orders)

Six slices ran; the last three (routes / workers-scripts-tests / docs) ran
in parallel with strict file ownership (one slice per folder set; shared
files — `package.json`, README, `.env.example` — coordinator-only).
No two slices edited the same file; no overwrites happened.

| Slice | Status | Output |
|---|---|---|
| 1. Routes/auth audit | Done | §1 findings table (routes audit) |
| 2. SQL/workers audit | Done | §1 findings (migrations/workers/scripts) |
| 3. Docs/hygiene audit | Done | §1 findings (docs, incl. manual's broken Hindi font) |
| 4. API routes rewrite (D1) | Done | 26 rewritten + 7 created; `tsc` clean |
| 5. Workers/scripts/tests/backup | Done | api-worker SQL fix, D1+KV backup/restore, tenant test rewrite; scratch-SQLite schema check 36/36 PASS |
| 6. Docs rewrite | Done | 16 docs files rewritten/created; zero banned references in `docs/` |

**Conflicts/issues found in the merge audit and how they were resolved:**

1. **api-worker `delivery_attempts` bug (Slice B):** the worker logged to a
   table that does not exist in the canonical schema, inside the send
   try-block — a successful send would have been reported as failed and
   retried (duplicate-send risk). Fixed: logs to `delivery_events` with a
   fresh `provider_event_id` per attempt.
2. **`totpAuthUrl` false alarm (Slice A):** the handoff showed the otpauth
   URL containing a literal placeholder. Verified by byte check: the file
   contains the correct `${secret}` interpolation — the placeholder was
   runtime display redaction, not file content. No fix needed; the MFA
   setup route was still simplified to use the helper.
3. **`pending_mfa_secret` missing from schema (Slice A):** real gap.
   Fixed: column added to `db/schema.sql` (the runtime ALTER in the setup
   route stays as a defensive migration for early databases).
4. **Docs vs scripts staleness (Slice C note):** C reported the backup
   scripts as "still old" — stale by the time it wrote the note; Slice B
   had already rewritten them. Verified directly: both scripts are D1+KV.
5. **Literal-token vs zero-grep conflict (Slice C):** the brief asked for
   literal "R2 is not used" phrasing AND zero grep matches — impossible
   together. Resolved in favour of the hard rule (zero matches); the
   facts are conveyed without the banned tokens outside this report.
6. **Restore-drill `--json` parsing (Slice B):** assumes `wrangler d1
   execute --json` returns `[{"results":[{...}]}]`. Syntax-checked only;
   first live run must confirm the shape (open item, §7).

**Cross-slice consistency re-verified by the coordinator:** every `@/lib/*`
import used by routes/pages exists; every `/api/*` path fetched by a page
has a route; all 3 workflows parse; `db/schema.sql` applies cleanly to
SQLite; seed data correct (free/pro/business active, enterprise inactive).

---

## 5. Verification results (2026-11-21, this VM)

| Check | Result |
|---|---|
| `npm ci` | Clean (29 packages) |
| `npm run typecheck` | **PASS — 0 errors** |
| `npm run build` (dummy env, no real secrets) | **PASS — exit 0; 33 routes** (all `/api/*` + pages + `/auth/callback`) |
| Zero-reference sweep | **PASS — 0 matches** for `supabase` (any case), `service_role`, `NEXT_PUBLIC_SUPABASE`, word-boundary `R2`, `postgres` — across the whole repo (excluding this report, the allowed historical record). False positives noted: `selector2` (a DKIM selector name) and a base64 hash inside `package-lock.json` — neither is the removed service. |
| `db/schema.sql` on SQLite | **PASS** — applies cleanly; seed correct |
| `tests/tenant-isolation.sql` on scratch SQLite | **PASS** — all checks pass (FK check empty, all tenant tables have `workspace_id`, unique indexes present) |
| Workflow YAML | **PASS** — all 3 workflows parse |
| `bash -n` scripts, `node --check` workers + k6 | **PASS** |
| `npm audit` | **NOT RUNNABLE here** — sandbox egress policy blocks the audit endpoint (`403 policy_denied`). Not a code failure; must run in CI or on the deploy machine. Next.js is on `^14.2.25` (past CVE-2025-29927). |
| `tests/security-smoke.sh` | **Needs a live URL** — cannot run offline; run against staging after deploy (see §7). |
| Live D1/KV/Google/provider round-trips | **NOT verified** — no live credentials exist in this environment; first live run is a §7 gate. |

---

## 6. Production-readiness gates

**Code gates — CLOSED (verified above):** typecheck, build, zero-reference
sweep, schema validity, workflow validity, guard coverage on all user
routes, rate limits, idempotency, encrypted credentials + masked display,
tenant checks in-route, suspension + MFA enforcement, backup/restore
scripts present and syntax-checked.

**Live gates — OPEN (need accounts/browser/deploy; see §7):**

1. Live D1 apply (`db/schema.sql` + `db/seed.sql`) + KV namespace creation.
2. Vercel project + env vars + deploy + live URL verification.
3. Google OAuth client (redirect `{APP_URL}/auth/callback`) + first live login.
4. Inbound Email Worker deploy + Email Routing route for flow99.in.
5. DNS on flow99.in (MX/SPF/DKIM/DMARC + ownership TXT) + sender verification.
6. Provider accounts (SendPulse/Brevo/Mailjet/Resend, free, no card) +
   API keys saved encrypted + fallback order tested.
7. End-to-end mail test for `hello@flow99.in` (inbound + outbound + DNS).
8. Two-tenant isolation test against staging (two users, two workspaces).
9. Backup run + restore drill against a disposable D1 (incl. KV artifact).
10. `tests/security-smoke.sh` against staging.
11. Load test (k6 starter only hits `/api/health` — needs authenticated scenarios).
12. Independent pentest / formal security audit.
13. Payment gateway (manual ledger only today) + refunds/tax/dunning.
14. Malware scanning + HTML sanitizer + provider-native webhook signatures.
15. `npm audit` (blocked in this sandbox; run in CI).

**"Production ready" is claimed ONLY for the code gates above.** The
product is a Release Candidate until the live gates pass.

---

## 7. Remaining work — exact steps for the parent (browser/live work)

The coordinator cannot use a live browser. These steps need the parent
agent (browser tasks) and, where marked, the user. **No step needs a card
or any spend. Passwords/secrets must never be written in chat, reports,
code or logs.**

**Login scope (user correction 2026-11-21 18:46):** fallback-provider
sign-ins use **flipify.com@gmail.com** ("Sign in with Google" where
available). If any step asks for an OTP/2FA, STOP and ask the user —
never guess. Vercel project is under the flipify.com@gmail.com account.

### A. GitHub (parent verifies after the push)
- Repo: `raj3kk/workmail` — verify it exists, the commit, file count and
  that README renders. (Push details in the coordinator's final report.)

### B. Cloudflare (host account; no card)
1. Sign in to Cloudflare (host account).
2. Create D1 database `workmail-db`; note the database ID.
3. `wrangler d1 execute workmail-db --file=db/schema.sql`, then
   `--file=db/seed.sql`. Confirm the plan_catalog has 4 rows.
4. Create a KV namespace `workmail-attachments`; note the namespace ID.
5. Create an API token with D1 Edit + KV Storage Edit; note it (host env only).
6. Deploy `cloudflare/inbound-email-worker` (`wrangler deploy`); set vars
   `WORKMAIL_API_URL` = Vercel app origin and secret
   `INBOUND_WEBHOOK_TOKEN` (same value as Vercel env).
7. In Email Routing, create the custom address/route for flow99.in that
   invokes the inbound worker.

### C. Google OAuth (free)
1. Google Cloud Console → create OAuth web-application client.
2. Authorized redirect URI: `{APP_URL}/auth/callback`.
3. Put the client ID/secret in Vercel env (`GOOGLE_CLIENT_ID`,
   `GOOGLE_CLIENT_SECRET`).

### D. Vercel (flipify.com@gmail.com)
1. Import `raj3kk/workmail`; root directory `./`; framework Next.js.
2. Set env vars from `.env.example` (all Cloudflare + Google + webhook
   tokens + `PROVIDER_CREDENTIAL_ENCRYPTION_KEY` — generate with
   `openssl rand -base64 32` — + `PLATFORM_ADMIN_EMAILS` with the owner's
   email).
3. Deploy; verify the build passes and the live URL responds
   (`/api/health` → 200, `d1: ok` once D1 is applied).
4. Set the Vercel URL as `NEXT_PUBLIC_APP_URL` (redeploy if changed).

### E. DNS + mailbox for flow99.in (user-side DNS host)
1. In the app: Settings → Domains → add `flow99.in`; publish the
   ownership TXT record shown; click Verify.
2. Publish MX (per Cloudflare Email Routing), SPF, DKIM (from the chosen
   provider's dashboard), DMARC (`_dmarc.flow99.in`, monitoring policy
   first, then tighten).
3. Settings → Providers: enter provider API keys (fallback order:
   SendPulse → Brevo → Mailjet → Resend); confirm sender verification in
   each provider dashboard; use the in-app attestation only after that.
4. Settings → Mailboxes: create `hello@flow99.in` (and `support@flow99.in`).
5. **End-to-end test:** send from an external mailbox to
   `hello@flow99.in` (must land in exactly that mailbox, unread by other
   workspaces); reply/send from `hello@flow99.in` to the external mailbox
   (must arrive; check provider logs); confirm MX/SPF/DKIM/DMARC pass.

### F. Post-deploy verification (parent)
- Run `bash tests/security-smoke.sh` with `BASE_URL` = live URL.
- Two-user/two-workspace isolation check on staging.
- Backup workflow run + restore drill on a disposable D1.
- `npm audit` (in CI or on a machine where the registry is reachable).
- GitHub secrets for backup/monitor workflows (see `.env.example` footer).

---

## 8. Files changed (summary)

Repo layout (94 files): app at root, `lib/` (D1/auth/TOTP/guards/crypto/KV),
`db/schema.sql` + `db/seed.sql`, `cloudflare/` (2 workers), `scripts/`
(D1+KV backup/restore), `tests/`, `docs/` (16 files incl. new
`DEPLOY-CHECKLIST.md`), `.github/workflows/` (ci/backup/monitor), root
README, LICENSE, SECURITY.md, CONTRIBUTING.md, `AUDIT-REPORT.md` (this file).
Deleted: all Supabase migrations/client files, stale `cloudflare/schema.sql`,
duplicate product report. Original ZIP untouched at
`~/workspace/user/files/WorkMail-Production-Controls-Release-Candidate.zip`.
