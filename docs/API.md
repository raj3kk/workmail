# WorkMail Integration API (v1)

Base URL: `https://workmail-delta.vercel.app`

The v1 API lets a website, platform, or AI agent send mail and read
messages with only the important things added. Auth is a per-workspace
API key; there is no other machine credential for v1. The in-app docs
page (`/api-docs`) says the same thing in plainer words, with
copy-paste examples; this file is the full reference.

Every example uses the placeholder `WM_LIVE_KEY` — replace it with a
key you create in Settings → API keys. Never put a real key in a doc,
a repo, or client-side code.

## Keys — how to get one (step by step)

1. Sign in to WorkMail with Google.
2. Open **Settings → API keys**.
3. Click **Create key**. Give it a label you will recognise (e.g. "My
   website", "Support agent") and tick the scopes you need: `send` to
   send mail, `messages:read` to list and read messages. You can also
   set an expiry date.
4. The key appears **once**, looking like `wm_live_…`. Copy it now
   into your server's secrets (environment variable). It is never
   shown again, never appears in any API response, and can be revoked
   instantly from the same page.
5. Use a separate labelled key per integration, so revoking one does
   not break the other.

- Format `wm_live_…`, shown **once** at creation. Only the SHA-256
  hash is stored; no GET ever returns a key value.
- Scopes: `send`, `messages:read`. A key touches only its own
  workspace. Optional expiry; revoke is instant.
- Never ship a key in client-side code — call the API from your server.
- The v1 API **never** accepts `OPS_CRON_TOKEN` or a session cookie.

## Authenticate

Every request carries the key as a Bearer token. Session cookies and
any other token are not accepted by the v1 API.

```http
Authorization: Bearer WM_LIVE_KEY
Content-Type: application/json   (only for requests with a body, i.e. POST)
```

## GET /api/v1/mailboxes

Scope: `messages:read`. Lists the key's own workspace mailboxes so an
integrator can discover mailbox IDs without reading D1 or the UI. Only
active mailboxes are listed, oldest first — the first one is the
workspace default (the mailbox `POST /api/v1/send` uses when
`mailbox_id` is omitted). Rate limit: same window as messages
(120/min per key).

```bash
curl "https://workmail-delta.vercel.app/api/v1/mailboxes" \
  -H "Authorization: Bearer WM_LIVE_KEY"
```

```js
const API_KEY = "WM_LIVE_KEY"; // replace with your key
const BASE_URL = "https://workmail-delta.vercel.app";

const res = await fetch(BASE_URL + "/api/v1/mailboxes", {
  headers: { "Authorization": "Bearer " + API_KEY }
});
const data = await res.json(); // { mailboxes: [...] }
```

Response:

```json
{
  "mailboxes": [
    { "id": "mailbox-id-1", "address": "hello@example.com", "display_name": "Example Support", "signature": "Best regards,\nExample Support" },
    { "id": "mailbox-id-2", "address": "support@example.com", "display_name": "", "signature": "" }
  ]
}
```

- `id` — the mailbox ID. Pass it as `mailbox_id` when sending or
  listing messages.
- `address` — the email address recipients see in the From line.
- `display_name` — the friendly sender name (empty when none is set).
- `signature` — the plain-text signature the server appends to every
  send from this mailbox (empty when none is set; set it in Settings →
  Mailbox signatures).

## POST /api/v1/send

Scope: `send`. Header: `Authorization: Bearer wm_live_…`.

```bash
curl -X POST https://workmail-delta.vercel.app/api/v1/send \
  -H "Authorization: Bearer WM_LIVE_KEY" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: order-12345" \
  -d '{
    "to": "customer@example.com",
    "subject": "Your order is confirmed",
    "text": "Hi Ana, your order #12345 is confirmed.",
    "html": "<p>Hi Ana, your order <b>#12345</b> is confirmed.</p>",
    "provider": "auto",
    "mailbox_id": "optional-uuid",
    "thread_id": "optional-uuid",
    "in_reply_to": "optional-message-id",
    "idempotency_key": "optional-string"
  }'
```

```js
const API_KEY = "WM_LIVE_KEY"; // replace with your key
const BASE_URL = "https://workmail-delta.vercel.app";

const res = await fetch(BASE_URL + "/api/v1/send", {
  method: "POST",
  headers: {
    "Authorization": "Bearer " + API_KEY,
    "Content-Type": "application/json",
    "Idempotency-Key": "order-12345"
  },
  body: JSON.stringify({
    to: "customer@example.com",
    subject: "Your order is confirmed",
    text: "Hi Ana, your order #12345 is confirmed.",
    html: "<p>Hi Ana, your order <b>#12345</b> is confirmed.</p>"
  })
});
const data = await res.json();
console.log(res.status, data);
```

### Body fields

| Field | Type | Required? | Meaning |
|---|---|---|---|
| `to` | string (email) | Yes | One recipient per send. |
| `subject` | string, max 998 chars | Yes | Subject line. |
| `text` | string, max 100,000 chars | One of `text` / `html` | Plain-text body. |
| `html` | string, max 200,000 chars | One of `text` / `html` | HTML body. |
| `provider` | string | No, default `"auto"` | `"auto"` (fallback chain) or `"sendpulse"`, `"brevo"`, `"mailjet"`, `"resend"`. A manual pick only works if that provider is enabled and sender-verified for the workspace. |
| `mailbox_id` | string (UUID) | No | Which mailbox the mail comes FROM. Get IDs from `GET /api/v1/mailboxes`. Omit for the workspace default mailbox. |
| `thread_id` | string (UUID) | No | Replying: the thread to join (from a listed message). Omit for a new mail. |
| `in_reply_to` | string, max 998 chars | No | Replying: the Message-ID of the mail being answered (the listed message's `message_id`). Omit for a new mail. |
| `idempotency_key` | string, max 200 chars | No | Your own unique ID for this send (e.g. your order number). Same key + same content = the original result, never a second delivery. Same key + different content = 409. Also accepted as the `Idempotency-Key` header. |
| `attachments` | array | No | Files as base64 — see below. Max 10 files, 1 MB total, 2 MB per file. |
| `template_id` | string (UUID) | No | Send using a saved email template. The template supplies the subject and body (your `text`/`html` are ignored when it is set). Template IDs are on the Templates page in WorkMail. A template that does not belong to your workspace is a 409. |
| `variables` | object (string → string, each value max 2,000 chars) | No — only with `template_id` | Values for the template's placeholders, e.g. `{"name": "Ana", "otp": "123456"}`. An unknown placeholder name is a 400 and nothing is sent. |

### Attachments (E5-6)

Each entry is `{filename, content_type, content_base64}` — the file
content encoded as base64 text so it can travel inside JSON. The
decoded bytes are stored in KV with the exact same mechanism as the
UI compose flow (`att/<workspaceId>/<mailboxId>/...`, content-hash
derived keys so idempotency retries resolve to the same object) and
handed to the shared send pipeline as object-key refs — no second
attachment pipeline. Only the refs (never the base64) are stored in
D1 payloads.

- Allowed types (same allow-list as the UI upload path
  `POST /api/attachments`): PDF, PNG, JPEG, GIF, WebP, plain text,
  CSV, ZIP, Word (`.docx`), Excel (`.xlsx`). Any other type is a 400.
- Each file: max 2 MB decoded. All files together: max 1 MB decoded.
  Over the caps is a 413 and nothing is sent. Max 10 files.
- A missing `filename`, a disallowed `content_type`, or text that is
  not valid base64 is a 400 — nothing is sent.
- Request body cap is 2 MB (base64 inflates by ~4/3; 1 MB of
  attachments is ~1.4 MB of JSON). Over it is a 413.
- The older KV-ref form is still accepted in the same array:
  `{attachment_id}` or `{object_key, file_name, content_type,
  size_bytes}` (10 MB total, 25 MB per file, as for the UI path).

```bash
# Turn a file into base64 first (Linux: base64 -w0; macOS: base64 -i)
B64=$(base64 -w0 invoice.pdf)
curl -X POST https://workmail-delta.vercel.app/api/v1/send \
  -H "Authorization: Bearer WM_LIVE_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "to": "customer@example.com",
    "subject": "Your invoice",
    "text": "Please find your invoice attached.",
    "attachments": [
      { "filename": "invoice.pdf", "content_type": "application/pdf", "content_base64": "'"$B64"'" }
    ]
  }'
```

```js
const fs = require("fs");
const API_KEY = "WM_LIVE_KEY"; // replace with your key
const BASE_URL = "https://workmail-delta.vercel.app";

const pdfBase64 = fs.readFileSync("invoice.pdf").toString("base64");

const res = await fetch(BASE_URL + "/api/v1/send", {
  method: "POST",
  headers: {
    "Authorization": "Bearer " + API_KEY,
    "Content-Type": "application/json"
  },
  body: JSON.stringify({
    to: "customer@example.com",
    subject: "Your invoice",
    text: "Please find your invoice attached.",
    attachments: [
      { filename: "invoice.pdf", content_type: "application/pdf", content_base64: pdfBase64 }
    ]
  })
});
const data = await res.json();
console.log(res.status, data);
```

- Rate limit: 30 sends/min per key (429 + `Retry-After`).
- The send reuses `executeSend` as `{kind:'user', userId: key owner}`,
  so the monthly workspace cap, suppression list, idempotency,
  per-provider caps and provider fallback apply identically to the UI.
- Honest statuses (RULE 0): `success: true` only on provider
  acceptance. Unknown provider outcome = 202 — do not resend blindly.

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

Query: `?mailbox_id&limit&cursor&delivery_state&search&label_id&include_body=true`

```bash
curl "https://workmail-delta.vercel.app/api/v1/messages?limit=20&delivery_state=received" \
  -H "Authorization: Bearer WM_LIVE_KEY"
```

```js
const API_KEY = "WM_LIVE_KEY"; // replace with your key
const BASE_URL = "https://workmail-delta.vercel.app";

const res = await fetch(
  BASE_URL + "/api/v1/messages?limit=20&delivery_state=received",
  { headers: { "Authorization": "Bearer " + API_KEY } }
);
const data = await res.json();
// data.messages is the list; data.next_cursor pages forward.
```

Response:

```json
{
  "messages": [
    {
      "id": "message-id",
      "mailbox_id": "mailbox-id",
      "folder": "inbox",
      "from": "customer@example.com",
      "to": "hello@example.com",
      "subject": "Do you deliver to Pune?",
      "delivery_state": "received",
      "provider": null,
      "thread_id": "thread-id",
      "message_id": "inbound-message-id",
      "received_at": "2026-11-22T08:00:00.000Z",
      "created_at": "2026-11-22T08:00:00.000Z"
    }
  ],
  "total": 1,
  "limit": 20,
  "next_cursor": null
}
```

- Returns **only the key's workspace** messages, newest first.
- `limit` clamped 1–100 (default 50). `cursor` is the opaque
  `next_cursor` from the previous page; `null` means the last page.
- `delivery_state`: `received`, `accepted`, `sent`, `delivered`,
  `opened`, `clicked`, `deferred`, `bounced`, `complained`, `failed`,
  `unknown`.
- `search` matches subject/from/to. `include_body=true` adds
  `text_body` / `html_body` (omitted by default).
- `mailbox_id` filters to one mailbox (must belong to the key's
  workspace — another workspace's ID is a 403). Omit it to see all
  mailboxes together.
- `label_id` filters to messages carrying that label (the label must
  belong to the key's workspace — a foreign or unknown label ID
  returns an empty list). Label IDs are on the inbox page: open a
  message, add a label, and the label list in Settings → Mail filters
  shows the same labels.
- `thread_id` / `message_id` are the threading fields: pass them back
  as `thread_id` / `in_reply_to` when replying in-thread (see the
  AI-agent flow). Both are `null` when none is recorded.
- Rate limit: 120 requests/min per key (429 + `Retry-After`).

Row: `id, mailbox_id, folder, from, to, subject, delivery_state,
provider, thread_id, message_id, received_at, created_at` (+ bodies
when requested).

## Mailbox choice (summary)

- **Sending:** `mailbox_id` in the send body chooses which mailbox
  the mail comes FROM; omit it for the workspace default (first
  mailbox from `GET /api/v1/mailboxes`).
- **Listing:** `mailbox_id` in the query filters to one mailbox; omit
  it to see all mailboxes together.
- **Finding IDs:** `GET /api/v1/mailboxes` returns every mailbox with
  its ID and address. Never guess an ID — a `mailbox_id` that is not
  yours is a 403.

## AI-agent flow

1. Key with both scopes (`send` + `messages:read`). Give the agent
   its own labelled key so you can revoke just that key.
2. Poll `GET /api/v1/messages?delivery_state=received&include_body=true`
   (once a minute is plenty — the list limit is 120/min).
3. Reply with `POST /api/v1/send` carrying the inbound message's
   `thread_id` and `message_id` (as `in_reply_to`) so the reply stays
   in-thread.
4. Poll again — the reply shows as `delivery_state=accepted`, and any
   customer follow-up arrives as `delivery_state=received`.

```bash
# 1. Poll for new inbound mail (every minute or so)
curl "https://workmail-delta.vercel.app/api/v1/messages?delivery_state=received&limit=20&include_body=true" \
  -H "Authorization: Bearer WM_LIVE_KEY"

# 2. Reply in-thread: thread_id and message_id come from the listed
#    message in step 1.
curl -X POST https://workmail-delta.vercel.app/api/v1/send \
  -H "Authorization: Bearer WM_LIVE_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "to": "customer@example.com",
    "subject": "Re: Do you deliver to Pune?",
    "text": "Hi, yes — we deliver to Pune in 2–3 days.",
    "thread_id": "thread-id-from-step-1",
    "in_reply_to": "inbound-message-id"
  }'
```

```js
const API_KEY = "WM_LIVE_KEY"; // replace with your key
const BASE_URL = "https://workmail-delta.vercel.app";

async function workmail(path, options) {
  const res = await fetch(BASE_URL + path, {
    ...(options || {}),
    headers: {
      "Authorization": "Bearer " + API_KEY,
      ...((options && options.headers) || {})
    }
  });
  return { status: res.status, data: await res.json() };
}

// 1. Poll for new inbound mail
const inbox = await workmail("/api/v1/messages?delivery_state=received&limit=20&include_body=true");
const inbound = inbox.data.messages[0];
if (inbound) {
  // 2. Reply in-thread
  const reply = await workmail("/api/v1/send", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      to: inbound.from,
      subject: "Re: " + inbound.subject,
      text: "Hi, yes — we deliver to Pune in 2–3 days.",
      thread_id: inbound.thread_id,
      in_reply_to: inbound.message_id
    })
  });
  console.log(reply.status, reply.data);
}
```

## Errors

Every error is a JSON body like `{"error": "…reason…"}` with an HTTP
status. What each status means in plain words, and what to do:

| Status | Meaning | What to do |
|---|---|---|
| 400 | Something in the request is wrong — a missing or invalid field (bad email, empty subject, bad base64, disallowed attachment type, unknown `delivery_state`, or an unknown template variable). The response names the problem. | Fix the field the error names and try again. Nothing was sent. |
| 401 | Key missing, malformed, revoked, or expired. Session cookies and other tokens are never accepted here. | Check the `Authorization: Bearer …` header. Create a new key in Settings → API keys if yours was revoked or expired. |
| 403 | Key is valid but lacks the scope for this endpoint, or the `mailbox_id` does not belong to the key's workspace. | Create a key with the right scope, or get the mailbox ID from `GET /api/v1/mailboxes`. Do not guess IDs. |
| 404 | Something referenced was not found — e.g. an attachment ID that does not belong to your workspace, or a wrong URL. | Check the ID / URL. A foreign ID and a nonexistent ID give the same 404 on purpose, so you cannot probe for other workspaces' data. |
| 409 | The request conflicts with the current state: recipient suppressed, monthly sending limit reached, domain not verified, or an idempotency key reused with different content. | Read the error text: remove the recipient from suppression (or pick another), wait for next month, verify the domain, or use a fresh idempotency key. Retrying the same request will not help. |
| 413 | Too big — request body over 2 MB, or attachments over the caps (1 MB total, 2 MB per file). | Shrink the mail: smaller attachments, or fewer of them. Nothing was sent. |
| 429 | Per-key rate limit — too many requests too fast. The response carries a `Retry-After` header with the seconds to wait. | Wait the `Retry-After` seconds, then retry. See the limits below. |
| 202 | Not an error, but not a success either: the provider timed out, so WorkMail does not know whether the mail went out. | Do NOT resend blindly — check `GET /api/v1/messages` for the delivery state first, or the mail may go out twice. |
| 502 | All configured providers rejected the send (or an attachment could not be stored/read). Nothing was delivered. | Check provider setup in Settings (enabled, sender verified). You may retry later with a new idempotency key — no duplicate can result, because nothing was accepted. |

## Rate limiting and caps — stated honestly

Nothing here is unlimited.

| Limit | Value | At the cap |
|---|---|---|
| Send rate (per API key) | 30 sends / minute | 429 with `Retry-After` — wait and retry. |
| List / mailbox rate (per API key) | 120 requests / minute | 429 with `Retry-After` — wait and retry. |
| Monthly sends (per workspace) | 300 sends / month | Further sends rejected with 409 until next month. |
| SendPulse (free plan) | 50 / hour, 400 / day, 1 MB max message size | Auto mode falls through to the next provider; a manual SendPulse pick is rejected once capped. |
| Brevo (free plan) | 300 / day | Same fallback behaviour. |
| Mailjet (free plan) | 200 / day | Same fallback behaviour. |
| Resend (free plan) | 100 / day | Same fallback behaviour. |
| Attachments via the API | 1 MB total per mail, 2 MB per file, max 10 files | 413 — nothing is sent. |
| Request body | 2 MB | 413 — nothing is sent. |

D1-backed per-key sliding windows (`lib/rate-limit.ts`,
`api_key_rate_limits` table, decision D7). If the limiter itself
fails, it fails open (logs and allows) so a limiter outage never
blocks legitimate sends. Phase 3a extends the same interface to
other scopes (`auth`, `mfa`, `send`, `write`).

Polling tip for AI agents: checking for new mail once a minute stays
far below the 120/minute list limit. Do not poll every second.

## Tenant isolation

- `lib/api-auth.ts` resolves the workspace from the key hash; every
  v1 query is scoped `WHERE workspace_id = ?` to that workspace.
- Cross-workspace mailbox ids get the same 403 as nonexistent ones.
- `tests/tenant-isolation.sql` §(d) checks the `api_keys` schema half
  (workspace_id column, unique key_hash index); the API half is the
  live check in PRODUCTION-PLAN.md §9 V7: a key from workspace A
  gets 401/403 on workspace B's data, never rows.
