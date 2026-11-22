-- WorkMail E5-10 — per-mailbox signatures (migration 0007).
--
-- `mailboxes.signature`: plain-text signature appended to compose
-- sends from that mailbox (as "\n\n-- \n" + signature, text body
-- only). NULL/empty = no signature. HTML signatures are NOT
-- supported (documented in the Settings UI and in lib/ai-draft.ts
-- sibling code — the compose path appends text only).
-- Editable in Settings → Mailboxes (MailboxSignaturesSection).
-- See PRODUCTION-PLAN.md §11.5 row E5-10.
--
-- Apply one statement at a time via the D1 /query endpoint
-- (the /batch endpoint 404s on this account).

ALTER TABLE mailboxes ADD COLUMN signature TEXT;
