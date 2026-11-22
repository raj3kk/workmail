# WorkMail — Backup, Export & Retention (Phase 3b)

How your mail is backed up, exported, and deleted — with the honest limits.
No "unlimited" anywhere. All counts below come from D1.

## 1. User export — "Download all my mail" (G-30)

**Where:** Settings → Export & backup → "Download all my mail (.zip)".

**What you get:** a ZIP containing, for YOUR workspace only:
- `messages/<message-id>.eml` — one RFC 5322 file per message (headers + plain text, multipart with HTML when the message has HTML).
- `messages.json` — every message's metadata (from/to/subject/dates/folder + attachment name/size list), with a SHA-256 checksum in `metadata.json`.
- `metadata.json` — counts (messages, attachments, attachment bytes), export time, and the scope note.
- `attachments/<message-id>/<filename>` — the attachment bytes themselves.

**What is NOT in the ZIP (honest scope):** provider credentials, API keys,
sessions, and operational logs (delivery/audit events, outbound-job
payloads). Those are not mail. Retention (below) deletes the logs; the
credentials live encrypted in D1 and are never exported.

**Limits:**
- 100 MB per export. Over that, the server refuses with a clear message —
  pick one mailbox in Settings and export it on its own.
- 1 export every 10 minutes per workspace (429 with `Retry-After`).
  Enforced from `backup_runs` (the last user-export run for the workspace);
  when Phase 3a adds an `export` scope to `lib/rate-limit.ts`, the route
  switches to that limiter — same limit, same window.
- Owner/admin only; the export is tenant-scoped by `workspace_id`
  (+ optional `mailbox_id`). No other workspace's data can be in it.

**Verification (D10):** every export writes a `backup_runs` row
(`backup_kind = 'user_export'`, bytes, SHA-256, counts) and the ZIP is
verified server-side by re-reading its manifest (entry count + `.eml`
count) before it is handed to the browser. No backup claim without a
verification read.

**API:** `POST /api/export` `{workspace_id, mailbox_id?}` → `application/zip`
with `X-WorkMail-Export-Messages` and `X-WorkMail-Export-Sha256` headers.

## 2. Server-side backup (G-31)

The user export above IS the user backup. On top of it:

- **Counts snapshot:** `POST /api/ops/backup` (Bearer `OPS_CRON_TOKEN`,
  same pattern as `/api/ops/monitor`) snapshots live D1 counts (workspaces,
  users, messages, attachments + bytes, bulk campaigns/recipients, provider
  rows, delivery/audit events, idempotency keys, outbound jobs, storage
  counters) and writes a `backup_runs` row (`backup_kind = 'server_backup'`).
- **Encrypted artifacts:** `scripts/backup.sh` dumps D1 + KV attachment
  values and age-encrypts them. It is run by the GitHub Actions workflow
  `.github/workflows/backup.yml` (daily 02:23 UTC, artifacts kept 90 days).
  It needs `wrangler` + `age` + the Cloudflare + age secrets, which is why
  it runs in Actions, not on the Vercel app (the app holds no age key).
  Verified 2026-11-22: the script and workflow exist and are wired; they
  cannot run on this VM (`wrangler`/`age` are not installed there) — the
  workflow is the execution path.
- **Restore drill:** `scripts/restore-drill.sh` restores a dump into a
  DISPOSABLE D1 (it refuses to run against the production database id)
  and prints workspaces/messages counts. Drill run 2026-11-22 (API-based,
  same verify step — dump → disposable D1 → count comparison → delete):
  disposable database created, live schema + 160 statements loaded, and
  the restored counts matched the DUMP exactly on all 43 tables
  (messages 20, audit_events 22, delivery_events 28, idempotency_keys 14,
  and 39 other tables). Live D1 gained 3 messages during the ~8-minute
  drill window (created 03:31:30–34 UTC, after the dump was taken), which
  is why a naive live-vs-restored comparison shows +3/+3/+1/+1 on those
  four tables — verified by timestamp, not by assumption. Disposable
  database deleted afterwards. `restore-drill.sh` itself was not executed
  on this VM (it needs `wrangler` + an age identity file, neither present
  here); it is correct for its GitHub Actions context. Note the drill
  restores data, not triggers (the dump carries tables + rows only).
  KV values restore separately from the KV artifact (decrypt, untar, PUT
  each value back) — see the script header.

## 3. Retention (G-32 / G-33)

**Route:** `POST /api/ops/retention` (Bearer `OPS_CRON_TOKEN`).
Body/query: `{workspace_id?, dry_run?}` or `?dry_run=true`.

Per workspace, per `workspace_settings.retention_days` (default 90), it
deletes:
- messages older than retention + their attachments (KV bytes deleted
  first, then `message_attachments` rows) + `message_labels` for them;
- `delivery_events`, `audit_events` older than retention;
- `outbound_jobs` older than retention, plus jobs whose message is gone
  (deleting the row deletes its `payload` — G-33);
- `idempotency_keys` older than retention — EXCEPT `accepted` keys, which
  are kept 90 days for duplicate protection and only then purged.

