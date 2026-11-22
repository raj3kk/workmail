-- WorkMail Phase 2 — Integration API keys (migration 0002).
--
-- Table `api_keys`: per-workspace, hashed, scoped, revocable API keys
-- for the public v1 API (POST /api/v1/send, GET /api/v1/messages).
-- Only the SHA-256 hash is stored; the plaintext key (wm_live_...) is
-- shown ONCE at creation and is never stored, logged, or returned by
-- any GET. See PRODUCTION-PLAN.md §5 / decision D4.
--
-- Table `api_key_rate_limits`: D1-backed per-key sliding-window
-- counters used by lib/rate-limit.ts for the v1 routes (decision D7:
-- D1-backed, not KV-backed, not in-memory-only). Phase 3a extends
-- lib/rate-limit.ts for other scopes; it must NOT drop or rename this
-- table — its own migration (0003) creates its tables with
-- CREATE TABLE IF NOT EXISTS.
--
-- Apply one statement at a time via the D1 /query endpoint
-- (the /batch endpoint 404s on this account).

CREATE TABLE IF NOT EXISTS api_keys (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  label TEXT NOT NULL DEFAULT '',
  key_prefix TEXT NOT NULL,
  key_hash TEXT NOT NULL,
  scopes TEXT NOT NULL DEFAULT '["send"]',
  created_by TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  last_used_at TEXT,
  expires_at TEXT,
  revoked_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS api_keys_key_hash_unique ON api_keys(key_hash);
CREATE INDEX IF NOT EXISTS api_keys_workspace_idx ON api_keys(workspace_id, created_at DESC);

CREATE TABLE IF NOT EXISTS api_key_rate_limits (
  scope TEXT NOT NULL,
  subject_key TEXT NOT NULL,
  window_start INTEGER NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (scope, subject_key, window_start)
);
