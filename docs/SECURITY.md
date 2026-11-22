# WorkMail — Security notes (Phase 3a)

How authentication, tokens, rate limits, and leak fixes work in this
repo, what was deliberately NOT done, and the manual steps that remain
outside code. No secrets, keys, or token values are in this file — or
anywhere else in the repo. If you find one, it is a bug: rotate it and
tell the coordinator.

## Auth model (short version)

- Sign-in is Google OAuth only (authorization-code flow, `openid email
  profile`). `exchangeGoogleCode` (lib/auth.ts) requires
  `email_verified === true` in the Google profile (G-11) — an
  unverified address can never create or claim an account.
- Sessions are opaque random tokens, stored SHA-256-hashed in D1
  (`sessions.token_hash`), 30-day expiry, revocable server-side. The
  cookie is `__Host-wm_session` (G-10): `HttpOnly; SameSite=Lax;
  Secure; Path=/`, no Domain attribute, exact-host only. Browsers
  holding the pre-change `wm_session` cookie are logged out once and
  get the new cookie at their next login.
- **Session rotation on login (G-10):** every login destroys all prior
  sessions of that user before creating the fresh one, so a login is
  always a rotation to exactly one live session. Consequence, stated
  plainly: signing in on a second device signs out the first device.
  `POST /api/auth/sessions/revoke-all` destroys all of the user's
  sessions EXCEPT the current one (same endpoint shape, for "sign out
  everywhere else").
- Signup (G-18): `upsertGoogleUser` creates user + workspace +
  membership + settings + subscription. The sequence is not atomic
  (D1 /batch 404s on this account; lib/db.ts does sequential /query
  calls), so two defences apply: (1) compensation — if any step
  throws, the rows created in that attempt are deleted in reverse
  dependency order and login fails cleanly; (2) reconcile on next
  login — `ensureUserWorkspace` rebuilds any missing piece
  idempotently, so a partial account heals itself on the next sign-in.
- MFA: TOTP (RFC 6238, no dependency) + single-use recovery codes
  (SHA-256 hashes only). Both `mfa_secret` and `pending_mfa_secret`
  are AES-256-GCM encrypted at rest with the same key as provider
  credentials (lib/crypto.ts, G-09). Rows written before this change
  are plaintext and are tolerated on read (decrypt falls back to the
  stored value) and re-encrypted on the next successful verification
  (migrate-on-use).

## Tokens

- **v1 API keys** (`wm_live_...`, table `api_keys`): per-workspace,
  hashed, scoped (`send`, `messages:read`), revocable. Shown once.
  The v1 API never accepts `OPS_CRON_TOKEN` or a session cookie.
- **Delivery-webhook tokens** (`wm_hook_...`, table `webhook_tokens`,
  migration 0003, G-01): per-workspace, hashed, shown once. The
  delivery webhook derives the workspace from the token and rejects a
  `workspace_id` in the body that does not match (403). The old shared
  `DELIVERY_WEBHOOK_TOKEN` env var is retired — the webhook no longer
  reads it; remove the variable from the Vercel env. Provider-native
  webhook signature verification (Brevo/Mailjet/Resend/SendPulse) is
  NOT wired — recorded follow-up, not silently dropped.
  - **UI decision (G-01, recorded):** tokens are managed by a NEW
    `app/settings/WebhookTokensSection.tsx` (ApiKeysSection pattern:
    create-once + copy, list, two-step revoke), NOT via the API-keys
    UI — the v1 key surface stays clean. The component is built and
    committed; mounting it is a one-line coordinator step because
    `app/settings/page.tsx` is coordinator-owned:
    `import WebhookTokensSection from "./WebhookTokensSection";` and
    `<WebhookTokensSection workspace={workspace}/>` next to
    `ApiKeysSection`. Until it is mounted, create a token with a
    session cookie:
    `POST /api/webhook-tokens {"workspace_id":"…","label":"…"}`
    (response carries `webhook_token` once), then call the webhook
    with `Authorization: Bearer <that token>`.
- **OPS_CRON_TOKEN** still authenticates only the ops routes
  (`/api/ops/monitor`, `/api/ops/reconcile`). It NO LONGER
  authenticates `/api/send`: the HTTP service branch is deleted
  (G-02, see below).
- **Legacy `cloudflare/api-worker/` (G-06): DELETE PENDING — see
  "Pending deletes" below. Do not deploy it.** It is a
  single-workspace sidecar (CORS `*`, shared bearer, non-multi-tenant)
  verified NOT deployed (live worker list 2026-11-22); it must never
  be deployed by accident.

## G-02 — service branch deleted (what was found)

Grep on 2026-11-22 for live callers of the HTTP service branch of
`/api/send` (Bearer `OPS_CRON_TOKEN` + `service_context:
'ai-auto-reply'`):

- `lib/ai.ts` `maybeAutoReply` calls `executeServiceSend` IN-PROCESS
  (no HTTP hop) — needs no token, unaffected.
- `cloudflare/inbound-email-worker` calls only `/api/inbound` (its
  own `X-Inbound-Token`) — never `/api/send`.
- `vercel.json` has no crons; nothing scheduled calls it.
- `app/page.tsx` sends with a session cookie only.
- The only other `OPS_CRON_TOKEN` users are `/api/ops/monitor` and
  `/api/ops/reconcile` (their own routes, untouched).

No live HTTP caller exists, so per decision D5 the branch is DELETED
(not split into per-purpose tokens). The single-token arbitrary-send
hole is closed. `lib/service-send.ts` still exports
`validateServiceToken` / `executeServiceSend` /
`SERVICE_CONTEXT_AI_AUTO_REPLY` for the in-process AI caller; the
HTTP-validation half is now dead code in that file — Phase 3b / the
coordinator may remove it (file is not Phase 3a's).

## Rate limits (G-03/G-04)

- Edge middleware (`middleware.ts`) is the first line: per-instance
  in-memory POST throttles (send 20/min/IP, inbound 60, delivery
  webhook 120, ops 30, callback 30, MFA verify 10/min/IP). Approximate
  on serverless — never the only line.
- D1-backed limiter (`lib/rate-limit.ts`, table `api_key_rate_limits`,
  decision D7): fixed-window counters, ~1 D1 write per request.
  Scopes: `v1_send` (30/min/key), `v1_messages` (120/min/key),
  `api_keys_manage`, `ai_draft` (10/min/workspace) — all Phase 2
  behaviour preserved — plus `auth` (30/min/IP, login callback),
  `send` (30/min/user, session send), `v1` (120/min generic fallback),
  `write` (60/min/user, mutating session routes), `mfa` (10/min/user
  coarse cap). Shared wrapper: `withRateLimit(opts)` returns a 429
  Response or null. On D1 error the limiter FAILS OPEN (logged, never
  thrown) — a limiter outage must not take down sending.
- **MFA lockout (G-04):** failure-only counting in the same table —
  5 failed verifications per user in 15 minutes lock the endpoint
  (429, checked before any code is verified); a success clears the
  count. Parent check V9: the 6th consecutive wrong code is blocked.
- **Scope boundary (recorded):** `withRateLimit` is applied to every
  mutating route Phase 3a owns (send, MFA verify/setup, webhook-token
  management, sessions revoke-all, domains DNS, delivery webhook).
  Mutating routes owned by other workers (team, contacts, templates,
  mailboxes, labels, filters, billing, providers, attachments, bulk,
  drafts, threads, messages, search, gmail-mirror, AI draft/reply)
  do NOT have it yet — they should adopt the same one-line wrapper;
  that sweep is not Phase 3a's file ownership.

## CSRF (G-05, decision D8)

`isValidOrigin` (lib/guards.ts) validates Origin — or, when Origin is
absent, Referer — against the app's own origin on all mutating session
routes Phase 3a owns. A request with neither header is rejected
(browsers always send Origin on POST; a cross-site form POST cannot
suppress it). Per-request CSRF tokens are deliberately deferred (D8):
this closes the cross-site POST hole at low risk. API-key and
machine-token routes do not use it — they authenticate by bearer
token, not cookie.

## Leak fixes (G-07, G-08, G-19)

- DNS PUT returns only `{success, record: {id, type, name}}` — the raw
  Cloudflare record (zone_id / zone_name / full body) never leaves the
  server. Cloudflare error details are reduced to messages.
- Health returns generic `{app: 'ok', d1: 'down'}` with no error text.
- `/api/ai/status` requires `workspace_id` always (400 without it,
  403 for non-members) — host config (provider/model) is no longer
  visible to a logged-in user with no membership in the workspace.
  NOTE: `app/page.tsx` calls this endpoint WITHOUT `workspace_id`
  today — its owner must pass `?workspace_id=<current>` (one-line
  fix) or the inbox AI status stops loading after this deploy.

## Content-Security-Policy (G-17, decision D13)

## Content-Security-Policy (G-17, decision D13)

Nonce-based CSP was ATTEMPTED and REVERTED to `unsafe-inline`, with
evidence — this is the D13 fallback, not a silent keep:

- Attempt: `middleware.ts` generated a per-request nonce, set the CSP
  response header (`script-src 'self' 'nonce-<nonce>'`), and set the
  same CSP as a REQUEST header so Next.js 14.2.35 would stamp the
  nonce onto its inline scripts (that version reads the nonce out of
  `req.headers["content-security-policy"]` —
  `get-script-nonce-from-header.js`; the `x-nonce` mechanism does not
  exist in this version). The middleware + header worked: a local
  production smoke build served a fresh nonce per request.
- Why it breaks the app: this app's pages are STATICALLY PRERENDERED
  at build time. Two consecutive requests to `/` returned
  byte-identical HTML while the CSP nonce differed — the inline RSC
  scripts (`self.__next_f.push(...)`) are baked into the HTML at
  build time and carry no nonce, so a nonce-only `script-src` would
  block them in the browser and kill hydration (the page renders but
  nothing works). Making the nonce work would require forcing every
  page to render per-request (`force-dynamic` in the root layout),
  which is a rendering-model change outside this phase's scope.
- Current state: CSP is static again in `next.config.mjs` with
  `script-src 'self' 'unsafe-inline'` — the same policy the live app
  already runs under. `style-src` keeps `'unsafe-inline'` for the
  same reason as before (email HTML in sandboxed srcDoc iframes is
  styled inline; scripts there cannot run anyway, `sandbox=""`
  without `allow-scripts`).
- To retry nonces later: make pages dynamic first, then re-apply the
  middleware nonce pattern (CSP on BOTH the request and the response
  headers — the request header is what Next.js reads).

Deliberate exception, recorded: `style-src` keeps `'unsafe-inline'`.
The message reader and the template preview render untrusted email
HTML inside sandboxed srcDoc iframes, and that HTML is styled with
inline styles — a nonce cannot be stamped onto third-party email
content. Scripts inside those iframes cannot run anyway (`sandbox=""`
without `allow-scripts`), so `script-src` stays nonce-only. If the
live smoke test shows a page broken by the nonce policy, the fallback
is `script-src 'self' 'unsafe-inline'` in `middleware.ts` — restore
it there and record why; do not ship a broken CSP.

## Cloudflare scoped tokens (G-15)

Attempted via API on 2026-11-22 (stored Cloudflare credential):

- **D1+KV token: already existed** — a scoped token with D1 Edit +
  Workers KV Storage (read/write) only, verified present in the
  account token list. No action taken.
- **DNS token: CREATED via API** — a new token scoped to Zone DNS
  Write on the flow99.in zone only, expiring 2027-11-22. The value is
  shown once by the API and was NOT printed or logged anywhere. It is
  saved in `~/workspace/workmail-audit/cf_dns_token.secret` (mode
  0600, outside the repo). The DNS route (`/api/domains/dns`) now
  prefers the `CLOUDFLARE_DNS_TOKEN` env var and falls back to
  `CLOUDFLARE_API_TOKEN` until the var is set.
- **Manual step (coordinator/parent):** set the Vercel env var
  `CLOUDFLARE_DNS_TOKEN` on the `workmail` project (Production) from
  that file, then redeploy. Until then the DNS route keeps using the
  broad host token — nothing breaks, the scoping just isn't live yet.
  If the saved value is ever lost, delete the token in the Cloudflare
  dashboard (My Profile → API Tokens) and re-create it with the
  dashboard steps below; the value cannot be retrieved again.
- **Manual steps if API creation had not been permitted** (kept for
  reference / re-creation): Cloudflare dashboard → My Profile → API
  Tokens → Create Token → Custom token → Permissions: `Zone / DNS /
  Edit` → Zone Resources: `Include / Specific zone / flow99.in` →
  TTL: 1 year → Create. Copy the value ONCE into the Vercel env var
  above. Never paste it into chat or commit it.

## Pending deletes (coordinator action — NOT done by this worker)

`cloudflare/api-worker/` must be deleted from the repo (G-06).
Deletion via the file API is not possible, so the exact list is
recorded here for the coordinator to delete:

- `cloudflare/api-worker/wrangler.toml`
- `cloudflare/api-worker/src/index.js`
- `cloudflare/api-worker/.env.example`

Verified not deployed (live worker list 2026-11-22 has no
api-worker; the wrangler.toml still carries the placeholder D1 id).
Do NOT delete `cloudflare/inbound-email-worker/` — that one is live
and serves inbound mail.

## What this phase did NOT do (boundaries)

- Provider-native webhook signature verification: follow-up, not
  wired (per-workspace tokens close the cross-tenant hole now).
- Per-request CSRF tokens: deferred by decision D8 (Origin/Referer
  validation instead).
- Rate-limit sweep of mutating routes outside Phase 3a ownership:
  wrapper exists, adoption is a follow-up (list in "Rate limits").
- `app/page.tsx` ai/status call fix (one line, owner: UX-Inbox) and
  the WebhookTokensSection mount (one line, coordinator) — both are
  recorded above with exact instructions.
