# Gmail backup mirror (Phase 4)

**One-way backup copy into the owner's Gmail. D1 stays the source of truth.**

This is NOT "Gmail as WorkMail's storage". Live research
(`~/workspace/workmail-audit/PHASE0-GMAIL-RESEARCH.md` §7) proves a personal
Gmail account cannot be WorkMail's store: it cannot host `flow99.in` MX or
DKIM-sign for it, its Send-As path is removed by Google in January 2027, it
is single-user with no transactions or counters, and it caps sends at
500/day. What ships instead is the closest honest alternative (§7.3): a
one-click mirror.

## What it can do

- Copy every WorkMail message (sent + received, all mailboxes) into the
  owner's Gmail via `users.messages.import`, with original dates preserved
  (`internalDateSource=dateHeader`), `neverMarkSpam=true`, and labels
  `WorkMail`, `WorkMail/Sent` / `WorkMail/Inbox`, `WorkMail/<mailbox>` (plus
  the `SENT` / `INBOX` system labels, so copies appear in Gmail's Sent and
  Inbox views).
- Preserve subject, plain + HTML bodies, attachments (re-attached from KV),
  and threading (`Message-ID` preserved; Gmail assigns its own message id).
- Dedupe authoritatively in D1 (`gmail_mirror` table: `d1_message_id` →
  Gmail id). Re-running the backup imports **0 new messages**.
- Auto-mirror new mail (OFF by default): a best-effort hook after an
  accepted send and after inbound storage copies the message to Gmail. A
  failed copy never blocks sending or delivery.
- Survive a WorkMail/D1 loss: the mail copy persists in Gmail.
- Every export run writes a `backup_runs` row and the mirrored count is
  re-read from D1 before reporting (decision D10).

## What it cannot do

- It cannot make Gmail the store — D1 stays authoritative. AI training
  data, campaigns, billing counters, idempotency keys and audit state are
  never mirrored; they have no home in Gmail.
- It cannot send as `hello@flow99.in` with proper authentication. Gmail
  cannot DKIM-sign for `flow99.in`, and the Send-As mechanism dies in
  January 2027. **Replies from Gmail come from @gmail.com.**
- It cannot back up messages whose attachments exceed the 150 MB Gmail
  import ceiling — those are listed as skipped, with a reason, never
  silently dropped.
- It cannot give a second user access (Gmail OAuth is one person's
  mailbox), and it does not protect against the user deleting the mirrored
  copy in Gmail — the D1 original is the protection.
- It does not make WorkMail work if Google access is revoked. WorkMail
  keeps working from D1 — that is the point of the mirror direction.
  (A Google password change revokes Gmail-scope refresh tokens; the user
  must reconnect after one.)

## How it works

1. Settings → Gmail backup → **Connect Gmail backup**. The owner consents
   on Google's screen to the restricted scopes `gmail.insert` +
   `gmail.labels` on the existing GCP project (`workmail-515413`, consent
   screen already "In production", so refresh tokens do not expire after
   7 days). **These scopes are never requested at sign-in** — sign-in asks
   only for `openid email profile`.
2. The refresh token is encrypted with `lib/crypto.ts` (AES-256-GCM) and
   stored in D1 (`gmail_oauth_tokens`, workspace-scoped, owner-only). It is
   never logged, never returned to the client, and never appears in a
   response.
3. **Back up all WorkMail mail to my Gmail** imports every unmirrored
   message (25 quota units each; drafts and deleted mail are excluded).
   Progress, counts and the skipped list are shown on the page.
4. **Auto-mirror new mail** toggle (off by default). **Disconnect Gmail
   backup** revokes the Google grant and deletes the stored token; copies
   already in Gmail stay there.

## Restricted scopes + the CASA boundary

`gmail.insert` is a Google **restricted** scope. A single-user,
personal-use grant sidesteps the CASA security assessment while it stays
personal-use. **If the mirror is ever offered to other WorkMail users
through the shared OAuth client, OAuth verification and the annual paid
CASA assessment apply** — at that point the mirror must be disabled with a
clear notice until verification/CASA is complete. It is offered only to
the workspace owner, never to teammates. Do not widen the audience
without clearing that boundary first.

## Files

- `db/migrations/0005_gmail_mirror.sql` — `gmail_mirror` + `gmail_oauth_tokens`
- `lib/gmail-mirror.ts` — MIME build, import, batch + 429 backoff, auto-mirror
- `lib/gmail-oauth.ts` — separate OAuth flow, encrypted refresh-token storage
- `app/api/gmail-mirror/connect|callback|export|disconnect/route.ts`
- `app/settings/GmailMirrorSection.tsx`
