# WorkMail Integration API (v1) — Phase 2

Base URL: `https://workmail-delta.vercel.app`

The v1 API lets a website, platform, or AI agent send mail and read
messages with only the important things added. Auth is a per-workspace
API key; there is no other machine credential for v1.

## Keys

- Create in **Settings → API keys** (workspace owner/admin only).
- Format `wm_live_…`, shown **once** at creation. Only the SHA-256
  hash is stored; no GET ever returns a key value.
- Scopes: `send`, `messages:read`. A key touches only its own
  workspace. Optional expiry; revoke is instant.
- Never ship a key in client-side code — call the API from your server.
- The v1 API **never** accepts `OPS_CRON_TOKEN` or a session cookie.

## POST /api/v1/send

Scope: `send`. Header: `Authorization: Bearer wm_live_…`.

Body:

```json
{
  "to": "customer@example.com",
  "subject": "Your order is confirmed",
  "text": "Hi Ana, your order #12345 is confirmed.",
  "html": "<p>Hi Ana, your order <b>#12345</b> is confirmed.</p>",
  "provider": "auto",
  "mailbox_id": "optional-uuid",
  "thread_id": "optional-uuid",
  "in_reply_to": "optional-message-id",
  "idempotency_key": "optional-string"
}
```

- `provider`: `"auto"` (default fallback chain) or `"sendpulse"`,
  `"brevo"`, `"mailjet"`, `"resend"`.
- `thread_id` / `in_reply_to`: pass when replying so the message
  joins the existing thread.
- Idempotency: `Idempotency-Key` header or `idempotency_key` body
  field. Same key + same content = the original result, never a
  second delivery. Same key + different content = 409.
- Caps (same as POST /api/send): subject ≤ 998 chars, text ≤ 100,000,
  HTML ≤ 200,000, ≤ 10 attachments / 10 MB total; body > ~300 KB = 413.
- Rate limit: 30 sends/min per key (429 + `Retry-After`).
- The send reuses `executeSend` as `{kind:'user', userId: key owner}`,
  so the monthly workspace cap, suppression list, idempotency,
  per-provider caps and provider fallback apply identically to the UI.
- Honest statuses (RULE 0): `success: true` only on provider
  acceptance. Unknown provider outcome = 202 — do not resend blindly.
- `template_id` is accepted by the schema but currently returns 400:
  template rendering lives in `lib/service-send.ts`, which Phase 1
  owns in parallel; the coordinator wires it when Phase 1 merges.

Success response:

```json
{
  "success": true,
  "provider": "brevo",
  "messageId": "provider-message-id",
  "sent_message_id": "workmail-message-id",
  "delivery_state": "accepted",
  "attempts": []
}
```

## GET /api/v1/messages

Scope: `messages:read`. Header: `Authorization: Bearer wm_live_…`.

Query: `?mailbox_id&limit&cursor&delivery_state&search&include_body=true`

- Returns **only the key's workspace** messages, newest first.
- `limit` clamped 1–100 (default 50). `cursor` is the opaque
  `next_cursor` from the previous page.
- `delivery_state`: `received`, `accepted`, `sent`, `delivered`,
  `opened`, `clicked`, `deferred`, `bounced`, `complained`, `failed`,
  `unknown`.
- `search` matches subject/from/to. `include_body=true` adds
  `text_body` / `html_body` (omitted by default).
- Rate limit: 120 requests/min per key (429 + `Retry-After`).

Row: `id, mailbox_id, folder, from, to, subject, delivery_state,
provider, received_at, created_at` (+ bodies when requested).

## AI-agent flow

1. Key with both scopes (`send` + `messages:read`).
2. Poll `GET /api/v1/messages?delivery_state=received&include_body=true`.
3. Reply with `POST /api/v1/send` carrying the inbound message's
   `thread_id` and `in_reply_to` so the reply stays in-thread.
4. Poll again — the reply shows as `delivery_state=accepted`.

## Errors

| Status | Meaning |
|---|---|
| 401 | Missing / malformed / revoked / expired key |
| 403 | Key lacks the scope, or the mailbox is not in the key's workspace |
| 400 | Invalid body |
| 409 | Suppressed recipient, monthly limit, unverified domain, idempotency reuse with different content |
| 413 | Body / attachments over the caps |
| 429 | Per-key rate limit (see `Retry-After`) |
| 202 | Provider outcome unknown after timeout — check delivery state, do not blind-resend |
| 502 | All configured providers rejected the send |

## Rate limiting

D1-backed per-key sliding windows (`lib/rate-limit.ts`,
`api_key_rate_limits` table, decision D7). If the limiter itself
fails, it fails open (logs and allows) so a limiter outage never
blocks legitimate sends. Phase 3a extends the same interface to
other scopes (`auth`, `mfa`, `send`, `write`).

## Tenant isolation

- `lib/api-auth.ts` resolves the workspace from the key hash; every
  v1 query is scoped `WHERE workspace_id = ?` to that workspace.
- Cross-workspace mailbox ids get the same 403 as nonexistent ones.
- `tests/tenant-isolation.sql` §(d) checks the `api_keys` schema half
  (workspace_id column, unique key_hash index); the API half is the
  live check in PRODUCTION-PLAN.md §9 V7: a key from workspace A
  gets 401/403 on workspace B's data, never rows.
