# Free-tier provider quotas — fallback chain (verified logic)

Last updated: 21 November 2026. Allowances are subject to account
eligibility, sender-domain verification, usage policies and provider
changes. The numbers below are the caps the code enforces; the providers'
own counters are the authority if the two ever disagree (reconcile then).

## The chain (fixed order — do not reorder without a coordinator decision)

Implemented in `lib/providers.ts` (`PROVIDER_CHAIN`) and used by
`app/api/send/route.ts` via `sendWithFallback()`.

| # | Provider | Free-tier cap enforced in code | Source of the number |
|---:|---|---:|---|
| 1 | SendPulse | **12,000/month, 50/hour** | PRD / audit snapshot 2026-11-20; 50/hr is the binding burst ceiling |
| 2 | Brevo | **300/day** | PRD / audit snapshot 2026-11-20 |
| 3 | Mailjet | **6,000/month, 200/day** | PRD / audit snapshot 2026-11-20 |
| 4 | Resend | **3,000/month, 100/day** | PRD / audit snapshot 2026-11-20 |

No provider gives unlimited free outbound email to arbitrary recipients.
Quotas are not additive guarantees; never use failover to evade a
provider's terms. HTTP 2xx means provider acceptance, not confirmed inbox
delivery.

Mailtrap, SMTP2GO and Gmail/App Script were listed in an earlier snapshot
of this file: they have **no adapter and are NOT in the chain**. Only the
four providers above are wired.

## How the caps are enforced

- Counters are D1-backed: before every provider attempt,
  `getCapState()` counts accepted sends for that workspace + provider in
  the current UTC hour / UTC day / UTC month from the `messages` table
  (`folder = 'sent'`, delivery state accepted/sent/delivered/opened/
  clicked/deferred, `created_at >= window start`). No new table is
  required, so no schema change was needed.
- A provider at (or over) any of its caps is **skipped** for that send
  (attempt result `cap_exhausted`, logged with the cap state) and the
  chain moves to the next provider. A send is never made that would exceed
  a cap.
- Only accepted sends consume quota in this ledger. Rejected attempts do
  not; unknown outcomes do not (the provider's own counter decides).
- The workspace monthly send limit (`workspace_settings.monthly_send_limit`,
  default 300) is still checked first in `/api/send`, independently of
  provider caps.
- Live cap state is visible at `GET /api/providers` (`cap_state` per
  provider: used / limit / remaining / exhausted / exhaustedBy).

## Timeout = "unknown", never "failed"

- Every provider call has a 10 s timeout (`SEND_TIMEOUT_MS`).
- A timeout, aborted request or dropped socket (`AbortError`,
  `ETIMEDOUT`, `ECONNRESET`, `EPIPE`, socket hang-up) is classified
  `unknown`: the chain **stops immediately**, the idempotency key is
  marked `unknown`, an `outbound_jobs` row with status `unknown` is
  written, and `/api/send` returns **202** ("do not resend until provider
  logs are checked").
- Resolution is by the delivery webhook (`/api/delivery/webhook`, which
  also writes bounce/complaint suppressions) or `POST /api/ops/reconcile`
  — never by blind resend.
- Only a DNS failure (`ENOTFOUND`/`EAI_AGAIN`, request never left the
  host) or a definite HTTP rejection (provider answered 4xx/5xx) lets the
  chain continue to the next provider.

## No blind resend / no duplicates

- One idempotency key per message (client-supplied `Idempotency-Key`
  header, else a generated UUID). The key + a SHA-256 request hash are
  reserved in `idempotency_keys` (`processing`) before any provider is
  called; reuse with different content is 409; an `accepted` key returns
  the original result as `duplicate: true`; a `processing`/`unknown` key
  is 409 ("check delivery logs before retrying").
- Failover reuses the **same** idempotency key on the next provider:
  Resend receives it as the `Idempotency-Key` header, Mailjet as
  `CustomID`. SendPulse/Brevo have no equivalent header, so the
  idempotency-key row is the duplicate guard for them.
- A send that is accepted by a provider is recorded once in `messages`
  and the key is marked `accepted` with that provider's message id.

## Suppression

- Bounce/complaint suppression (`suppressions` table, written by the
  delivery webhook on `bounced`/`complained`) is checked in `/api/send`
  (fast 409) **and re-checked by the engine before every provider
  attempt**. A suppressed recipient is skipped, logged
  (`result: suppressed`), never sent to, and the key is marked `failed`.

## Credentials

- Workspace credentials are the primary source: stored encrypted
  (AES-256-GCM, `PROVIDER_CREDENTIAL_ENCRYPTION_KEY`) in
  `provider_secrets`, saved via `POST /api/providers`, and only usable
  for sending once the admin attests the sender is verified in the
  provider dashboard (`sender_verified = 1`, `PATCH /api/providers`).
- Host env fallback (coordinator-owned, Vercel env — names only):
  `SENDPULSE_API_KEY` + `SENDPULSE_API_SECRET`, `BREVO_API_KEY`,
  `MAILJET_API_KEY` + `MAILJET_API_SECRET`, `RESEND_API_KEY`. The
  fallback is used only when the workspace has **no** row for that
  provider at all; a workspace row whose sender is unverified does NOT
  fall back to a host key. A provider with neither source is skipped
  cleanly and logged as `unconfigured`.
- Note: `cloudflare/api-worker/.env.example` uses different names
  (`SENDPULSE_ID`/`SENDPULSE_SECRET`, `MAILJET_SECRET_KEY`). The Next.js
  app uses the names above; the coordinator should align or document the
  difference before adding env vars.

## Logging

- Every attempt is one structured JSON line
  (`{event: "provider_attempt", workspace_id, idempotency_key, provider,
  result, latency_ms, cap, http_status, reason}`) plus a best-effort
  durable copy in `delivery_events` (`provider_event_id =
  attempt:<idempotency_key>:<provider>`). Secrets, API keys, tokens and
  message bodies are never logged.

## DNS records per provider

See `~/workspace/workmail-audit/provider-dns-records.md` (exact SPF/DKIM
records for sending from `@flow99.in`, with per-record verification
status). Rule: exactly ONE SPF TXT record at the apex — merge every
provider's `include:` into it; never publish two `v=spf1` records.

Attachment storage: Cloudflare KV is used. Cloudflare's card-gated
object-storage service is NOT used — enabling it requires a card/PayPal
on file, so it is out of this stack.
