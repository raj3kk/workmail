-- Migration 0010: per-provider verified sender addresses.
-- SendPulse is manual-only (owner order 2026-11-22): it accepts mail
-- ONLY from its verified sender addresses (free plan: 3). The UI offers
-- only those mailboxes when SendPulse is picked, and lib/service-send.ts
-- rejects a manual SendPulse pick from any other mailbox with 409.
-- The list is a JSON array of lowercase addresses, set by "Verify now"
-- (which reads the provider's own sender list) or by an owner/admin
-- edit via PATCH /api/providers. Other providers may use the column
-- later; only SendPulse enforces it today.
ALTER TABLE provider_secrets ADD COLUMN verified_senders TEXT NOT NULL DEFAULT '[]';
