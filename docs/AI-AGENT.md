# WorkMail AI Agent

The AI agent drafts email text, and — when the per-mailbox auto-reply
toggle is explicitly ON — it also **sends** the auto-reply it drafted.
Manual drafts never send on their own: every draft lands in the drafts
folder and the human-review queue, and a human presses Send (which goes
through `/api/send` with the user's session). Auto-replies go through
the same `/api/send` pipeline via the internal service-authenticated
send path (`lib/service-send.ts`), so they obey the same idempotency,
suppression, caps, and timeout rules as a human send.

## What it does

- **AI-drafted compose** — in the compose window, type an instruction
  ("Confirm receipt and ask for the invoice"), press **✦ AI draft**. The
  draft fills the body for review; Send still goes through `/api/send`.
- **AI reply drafts** — in the inbox reader, press **✦ AI reply** on any
  message. A reply draft is created (To = original sender, Subject = Re: …)
  and queued for review.
- **Auto-reply (per mailbox, default OFF)** — sidebar toggle "✦ Auto-reply".
  When ON, each inbound message gets an AI reply draft auto-generated
  and then actually **transmitted** via the service send path (same
  provider fallback engine as `/api/send`); the queue entry is marked
  `sent` with provider + timestamp. When OFF (or when no setting
  exists), inbound mail triggers nothing AI-related. Auto-send is
  rate-limited: max 1 auto-reply per inbound message (deterministic
  idempotency key), and never a second auto-reply to the same thread in
  a row — later inbound mail in an already-auto-replied thread is
  drafted + queued for human review only. Auto-replies are also never
  sent to the mailbox itself, to suppressed recipients, or past the
  workspace monthly send limit / provider caps.
- **Human-review queue** — pending AI drafts for the selected mailbox are
  listed in the sidebar with **Send** (sends via `/api/send` with the user's
  session, then marks the queue item `sent`) and **×** (discards the draft
  to trash). Entries the agent auto-sent already show `sent` with the
  provider that delivered them.

## What it does NOT do (honest limits)

- **Autonomous transmission IS live — for auto-reply only, and only
  when the toggle is ON.** `POST /api/send` accepts a service-authenticated
  branch (`Authorization: Bearer <OPS_CRON_TOKEN>`, header only, never a
  query string) for requests with `service_context: 'ai-auto-reply'` and
  a `mailbox_id`; the same shared pipeline (`lib/service-send.ts`
  `executeSend`) runs for user and service sends alike. The in-process
  auto-reply hook (`maybeAutoReply`, called from `/api/inbound`) uses
  that same pipeline directly — no HTTP hop, no token in transit — from
  behind the already-authenticated inbound webhook. A forged or missing
  service token is 401; a valid token with any other service context is
  also 401. Manual AI drafts (compose / reply buttons) still never send
  on their own.
- **Guardrails that still bind every auto-send:** toggle OFF or AI
  unconfigured = draft queued only, nothing transmitted. One auto-reply
  per inbound message (deterministic idempotency key
  `ai-auto-reply:<messageId>`); no second auto-reply to the same thread
  in a row; no reply to the mailbox itself; suppression, monthly send
  limit, and per-provider caps all still enforced. A provider timeout
  is outcome `unknown`, never `failed`: the idempotency key is marked
  `unknown`, the queue entry stays pending, the thread is marked so
  nothing resends blindly, and reconciliation happens via
  `/api/ops/reconcile` — exactly as on the user path.
- No fake output: if the AI provider is not configured or rejects a call,
  the endpoints return HTTP 503 with a clear message and no draft text is
  invented. The UI shows that state ("AI: not configured").
- No new mail features beyond drafting: no auto-filing, no spam decisions,
  no contact creation.

## Provider — what the manual says

The Production Readiness Manual names **no AI provider at all** (no AI
section, no model, no key). The repo's own free-stack research note
(`docs/FREE-STACK-RESEARCH-2026-11-20.md`) names **Cloudflare Workers AI**
for lightweight assist features, with BYOK model-provider support as an
option. That is what is implemented, in this priority order:

1. **BYOK (optional)** — if `AI_PROVIDER_API_KEY` is set, the agent calls
   an OpenAI-compatible `chat/completions` endpoint:
   `AI_PROVIDER_BASE_URL` (default `https://api.openai.com/v1`),
   `AI_PROVIDER_MODEL` (default `gpt-4o-mini`).
2. **Cloudflare Workers AI (default, free tier)** — 10,000 Neurons/day, no
   card. Uses the host credentials already configured for D1/KV:
   `CLOUDFLARE_ACCOUNT_ID` + `CLOUDFLARE_API_TOKEN`, model
   `@cf/meta/llama-3.1-8b-instruct` (override with `AI_MODEL`).
   **Caveat:** the Cloudflare API token must carry Workers AI permission.
   The D1/KV token was created with D1 + KV permissions only, so if draft
   calls return 503 "Workers AI rejected the request (HTTP 403)", add
   Workers AI permission to that token (Cloudflare dashboard → API Tokens)
   or set `AI_PROVIDER_API_KEY` instead. No new key is required if the
   token already has (or is given) Workers AI permission.

### Env vars (names only — never commit values)

| Var | Required? | Purpose |
| --- | --- | --- |
| `CLOUDFLARE_ACCOUNT_ID` | Yes (default path; already a host var) | Workers AI account |
| `CLOUDFLARE_API_TOKEN` | Yes (default path; already a host var) | Workers AI calls (needs Workers AI permission) |
| `AI_MODEL` | No | Workers AI model id override |
| `AI_PROVIDER_API_KEY` | No (BYOK only) | OpenAI-compatible provider key |
| `AI_PROVIDER_BASE_URL` | No (BYOK only) | OpenAI-compatible base URL |
| `AI_PROVIDER_MODEL` | No (BYOK only) | BYOK model name |
| `OPS_CRON_TOKEN` | Yes (already a host var) | Service token for the `/api/send` auto-reply branch (`Authorization: Bearer`, header only). No new var — reuse the existing host secret. |

**Exact env key still needed, if any:** none, strictly — the default path
reuses the existing Cloudflare host credentials, and auto-send reuses the
existing `OPS_CRON_TOKEN` host secret. The optional BYOK key
name is `AI_PROVIDER_API_KEY`.

## API

All AI routes require a signed-in session (`requireUser`); mailbox access is
checked with `canAccessMailbox` (write) and the auto-reply toggle additionally
requires workspace `owner`/`admin`. Exception: the `/api/send` service branch
for AI auto-reply (see below) authenticates with the `OPS_CRON_TOKEN`
Bearer header instead of a session — it is not an AI route, it is the send
route's service entry point.

| Route | Method | Purpose |
| --- | --- | --- |
| `/api/ai/status` | GET | `{configured, provider, model, prompt_version, auto_send, reason}` — 200 always; `configured: false` is a normal state. NOTE: the status route still hardcodes `auto_send: false` (outside this slice's file ownership) — coordinator follow-up: flip it to `true`, since auto-send is live as described above. |
| `/api/ai/draft-compose` | POST | `{workspace_id, mailbox_id, to, subject?, instruction}` → draft + queue entry (pending) |
| `/api/ai/draft-reply` | POST | `{message_id, instruction?}` → reply draft + queue entry (pending) |
| `/api/ai/auto-reply` | GET | `?mailbox_id=` → `{auto_reply: {enabled,…}, queue: […]}` |
| `/api/ai/auto-reply` | POST | `{mailbox_id, enabled}` toggle (owner/admin); or `{action: 'approve'\|'discard'\|'sent', draft_id, workspace_id, provider?}` queue review — `'sent'` records `provider` + `sent_at` on the queue entry |

Errors: 503 `AI_NOT_CONFIGURED` (with the exact env var to set) or 503
`AI_PROVIDER_ERROR` (provider rejection, e.g. missing Workers AI
permission). No draft is created on error.

## Storage (no schema change)

- Drafts: D1 `messages` rows, `folder = 'drafts'`, same shape as
  `/api/drafts` — so drafts show up in the Drafts folder normally.
- Auto-reply settings: KV `ai:auto-reply/<mailbox_id>` —
  `{enabled, updated_at, updated_by}`. Absent = OFF.
- Review queue: KV `ai:queue/<workspace_id>` — JSON array (max 200) of
  `{draft_id, source_message_id, mailbox_id, to, subject, auto, status,
  created_at, provider?, sent_at?}`; status `pending | approved | sent |
  discarded`. Auto-sent entries carry `status: 'sent'` plus the
  delivering `provider` and `sent_at` timestamp.
- Auto-reply thread guard: KV `ai:auto-reply-thread/<mailbox_id>/<sha256>`
  — `{source_message_id, draft_id, provider, sent_at}` marking a thread
  that already received one auto-reply (accepted or `unknown`).
- AI action log: KV `ai:log/<workspace_id>/<YYYY-MM-DD>` — last 200
  entries/day, mirrored (ids only) into D1 `audit_events`.

## Guardrails

- The agent never sends on its own, except the auto-reply path: only
  when the per-mailbox toggle is explicitly ON, and only through the
  service send (`lib/service-send.ts`), which enforces the same
  idempotency, suppression, caps, and timeout=unknown rules as a human
  send. Manual drafts always wait for a human Send.
- Auto-reply drafts are generated only when the per-mailbox toggle is
  explicitly ON. No global switch exists.
- Prompts never include secrets, tokens, or provider credentials. The
  system prompt (`lib/ai.ts`, `AI_PROMPT_VERSION = 'v1'`) forbids
  inventing facts/dates/prices/commitments and requires a
  `[NEEDS HUMAN INPUT]` marker where the answer is unknowable.
- Logs carry metadata only (prompt version, model, provider, mailbox id,
  message id, draft id, action). Message bodies are never logged.
- Input is truncated (6,000 chars of original mail, 4,000 chars of
  instruction); output is capped at 800 tokens, temperature 0.3.
- The inbound hook (`maybeAutoReply`, called from `/api/inbound`) is
  wrapped so it can never change inbound acceptance: any AI failure
  leaves the 202 response untouched.
- KV write budget note: each auto-drafted inbound mail costs ~2 KV
  writes (queue + log) against the free tier's 1,000 writes/day; the
  toggle defaults OFF, so this only accrues on mailboxes where the owner
  turned it on.

## Files

- `lib/ai.ts` — provider client, prompts, guardrails, KV settings/queue/
  log helpers, `saveAiDraft`, `maybeAutoReply` (inbound hook — drafts
  AND auto-sends when the toggle is ON, with the per-message idempotency
  and per-thread guards).
- `lib/service-send.ts` — service-token validation (timing-safe,
  `Authorization: Bearer` header only) + the shared send executor used
  by both the user-session and service branches of `/api/send`, and by
  `maybeAutoReply` in-process.
- `app/api/send/route.ts` — user-session path (unchanged) + service-auth
  branch for AI auto-reply sends.
- `app/api/ai/status/route.ts`, `app/api/ai/draft-reply/route.ts`,
  `app/api/ai/draft-compose/route.ts`, `app/api/ai/auto-reply/route.ts`
- `app/api/inbound/route.ts` — additive hook only (stores the message id,
  calls `maybeAutoReply` in try/catch after the usage counter).
- `app/page.tsx` — "✦ AI draft" in compose, "✦ AI reply" in the reader,
  AI status + auto-reply toggle + review queue in the sidebar.
- `docs/AI-AGENT.md` — this file.

## Training — "Train AI agent for your business"

The owner teaches the agent about their business from **Settings →
"Train AI agent for your business"**: business name and what it does,
products/services, FAQs, tone/style, do's and don'ts, and sample
replies. Entries are added by pasting text or uploading a `.txt`, `.md`,
or `.csv` file (parsed server-side: `.txt`/`.md` split into sections,
`.csv` reads `question,answer` columns — or first-cell = question,
rest = answer when there is no header). No new npm dependency.

### Storage (no schema change)

- KV `ai:training/<workspace_id>/entries` — one JSON array (max 100
  entries) of `{id, kind, title, content, source, filename, created_by,
  created_at, updated_at}`. Kinds: `profile | product | faq | tone |
  rule | sample_reply | document`. Follows the existing single-key
  JSON-array pattern of `ai:queue/<workspace_id>`.
- Training is workspace-scoped: the key embeds the workspace id, every
  route checks workspace membership (writes additionally require
  owner/admin), and retrieval only ever reads the caller's own
  workspace key — another tenant's training can never leak into a
  prompt. `lib/ai-training.ts` owns all access.

### How the agent uses it

- `generateDraftText(prompt, {workspaceId, inboundText})` (lib/ai.ts)
  loads the workspace's training via `buildTrainingContext` and appends
  it to the system prompt as a bounded block (max 4,000 chars). Profile
  / tone / rule entries are always included first (they define the
  voice); FAQ / product / sample-reply / document entries are ranked by
  keyword overlap with the inbound message. The block tells the model
  to answer in the business's voice and to use only the trained facts,
  falling back to `[NEEDS HUMAN INPUT]` for anything not in the
  training. Prompt version is `v2` (v1 was the untrained prompt).
- This applies to **draft replies, draft compose, and auto-replies**:
  the inbound auto-reply hook (`maybeAutoReply`) passes its workspace
  id and the inbound subject + body, so auto-sent replies use the
  training too. A training-load failure never breaks drafting — the
  plain base prompt is used instead.
- Training usage is logged as metadata only: `training_used:
  {count, entry_ids}` on the `ai.training_*` and `ai.auto_reply_drafted`
  KV log entries (and the audit mirror). No training content and no
  message body is ever logged.
- **Test box ("Ask the agent")** — `POST /api/ai/training/test`
  takes `{workspace_id, message, subject?, from?}` (auth + workspace
  membership required) and returns `{draft, model, provider,
  training_used: {entries, entry_ids, chars, total_entries}, saved:
  false, sent: false}`. The draft is shown in Settings for review
  only: it is **never saved as a draft, never queued, and never sent**
  — the route has no send path at all. Drafts made from the inbox /
  compose still go through the existing review queue and the user send
  path (`/api/send`).

### Guardrails

- **No credentials in training.** Every create/update (and every
  uploaded chunk) is scanned for API keys, tokens, passwords, and
  private-key blocks (`findSecretInText`); a match is rejected with
  HTTP 400 `TRAINING_SECRET_REJECTED` naming the pattern — the matched
  value is never echoed, logged, or stored. Training text itself is not
  a secret.
- Limits: 100 entries per workspace, 20,000 chars per entry, 50
  entries / 200,000 chars per upload, 4,000 chars injected per prompt.
- API: `GET /api/ai/training?workspace_id=` (list, any member);
  `POST` (add one pasted entry, or `upload_text` + `filename`, or
  multipart `file` + `workspace_id`; owner/admin); `PATCH` (edit,
  re-scanned); `DELETE` (owner/admin). `GET /api/ai/status?
  workspace_id=` additionally reports `training: {entries,
  has_profile, updated_at}`.
