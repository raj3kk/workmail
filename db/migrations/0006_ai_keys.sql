-- WorkMail E4 — AI drafting BYOK keys (migration 0006).
--
-- Table `ai_provider_keys`: the user's OWN Gemini / Groq API keys for
-- the "Draft with AI" helper (compose + bulk). Separate from the trained
-- AI agent (lib/ai.ts / auto-reply / draft-reply) — drafting only.
--
-- Keys are stored ENCRYPTED with lib/crypto.ts AES-256-GCM +
-- PROVIDER_CREDENTIAL_ENCRYPTION_KEY, exactly like provider
-- credentials. Plaintext is NEVER stored, NEVER returned by any GET,
-- NEVER put in client JS, NEVER logged. Only the last 4 characters
-- (last4) are shown in the UI. One key per (workspace, provider);
-- saving again replaces the stored key. The chosen model is stored
-- per key; if it is retired, draft calls fail naming the model
-- (no silent fallback). See PRODUCTION-PLAN.md §11.4.
--
-- Apply one statement at a time via the D1 /query endpoint
-- (the /batch endpoint 404s on this account).

CREATE TABLE IF NOT EXISTS ai_provider_keys (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider IN ('gemini', 'groq')),
  key_encrypted TEXT NOT NULL,
  model TEXT NOT NULL,
  last4 TEXT NOT NULL DEFAULT '',
  created_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (workspace_id, provider)
);
CREATE INDEX IF NOT EXISTS ai_provider_keys_workspace_idx ON ai_provider_keys(workspace_id);
