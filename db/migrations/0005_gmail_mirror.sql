-- Phase 4 — Gmail backup mirror (PRODUCTION-PLAN.md §7).
-- D1 stays the source of truth; Gmail gets a labelled copy via
-- users.messages.import. Dedupe is authoritative in gmail_mirror
-- (Gmail search does not reliably index custom headers).
-- Applied to live D1 one statement at a time (the /batch endpoint 404s).
-- Do NOT edit db/schema.sql — the coordinator merges migrations at the end.

CREATE TABLE IF NOT EXISTS gmail_mirror (
  d1_message_id TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
  gmail_message_id TEXT,
  gmail_thread_id TEXT,
  imported_at TEXT NOT NULL DEFAULT (datetime('now')),
  status TEXT NOT NULL DEFAULT 'imported' CHECK (status IN ('imported', 'skipped')),
  skip_reason TEXT
);

CREATE TABLE IF NOT EXISTS gmail_oauth_tokens (
  workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  refresh_token_ciphertext TEXT NOT NULL,
  google_email TEXT,
  auto_mirror INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS gmail_mirror_status_idx ON gmail_mirror(status, imported_at);