**Dry-run first:** `?dry_run=true` returns the counts per workspace and
deletes NOTHING. Always dry-run, compare the counts with D1, then run live.
Live runs are capped (1,000 messages / 5,000 rows per table per call) and
report `truncated: true` when more remains — run again to continue.

**Cron — NOT enabled.** No cron is wired to this route (`vercel.json` has
no cron entry). The user's 19 crons are PAUSED by standing order and no
cron may be created without the user's explicit word. When the user approves
it, add exactly this to `vercel.json` (daily 03:00 IST = 21:30 UTC):

```json
{
  "crons": [
    {
      "path": "/api/ops/retention",
      "schedule": "30 21 * * *"
    }
  ]
}
```

Note: the ops route is POST + Bearer-token gated; Vercel Cron sends GET
without auth headers, so the scheduled call needs either a cron-secret
query arrangement or a tiny GET wrapper added at enablement time — do NOT
enable the cron until that is decided with the user. Until then, run the
retention route manually (dry-run first).

## 4. Storage accounting (G-4 / G-14)

- `usage_counters.storage_bytes` sums REAL bytes: message bodies (UTF-8)
  + attachment bytes, added on send (`lib/service-send.ts`) and on inbound
  (`app/api/inbound/route.ts`). Migration 0004 backfilled the historical
  total (live: 0 → 16,608 bytes for the 20 stored messages).
- Plan limit comes from `plan_catalog.storage_limit_bytes` (Free: 512 MB).
- Attachment upload (`POST /api/attachments`) is refused 413 when the
  workspace's real stored bytes + the new file would exceed the plan limit.
  The check uses the larger of the D1-derived usage and the running counter
  (`lib/storage.ts`), so an old counter can never understate usage.
- Host provider fallback (G-14): `workspace_settings.allow_host_provider_fallback`
  defaults to 0. Workspaces with no provider row do NOT fall back to host
  env keys unless it is 1. The live owner workspace keeps 1 (set by a
  one-off D1 UPDATE 2026-11-22); it already has all four provider rows, so
  no live send breaks.

## 5. Spam / Junk handling (E5-13)

Inbound mail is scored server-side in `app/api/inbound/route.ts` using the
blocklist + patterns in `lib/email-validation.ts` (`checkSpamInbound`):
a known spam sender domain, or 2+ subject/body pattern hits, moves the
message to the Junk (`spam`) folder. The matched patterns are logged
(`inbound_spam_moved`) and returned in the inbound response (`spam_moved`,
`spam_matched`). User mail filters run first and are respected — spam only
moves a message still in the inbox.

**What this is NOT:** a machine-learning classifier. There is no ML spam
classifier in WorkMail, and none is claimed. A real classifier needs
labelled training data, an inference host, and ongoing tuning — all out of
free-tier / no-card scope. The pattern blocklist + Junk move is the honest
free-tier implementation; if spam volume ever justifies it, the follow-up
is a provider-side filter (e.g. Cloudflare Email Routing rules) or a
paid classifier — not a fake "AI spam filter" in the UI.

## 6. Data-quality fixes shipped with this phase (G-5)

- `delivery_events.event_type` gained `unconfigured` (migration 0004
  recreates the table with the wider CHECK). `recordAttemptEvent()` maps
  `unconfigured` attempts to `unconfigured` instead of `unknown`. Backfill:
  12/12 `unknown` rows were unconfigured attempts (details.result =
  'unconfigured') → now `unconfigured`; accepted 13 / rejected 3 unchanged.
- `bulk_campaigns.sent_count/failed_count` are synced from
  `bulk_recipients` on every tick completion (`lib/bulk.ts`
  `syncBulkCampaignCounters`) and backfilled (both live campaigns 0/2 and
  0/0 → 2/0, matching their recipients).
- SendPulse caps: daily 400 (was unset) + the 1 MB free message-size limit
  is enforced — SendPulse is skipped for >1 MB messages with a logged
  reason and the chain falls through; never attempt-and-fail.

## 7. Sender verification — two states (G-25)

- `sender_verified` = confirmed by the provider ("Verify now" server check
  against the provider's sender/domain API — Resend domains, Brevo senders,
  Mailjet senders, SendPulse senders). A check that cannot confirm returns
  the reason and writes nothing.
- `sender_attested` = asserted by the user (the old "I verified sender in
  provider" button). Sending accepts attested OR verified — no live send
  breaks. The providers API returns `sender_state` (`verified` | `attested` |
  `unverified`) so the UI can say "Verified by provider" vs "Attested by
  you — not confirmed with provider".
- Existing rows backfilled as attestations (they were all created by the
  old button): `sender_attested = 1`, `sender_verified_via = 'attested'`.

## 8. Disposable / temp-mail blocklist (G-12)

Central list in `lib/email-validation.ts` (~100 domains, incl. the ~40
Bulk v2 carried). Applied at team invite, contacts create, and bulk CSV /
paste parse — rejected with a clear message, never silently dropped.
`lib/bulk.ts` re-exports the central list; the bulk page's client-side
mirror is feedback only, the server is the authority.
