-- WorkMail Phase 3b — data, limits, backup/export, retention (migration 0004).
--
-- Apply one statement at a time via the D1 /query endpoint (the /batch
-- endpoint 404s on this account); see ~/workspace/workmail-audit/apply_d1.py.
-- Do NOT edit db/schema.sql for this feature (coordinator merges at the end).
--
-- Contents:
--   1. delivery_events.event_type gains 'unconfigured' (G5a). SQLite cannot
--      ALTER a CHECK, so the table is recreated (same columns + UNIQUE,
--      new CHECK), data copied, old table dropped, new table renamed.
--      Backfill: the 12 live rows with event_type='unknown' whose
--      details.result='unconfigured' become 'unconfigured' (verified
--      2026-11-22: all 12 unknown rows are unconfigured attempts; true
--      timeouts = 0). Rows whose details say anything else stay 'unknown'.
--   2. workspace_settings.allow_host_provider_fallback (G-14): 0 by default.
--      Workspaces with no provider row may NOT fall back to host env keys
--      unless this is 1. The live owner workspace is set to 1 by a separate
--      one-off D1 UPDATE (not in this file — the workspace id is a live
--      environment fact, not repo content); new workspaces default to 0.
--   3. provider_secrets.sender_attested + sender_verified_via (G-25):
--      sender_verified stays the send-eligibility flag (so no live send
--      breaks during the deploy window); sender_attested marks the
--      user-asserted state and sender_verified_via ('provider' |
--      'attested') records HOW the row became verified. Existing rows
--      were all attestations (the old "I verified sender" button), so
--      they backfill to attested=1, via='attested'. Only a successful
--      "Verify now" server check sets via='provider'.
--   4. bulk_campaigns.sent_count / failed_count backfill (G5b): derived
--      from bulk_recipients (live: both campaigns 2/2 sent, stored 0/2
--      and 0/0 -> both become 2/0). lib/bulk.ts keeps them in sync on
--      every tick completion going forward.
--   5. usage_counters.storage_bytes backfill (G4): real bytes of all
--      messages + attachments stored so far for the workspace (live: 0
--      after 20 messages -> real byte count). Going forward lib/service-send
--      (send) and app/api/inbound (receive) add real bytes per message.
--      NOTE: usage_counters is keyed by period_start (monthly), so this
--      backfill lands on every existing row; the per-workspace quota check
--      in lib/storage.ts derives usage from D1 directly (message bodies
--      + attachment sizes) so it is correct regardless of period.
--   6. Retention scope (G-32/G-33): no new columns needed — the retention
--      route deletes by created_at from messages, message_attachments
--      (KV keys deleted first), delivery_events, audit_events,
--      outbound_jobs (payload column included — deleting the row deletes
--      the payload), and idempotency_keys (accepted keys kept 90 days).
--      retention_days already exists on workspace_settings (default 90).

-- 1. delivery_events: recreate with 'unconfigured' in the CHECK.
CREATE TABLE delivery_events_new (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  message_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
  provider TEXT NOT NULL,
  provider_event_id TEXT,
  event_type TEXT NOT NULL CHECK (event_type IN ('accepted','sent','delivered','deferred','bounced','complained','rejected','opened','clicked','unknown','unconfigured')),
  recipient TEXT,
  details TEXT NOT NULL DEFAULT '{}',
  occurred_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (provider, provider_event_id)
);
INSERT INTO delivery_events_new (id, workspace_id, message_id, provider, provider_event_id, event_type, recipient, details, occurred_at, created_at)
  SELECT id, workspace_id, message_id, provider, provider_event_id, event_type, recipient, details, occurred_at, created_at FROM delivery_events;
DROP TABLE delivery_events;
ALTER TABLE delivery_events_new RENAME TO delivery_events;
UPDATE delivery_events SET event_type = 'unconfigured' WHERE event_type = 'unknown' AND json_extract(details, '$.result') = 'unconfigured';

-- 2. Host provider fallback gate (G-14).
ALTER TABLE workspace_settings ADD COLUMN allow_host_provider_fallback INTEGER NOT NULL DEFAULT 0;

-- 3. Two-state sender verification (G-25).
ALTER TABLE provider_secrets ADD COLUMN sender_attested INTEGER NOT NULL DEFAULT 0;
ALTER TABLE provider_secrets ADD COLUMN sender_verified_via TEXT;
UPDATE provider_secrets SET sender_attested = sender_verified, sender_verified_via = CASE WHEN sender_verified = 1 THEN 'attested' ELSE NULL END;

-- 4. Bulk campaign counters backfill (G5b).
UPDATE bulk_campaigns SET
  sent_count = (SELECT COUNT(*) FROM bulk_recipients WHERE campaign_id = bulk_campaigns.id AND status = 'sent'),
  failed_count = (SELECT COUNT(*) FROM bulk_recipients WHERE campaign_id = bulk_campaigns.id AND status = 'failed');

-- 5. Storage-bytes backfill (G4).
UPDATE usage_counters SET storage_bytes =
  (SELECT COALESCE(SUM(LENGTH(CAST(text_body AS BLOB)) + LENGTH(CAST(html_body AS BLOB))), 0) FROM messages WHERE workspace_id = usage_counters.workspace_id)
  + (SELECT COALESCE(SUM(size_bytes), 0) FROM message_attachments WHERE workspace_id = usage_counters.workspace_id);
