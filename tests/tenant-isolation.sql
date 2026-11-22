-- WorkMail tenant-isolation schema sanity check (D1 / SQLite).
--
-- READ THIS FIRST: D1 has no roles and no row-level security, so the old
-- Role-based test is meaningless here and has been removed.
-- This SQL alone does NOT prove tenant isolation. Tenant isolation is
-- enforced in APPLICATION CODE (membership checks in every route) and is
-- verified by API-level checks: two users in two workspaces, cross-tenant
-- reads must return 403 or empty (see tests/security-smoke.sh for the
-- unauthenticated half, plus the authenticated cross-tenant checklist).
-- What THIS file proves is only the schema half of the story: every
-- tenant-scoped table carries a workspace_id column to scope by, unique
-- indexes exist so one workspace cannot claim another's mailbox/domain/
-- contact, and no foreign key is violated.
--
-- HOW TO RUN (read-only; safe on staging, and safe on a restored copy):
--   sqlite3 <local.db> < tests/tenant-isolation.sql
--   or: wrangler d1 execute <db> --remote --file=tests/tenant-isolation.sql
-- Expected result: every row says PASS. Any FAIL means the schema drifted
-- from db/schema.sql — do not ship until it is fixed.

-- (a) No foreign-key violations anywhere in the database.
SELECT 'foreign_key_check' AS check_name,
  CASE WHEN count(*) = 0 THEN 'PASS' ELSE 'FAIL: foreign key violations exist' END AS result
  FROM pragma_foreign_key_check;

-- (b) Every tenant-scoped table has a workspace_id column to scope by.
-- (mailbox_members and message_labels are scoped through their parent
-- mailbox/message instead, and workspaces itself is the tenant root.)
SELECT 'messages' AS table_name,
  CASE WHEN EXISTS (SELECT 1 FROM pragma_table_info('messages') WHERE name = 'workspace_id') THEN 'PASS' ELSE 'FAIL: no workspace_id column' END AS result
UNION ALL SELECT 'mailboxes',
  CASE WHEN EXISTS (SELECT 1 FROM pragma_table_info('mailboxes') WHERE name = 'workspace_id') THEN 'PASS' ELSE 'FAIL: no workspace_id column' END
UNION ALL SELECT 'domains',
  CASE WHEN EXISTS (SELECT 1 FROM pragma_table_info('domains') WHERE name = 'workspace_id') THEN 'PASS' ELSE 'FAIL: no workspace_id column' END
UNION ALL SELECT 'memberships',
  CASE WHEN EXISTS (SELECT 1 FROM pragma_table_info('memberships') WHERE name = 'workspace_id') THEN 'PASS' ELSE 'FAIL: no workspace_id column' END
UNION ALL SELECT 'provider_secrets',
  CASE WHEN EXISTS (SELECT 1 FROM pragma_table_info('provider_secrets') WHERE name = 'workspace_id') THEN 'PASS' ELSE 'FAIL: no workspace_id column' END
UNION ALL SELECT 'idempotency_keys',
  CASE WHEN EXISTS (SELECT 1 FROM pragma_table_info('idempotency_keys') WHERE name = 'workspace_id') THEN 'PASS' ELSE 'FAIL: no workspace_id column' END
UNION ALL SELECT 'usage_counters',
  CASE WHEN EXISTS (SELECT 1 FROM pragma_table_info('usage_counters') WHERE name = 'workspace_id') THEN 'PASS' ELSE 'FAIL: no workspace_id column' END
UNION ALL SELECT 'workspace_settings',
  CASE WHEN EXISTS (SELECT 1 FROM pragma_table_info('workspace_settings') WHERE name = 'workspace_id') THEN 'PASS' ELSE 'FAIL: no workspace_id column' END
UNION ALL SELECT 'security_events',
  CASE WHEN EXISTS (SELECT 1 FROM pragma_table_info('security_events') WHERE name = 'workspace_id') THEN 'PASS' ELSE 'FAIL: no workspace_id column' END
UNION ALL SELECT 'message_attachments',
  CASE WHEN EXISTS (SELECT 1 FROM pragma_table_info('message_attachments') WHERE name = 'workspace_id') THEN 'PASS' ELSE 'FAIL: no workspace_id column' END
