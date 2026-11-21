# Bulk messaging

Send one templated message to a list of recipients from a CSV/XLSX upload,
through the existing provider fallback chain (SendPulse → Brevo → Mailjet →
Resend). Bulk never has its own SMTP/provider code: every recipient send goes
through the shared pipeline (`lib/service-send.ts` `executeSend`), so
idempotency, suppression, per-provider caps, the monthly limit, and the
timeout = `unknown` rule all apply exactly as they do for single sends.

## Flow

1. **Upload** (`/bulk` → `POST /api/bulk/parse`): CSV or XLSX, max 5 MB.
   The first row must be headers — `email` required, `name` optional, any
   other column becomes a `{{placeholder}}`. Only the first worksheet of an
   XLSX is read. `.xls` (binary BIFF) is not supported.
2. **Preview**: valid / invalid / duplicates-removed / suppressed-excluded
   counts, the first 10 valid recipients, unknown `{{placeholders}}` in the
   subject/body (flagged, never blocking — they render empty), and the
   workspace's remaining monthly sends.
3. **Compose**: one subject + text and/or HTML body with `{{name}}` /
   `{{field}}` placeholders. A live sample render for the first recipient
   is shown before anything is created.
4. **Create** (`POST /api/bulk/campaigns`): a `draft` campaign + one
   `bulk_recipients` row per valid recipient. The server re-validates
   emails, dedupes, and re-checks suppression — the preview cannot be
   bypassed with a hand-crafted request.
5. **Start** (`POST /api/bulk/campaigns/[id]/start`) → `sending`.
6. **Progress** (`GET /api/bulk/campaigns/[id]`, polled every 2s by the UI):
   sent / failed / skipped / unknown / pending counts plus a page of
   per-recipient rows (provider, error, attempts, sent_at).
7. **Stop** (`POST /api/bulk/campaigns/[id]/stop`) → `stopped`. Already-sent
   recipients stay `sent`; the rest stay `pending`.

## How sending actually runs (tick model)

Vercel functions have no background worker, so a campaign does **not** run
to completion inside one request. `advanceCampaign()` in `lib/bulk.ts`
processes at most `BULK_TICK_SIZE` (10) pending recipients per call. The
start route runs one tick; the status route runs one tick on every poll
while the campaign is `sending`. The UI's 2-second polling loop is what
drives the campaign forward. If polling stops (tab closed), sending pauses
where it is — nothing is lost, and the next poll or a resume picks up the
pending recipients. A 500-recipient campaign takes roughly 50 ticks
(~2 minutes of open-tab polling at 10 recipients per 2s poll).

## Safety

- **Per-campaign cap: 500 recipients** (free tier). Enforced in
  `POST /api/bulk/parse` and again in `POST /api/bulk/campaigns`.
- **Suppression / unsubscribes**: addresses in the workspace
  `suppressions` table (hard bounce, complaint, unsubscribe, manual) are
  excluded at preview, re-checked immediately before every send, and
  checked a third time by the fallback engine before each provider
  attempt. They never receive mail.
- **Duplicates**: case-insensitive, keep-first, removed at preview and
  again at create.
- **From address**: only the workspace's own active mailboxes, and only
  with send permission (`canAccessMailbox`, write). A mailbox id from
  another workspace is rejected.
- **Idempotency**: every recipient send uses its own deterministic key —
  `bulk:` + sha256(campaignId + `:` + lowercased email). A stop/resume or
  a crash-replay can never deliver a duplicate: if a send was accepted
  but the recipient row was never marked, the resume replays the same key
  and `executeSend` returns `duplicate`, recorded as `sent`.
- **Unknown outcomes**: a provider timeout is recorded per-recipient as
  `unknown` and is **never** blindly resent. Reconciliation is via the
  delivery webhook / `POST /api/ops/reconcile`, same as single sends.
- **Cap pauses**: if every provider is at its free-tier cap (or no
  provider is configured, or the workspace monthly limit is hit), the
  campaign pauses cleanly as `paused_caps` with a `pause_reason`. The
  recipient that triggered the pause stays `pending`. Resume from
  `/start` after a cap window resets, a provider is connected, or the
  monthly limit resets. Resume only processes `pending` recipients —
  sent ones are never re-sent, failed ones are not retried.
- **Start rate limit**: 5 campaign starts per workspace per rolling hour
  (in-memory, per instance — same approximation caveat as
  `middleware.ts`). One `sending` campaign per workspace at a time.
- **Monthly quota**: each accepted bulk send counts against the workspace
  `monthly_send_limit` (default 300) exactly like a single send. The
  create response warns when the campaign is larger than the remaining
  quota.
- **Stop is terminal**: a `stopped` campaign cannot be resumed. To mail
  the remaining recipients, create a new campaign from the pending list.

## Placeholders

- Any column name may be used: `{{name}}`, `{{company}}`, `{{city}}`, …
- Matching is case-insensitive; `{{ Name }}` with spaces works.
- A missing field renders as empty — never a crash, never a blocked send.
- `{{email}}` and `{{name}}` are always available.
- Unknown placeholders (no such column) are flagged in the preview and
  in the compose step; they render empty.

## Limits of the parser

- XLSX: shared strings + inline strings + numbers/booleans/formula
  strings. Excel date serials render as their raw number — use a text
  column for dates if the exact display matters.
- CSV: quoted fields, `""` escapes, CRLF/LF/CR endings, UTF-8 BOM.

## Database

`bulk_campaigns` + `bulk_recipients` — see
`~/workspace/workmail-audit/bulk-migration.sql` (applied by the
coordinator to live D1; `db/schema.sql` was not touched). Statuses:
campaign `draft | sending | paused_caps | stopped | completed | failed`;
recipient `pending | sent | failed | skipped | unknown`. Recipient rows
have no `stopped` status on purpose — a stop leaves them `pending`.

## Files

- `lib/bulk.ts` — CSV/XLSX parsing, validation, templating, runner,
  rate limit, quota helper.
- `app/api/bulk/parse/route.ts` — upload + preview.
- `app/api/bulk/campaigns/route.ts` — list + create.
- `app/api/bulk/campaigns/[id]/route.ts` — status (+ tick-on-poll).
- `app/api/bulk/campaigns/[id]/start/route.ts` — start / resume.
- `app/api/bulk/campaigns/[id]/stop/route.ts` — stop.
- `app/bulk/page.tsx` — Bulk send UI.
