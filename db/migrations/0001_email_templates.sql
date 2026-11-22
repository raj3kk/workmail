-- WorkMail Phase 1 — email templates (2026-11-22) — ADDITIVE ONLY.
-- Apply one statement at a time via the D1 /query endpoint (the /batch
-- endpoint 404s on this account); see ~/workspace/workmail-audit/apply_d1.py.
-- Do NOT edit db/schema.sql for this feature (coordinator merges at the end).
-- Tenant isolation is enforced in application code (membership checks in
-- every /api/templates route); D1 has no row-level security.
-- Seeded defaults are created by lib/templates.ts ensureDefaultTemplates()
-- on first Templates visit, not by this migration (no signup-path change).

CREATE TABLE IF NOT EXISTS email_templates (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  category TEXT NOT NULL CHECK (category IN ('auth', 'welcome', 'notification', 'newsletter', 'transactional')),
  subject TEXT NOT NULL DEFAULT '',
  html_body TEXT NOT NULL DEFAULT '',
  text_body TEXT NOT NULL DEFAULT '',
  variables TEXT NOT NULL DEFAULT '[]',
  is_default INTEGER NOT NULL DEFAULT 0,
  created_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS email_templates_workspace_idx ON email_templates(workspace_id, category);
CREATE UNIQUE INDEX IF NOT EXISTS email_templates_one_default_idx ON email_templates(workspace_id, category) WHERE is_default = 1;
ALTER TABLE bulk_campaigns ADD COLUMN template_id TEXT;