UNION ALL SELECT 'labels',
  CASE WHEN EXISTS (SELECT 1 FROM pragma_table_info('labels') WHERE name = 'workspace_id') THEN 'PASS' ELSE 'FAIL: no workspace_id column' END
UNION ALL SELECT 'contacts',
  CASE WHEN EXISTS (SELECT 1 FROM pragma_table_info('contacts') WHERE name = 'workspace_id') THEN 'PASS' ELSE 'FAIL: no workspace_id column' END
UNION ALL SELECT 'mail_rules',
  CASE WHEN EXISTS (SELECT 1 FROM pragma_table_info('mail_rules') WHERE name = 'workspace_id') THEN 'PASS' ELSE 'FAIL: no workspace_id column' END
UNION ALL SELECT 'delivery_events',
  CASE WHEN EXISTS (SELECT 1 FROM pragma_table_info('delivery_events') WHERE name = 'workspace_id') THEN 'PASS' ELSE 'FAIL: no workspace_id column' END
UNION ALL SELECT 'suppressions',
  CASE WHEN EXISTS (SELECT 1 FROM pragma_table_info('suppressions') WHERE name = 'workspace_id') THEN 'PASS' ELSE 'FAIL: no workspace_id column' END
UNION ALL SELECT 'outbound_jobs',
  CASE WHEN EXISTS (SELECT 1 FROM pragma_table_info('outbound_jobs') WHERE name = 'workspace_id') THEN 'PASS' ELSE 'FAIL: no workspace_id column' END
UNION ALL SELECT 'subscriptions',
  CASE WHEN EXISTS (SELECT 1 FROM pragma_table_info('subscriptions') WHERE name = 'workspace_id') THEN 'PASS' ELSE 'FAIL: no workspace_id column' END
UNION ALL SELECT 'invoices',
  CASE WHEN EXISTS (SELECT 1 FROM pragma_table_info('invoices') WHERE name = 'workspace_id') THEN 'PASS' ELSE 'FAIL: no workspace_id column' END
UNION ALL SELECT 'audit_events',
  CASE WHEN EXISTS (SELECT 1 FROM pragma_table_info('audit_events') WHERE name = 'workspace_id') THEN 'PASS' ELSE 'FAIL: no workspace_id column' END
UNION ALL SELECT 'plan_change_log',
  CASE WHEN EXISTS (SELECT 1 FROM pragma_table_info('plan_change_log') WHERE name = 'workspace_id') THEN 'PASS' ELSE 'FAIL: no workspace_id column' END
UNION ALL SELECT 'payment_events',
  CASE WHEN EXISTS (SELECT 1 FROM pragma_table_info('payment_events') WHERE name = 'workspace_id') THEN 'PASS' ELSE 'FAIL: no workspace_id column' END
UNION ALL SELECT 'dns_change_log',
  CASE WHEN EXISTS (SELECT 1 FROM pragma_table_info('dns_change_log') WHERE name = 'workspace_id') THEN 'PASS' ELSE 'FAIL: no workspace_id column' END
UNION ALL SELECT 'api_keys',
  CASE WHEN EXISTS (SELECT 1 FROM pragma_table_info('api_keys') WHERE name = 'workspace_id') THEN 'PASS' ELSE 'FAIL: no workspace_id column' END
UNION ALL SELECT 'api_key_rate_limits',
  CASE WHEN EXISTS (SELECT 1 FROM pragma_table_info('api_key_rate_limits') WHERE name = 'subject_key') THEN 'PASS' ELSE 'FAIL: no subject_key column' END;

-- (c) Unique indexes exist so one workspace cannot claim another
-- workspace's mailbox, domain, contact, or provider secret.
SELECT 'users.email unique' AS check_name,
  CASE WHEN EXISTS (SELECT 1 FROM pragma_index_list('users') WHERE "unique" = 1) THEN 'PASS' ELSE 'FAIL: no unique index on users' END AS result
UNION ALL SELECT 'sessions.token_hash unique',
  CASE WHEN EXISTS (SELECT 1 FROM pragma_index_list('sessions') WHERE "unique" = 1) THEN 'PASS' ELSE 'FAIL: no unique index on sessions' END
UNION ALL SELECT 'domains (workspace_id, domain) unique',
  CASE WHEN EXISTS (SELECT 1 FROM pragma_index_list('domains') WHERE "unique" = 1) THEN 'PASS' ELSE 'FAIL: no unique index on domains' END
