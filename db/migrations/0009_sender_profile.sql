-- WorkMail sender profile checklist (S1, §15.1) — ADDITIVE ONLY.
-- Apply one statement at a time via the D1 /query endpoint (the /batch
-- endpoint 404s on this account); see ~/workspace/workmail-audit/apply_d1.py.
-- Do NOT edit db/schema.sql for this feature (coordinator merges at the end).
--
-- sender_profile_steps: one row per mailbox per wizard step the USER has
-- ticked as done. Nothing is ever auto-checked: there is NO Google API
-- for adding an alternate email to a personal Google Account, so the app
-- cannot see the user's Google Account and cannot verify any step itself.
-- A step is done ONLY when the user ticks it in Settings → Sender profile.
-- step_key values: single source of truth is lib/sender-profile.ts
-- (SENDER_PROFILE_STEPS / SENDER_PROFILE_STEP_KEYS). Do NOT copy the
-- list anywhere else:
--   open_google_account, personal_info, email_section, alternate_emails,
--   add_address, find_verification_mail, click_verify_link,
--   approve_phone_prompt
-- Tenant isolation is enforced in application code (mailbox membership
-- checks in the checklist route); D1 has no row-level security.
CREATE TABLE IF NOT EXISTS sender_profile_steps (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  mailbox_id TEXT NOT NULL,
  step_key TEXT NOT NULL,
  done_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (workspace_id, mailbox_id, step_key)
);
CREATE INDEX IF NOT EXISTS idx_sender_profile_steps_mailbox ON sender_profile_steps (workspace_id, mailbox_id);
