-- WorkMail Phase 3a — Security hardening (migration 0003).
--
-- Table `webhook_tokens`: per-workspace delivery-webhook tokens (G-01,
-- decision D6). The old single shared DELIVERY_WEBHOOK_TOKEN is retired:
-- the delivery webhook now derives the workspace from the token and
-- rejects a mismatched workspace_id in the body, so a token from
-- workspace A can never write delivery events for workspace B.
--   - Format: `wm_hook_<43 base64url chars>` (32 random bytes).
--     The full token is shown ONCE at creation; only its SHA-256 hash
--     is stored in `webhook_tokens.token_hash`. No GET ever returns a
--     token value. Same shape as `api_keys` (Phase 2, decision D4) but
--     a separate table, so the v1 key surface stays clean.
--   - One token is scoped to exactly one workspace. Rotate = create a
--     new token + revoke the old one. Revoke = instant.
--
-- MFA lockout (G-04) reuses the existing `api_key_rate_limits` table
-- (migration 0002) with scope 'mfa' — see lib/rate-limit.ts
-- recordFailure/failureCount/clearFailures. No new table needed.
--
-- Apply one statement at a time via the D1 /query endpoint
-- (the /batch endpoint 404s on this account).

CREATE TABLE IF NOT EXISTS webhook_tokens (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  label TEXT NOT NULL DEFAULT '',
  token_prefix TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  created_by TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  last_used_at TEXT,
  expires_at TEXT,
  revoked_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS webhook_tokens_token_hash_unique ON webhook_tokens(token_hash);
CREATE INDEX IF NOT EXISTS webhook_tokens_workspace_idx ON webhook_tokens(workspace_id, created_at DESC);