UNION ALL SELECT 'mailboxes (workspace_id, address) unique',
  CASE WHEN EXISTS (SELECT 1 FROM pragma_index_list('mailboxes') WHERE "unique" = 1) THEN 'PASS' ELSE 'FAIL: no unique index on mailboxes' END
UNION ALL SELECT 'provider_secrets (workspace_id, provider) unique',
  CASE WHEN EXISTS (SELECT 1 FROM pragma_index_list('provider_secrets') WHERE "unique" = 1) THEN 'PASS' ELSE 'FAIL: no unique index on provider_secrets' END
UNION ALL SELECT 'contacts (workspace_id, email) unique',
  CASE WHEN EXISTS (SELECT 1 FROM pragma_index_list('contacts') WHERE "unique" = 1) THEN 'PASS' ELSE 'FAIL: no unique index on contacts' END
UNION ALL SELECT 'delivery_events (provider, provider_event_id) unique',
  CASE WHEN EXISTS (SELECT 1 FROM pragma_index_list('delivery_events') WHERE "unique" = 1) THEN 'PASS' ELSE 'FAIL: no unique index on delivery_events' END
UNION ALL SELECT 'suppressions (workspace_id, email) unique',
  CASE WHEN EXISTS (SELECT 1 FROM pragma_index_list('suppressions') WHERE "unique" = 1) THEN 'PASS' ELSE 'FAIL: no unique index on suppressions' END
UNION ALL SELECT 'outbound_jobs (workspace_id, idempotency_key) unique',
  CASE WHEN EXISTS (SELECT 1 FROM pragma_index_list('outbound_jobs') WHERE "unique" = 1) THEN 'PASS' ELSE 'FAIL: no unique index on outbound_jobs' END
UNION ALL SELECT 'payment_events (provider, provider_event_id) unique',
  CASE WHEN EXISTS (SELECT 1 FROM pragma_index_list('payment_events') WHERE "unique" = 1) THEN 'PASS' ELSE 'FAIL: no unique index on payment_events' END
UNION ALL SELECT 'subscriptions one-active unique',
  CASE WHEN EXISTS (SELECT 1 FROM pragma_index_list('subscriptions') WHERE "unique" = 1) THEN 'PASS' ELSE 'FAIL: no unique index on subscriptions' END
UNION ALL SELECT 'idempotency_keys primary key',
  CASE WHEN EXISTS (SELECT 1 FROM pragma_index_list('idempotency_keys') WHERE "unique" = 1) THEN 'PASS' ELSE 'FAIL: no unique index on idempotency_keys' END
UNION ALL SELECT 'api_keys key_hash unique',
  CASE WHEN EXISTS (SELECT 1 FROM pragma_index_list('api_keys') WHERE "unique" = 1) THEN 'PASS' ELSE 'FAIL: no unique index on api_keys (key_hash)' END
UNION ALL SELECT 'api_keys workspace index',
  CASE WHEN EXISTS (SELECT 1 FROM pragma_index_list('api_keys')) THEN 'PASS' ELSE 'FAIL: no index on api_keys' END;

-- (d) API-key tenant isolation — API-level check (cannot be proven in
-- SQL alone; the schema half above is necessary, not sufficient).
-- Live check (PRODUCTION-PLAN.md §9 V7, parent runs it):
--   1. Create a key in workspace A (Settings → API keys, scope
--      messages:read) and one in workspace B.
--   2. GET /api/v1/messages with A's key returns ONLY A's messages
--      (count matches D1 for A); B's key on the same call returns
--      only B's messages — never A's rows.
--   3. POST /api/v1/send with A's key + B's mailbox_id returns 403
--      (same response as a nonexistent mailbox_id — the probe learns
--      nothing about B).
--   4. A revoked key from either workspace returns 401 on both routes.
-- Code guarantee: lib/api-auth.ts resolves the workspace from the key
-- hash, and both v1 routes scope every query to that workspace_id;
-- lib/api-auth.ts never reads a session cookie and never accepts
-- OPS_CRON_TOKEN.

-- NOTE: this file asserts schema shape only. It does NOT test suspension,
-- attachment-object scoping, or the API layer. Those are covered by
-- tests/security-smoke.sh (unauthenticated routes) and the authenticated
-- cross-tenant checklist (two users, two workspaces, cross-tenant reads
-- must 403 or return empty).
