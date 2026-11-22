// Gmail backup mirror — import engine (Phase 4, PRODUCTION-PLAN.md §7).
//
// One-way mirror: D1 stays the source of truth; Gmail gets a labelled copy
// of every message via users.messages.import (25 quota units per import).
// Dedupe is authoritative in the gmail_mirror table — Gmail search does not
// reliably index custom headers, so a re-run skips every already-mapped row
// and imports 0 new messages.
//
// Honest limits (research §7.3): this is a backup copy, not Gmail-as-storage.
// It cannot send as hello@flow99.in with proper authentication, cannot back
// up AI data / campaigns / billing / audit state, and does not protect
// against the user deleting the mirrored copy in Gmail (the D1 original is
// the protection).
import {dbOne, dbQuery, dbRun, newId, nowIso} from '@/lib/db';
import {kvGet} from '@/lib/kv';
import {getGmailAccessToken, getGmailMirrorTokenRow} from '@/lib/gmail-oauth';

/** Gmail import ceiling (research §6.1): messages.import accepts up to 150 MB. */
export const GMAIL_IMPORT_MAX_BYTES = 150 * 1024 * 1024;

const GMAIL_API = 'https://gmail.googleapis.com/gmail/v1';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function logMirror(event: string, workspaceId: string, extra: Record<string, unknown> = {}): void {
  // Metadata only — never message bodies, never tokens.
  console.log(JSON.stringify({event, workspace_id: workspaceId, ...extra}));
}

export interface MirrorMessageRow {
  id: string;
  mailbox_id: string;
  folder: string;
  from_email: string;
  to_email: string;
  subject: string;
  text_body: string;
  html_body: string;
  message_id: string | null;
  received_at: string | null;
  created_at: string;
}

interface MirrorAttachment {
  fileName: string;
  contentType: string;
  sizeBytes: number;
  base64: string;
}

function base64url(input: Buffer | string): string {
  const b = typeof input === 'string' ? Buffer.from(input, 'utf8') : input;
  return b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Wrap base64 at 76 chars (RFC 2045) for MIME body parts. */
function wrapBase64(b64: string): string {
  const out: string[] = [];
  for (let i = 0; i < b64.length; i += 76) out.push(b64.slice(i, i + 76));
  return out.join('\r\n');
}

/** RFC 2047 encoded-word for a header value that is non-ASCII or overlong. ASCII values pass through unchanged. */
function encodeHeader(value: string): string {
  if (/^[\x20-\x7E]*$/.test(value) && value.length <= 78) return value;
  // Split into <= 60-char encoded-word chunks so no line exceeds 75 chars.
  const words: string[] = [];
  const bytes = Buffer.from(value, 'utf8');
  for (let i = 0; i < bytes.length; i += 45) {
    words.push(`=?UTF-8?B?${bytes.subarray(i, i + 45).toString('base64')}?=`);
  }
  return words.join(' ');
}

function safeFileName(name: string): string {
  return name.replace(/["\r\n]/g, '_').slice(0, 150) || 'attachment';
}

function rfc2822Date(iso: string | null, fallback: string): string {
  const d = new Date(iso || fallback);
  if (Number.isNaN(d.getTime())) return new Date(fallback).toUTCString();
  return d.toUTCString();
}

function messageIdHeader(row: MirrorMessageRow): string {
  const stored = (row.message_id || '').trim();
  if (stored.startsWith('<') && stored.endsWith('>') && stored.includes('@')) return stored;
  if (stored && /^[^<>\s]+@[^<>\s]+$/.test(stored)) return `<${stored}>`;
  return `<wm-${row.id}@workmail.local>`;
}

/**
 * Build a complete RFC 2822 MIME document from a D1 row.
 * Headers: From / To / Subject / Date / Message-ID / X-WorkMail-Id.
 * Bodies: plain + HTML as multipart/alternative; attachments re-attached
 * from KV as multipart/mixed parts. Bodies and attachments are base64.
 */
export function buildMime(row: MirrorMessageRow, attachments: MirrorAttachment[]): string {
  const boundary = `workmail-${row.id.slice(0, 8)}-${Date.now().toString(36)}`;
  const altBoundary = `workmail-alt-${row.id.slice(0, 8)}-${Date.now().toString(36)}`;
  const lines: string[] = [];
  lines.push(`From: ${encodeHeader(row.from_email)}`);
  lines.push(`To: ${encodeHeader(row.to_email)}`);
  lines.push(`Subject: ${encodeHeader(row.subject || '(No Subject)')}`);
  lines.push(`Date: ${rfc2822Date(row.received_at, row.created_at)}`);
  lines.push(`Message-ID: ${messageIdHeader(row)}`);
  lines.push(`X-WorkMail-Id: ${row.id}`);
  lines.push('MIME-Version: 1.0');
  const hasHtml = Boolean((row.html_body || '').trim());
  const hasText = Boolean((row.text_body || '').trim());
  const hasAttachments = attachments.length > 0;

  const alternativePart = (): string[] => {
    const p: string[] = [];
    if (hasText && hasHtml) {
      p.push(`Content-Type: multipart/alternative; boundary="${altBoundary}"`, '', `--${altBoundary}`);
      p.push('Content-Type: text/plain; charset="UTF-8"', 'Content-Transfer-Encoding: base64', '', wrapBase64(Buffer.from(row.text_body, 'utf8').toString('base64')));
      p.push(`--${altBoundary}`);
      p.push('Content-Type: text/html; charset="UTF-8"', 'Content-Transfer-Encoding: base64', '', wrapBase64(Buffer.from(row.html_body, 'utf8').toString('base64')));
      p.push(`--${altBoundary}--`);
    } else if (hasHtml) {
      p.push('Content-Type: text/html; charset="UTF-8"', 'Content-Transfer-Encoding: base64', '', wrapBase64(Buffer.from(row.html_body, 'utf8').toString('base64')));
    } else {
      p.push('Content-Type: text/plain; charset="UTF-8"', 'Content-Transfer-Encoding: base64', '', wrapBase64(Buffer.from(row.text_body || '(No content)', 'utf8').toString('base64')));
    }
    return p;
  };

  if (!hasAttachments) {
    if (hasText && hasHtml) {
      lines.push(`Content-Type: multipart/alternative; boundary="${altBoundary}"`, '', `--${altBoundary}`);
      lines.push('Content-Type: text/plain; charset="UTF-8"', 'Content-Transfer-Encoding: base64', '', wrapBase64(Buffer.from(row.text_body, 'utf8').toString('base64')));
      lines.push(`--${altBoundary}`);
      lines.push('Content-Type: text/html; charset="UTF-8"', 'Content-Transfer-Encoding: base64', '', wrapBase64(Buffer.from(row.html_body, 'utf8').toString('base64')));
      lines.push(`--${altBoundary}--`);
    } else if (hasHtml) {
      lines.push('Content-Type: text/html; charset="UTF-8"', 'Content-Transfer-Encoding: base64', '', wrapBase64(Buffer.from(row.html_body, 'utf8').toString('base64')));
    } else {
      lines.push('Content-Type: text/plain; charset="UTF-8"', 'Content-Transfer-Encoding: base64', '', wrapBase64(Buffer.from(row.text_body || '(No content)', 'utf8').toString('base64')));
    }
    return lines.join('\r\n') + '\r\n';
  }

  lines.push(`Content-Type: multipart/mixed; boundary="${boundary}"`, '', `--${boundary}`);
  lines.push(...alternativePart());
  for (const a of attachments) {
    const name = safeFileName(a.fileName);
    lines.push(`--${boundary}`);
    lines.push(`Content-Type: ${a.contentType || 'application/octet-stream'}; name="${name}"`);
    lines.push('Content-Transfer-Encoding: base64');
    lines.push(`Content-Disposition: attachment; filename="${name}"`, '', wrapBase64(a.base64));
  }
  lines.push(`--${boundary}--`);
  return lines.join('\r\n') + '\r\n';
}

/** Labels applied at import. Sent mail also gets the SENT system label, received mail the INBOX system label, so the copies appear in Gmail's Sent / Inbox views (research §6.3). */
export function mirrorLabelIds(row: MirrorMessageRow, mailboxAddress: string): string[] {
  const local = (mailboxAddress || '').split('@')[0] || 'mailbox';
  const labels = ['WorkMail', `WorkMail/${local}`];
  if (row.folder === 'sent') {
    labels.push('WorkMail/Sent', 'SENT');
  } else {
    labels.push('WorkMail/Inbox', 'INBOX');
  }
  return labels;
}

async function gmailFetch(
  accessToken: string,
  url: string,
  init: RequestInit & {parseJson?: boolean} = {},
): Promise<{status: number; json: any; retryAfterMs: number | null}> {
  const r = await fetch(url, {
    ...init,
    headers: {...(init.headers || {}), Authorization: `Bearer ${accessToken}`},
    signal: AbortSignal.timeout(30000),
  });
  const retryAfter = r.headers.get('retry-after');
  const json = await r.json().catch(() => null);
  return {status: r.status, json, retryAfterMs: retryAfter ? Number(retryAfter) * 1000 : null};
}

/** Create the WorkMail labels if they do not exist yet (import rejects unknown custom labelIds). Idempotent.
 *  Returns name -> Gmail label id (custom labels have opaque ids, NOT their names — passing a name as a
 *  labelId 400s; system labels SENT/INBOX are not in the map because their ids equal their names). */
export async function ensureMirrorLabels(accessToken: string): Promise<Map<string, string>> {
  const listed = await gmailFetch(accessToken, `${GMAIL_API}/users/me/labels`);
  const byName = new Map<string, string>();
  for (const l of (listed.json?.labels || [])) {
    if (l?.name && l?.id) byName.set(String(l.name), String(l.id));
  }
  for (const name of ['WorkMail', 'WorkMail/Sent', 'WorkMail/Inbox']) {
    if (byName.has(name)) continue;
    const created = await gmailFetch(accessToken, `${GMAIL_API}/users/me/labels`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({name, labelListVisibility: 'labelShow', messageListVisibility: 'show'}),
    });
    if (created.status === 200 && created.json?.id) {
      byName.set(name, String(created.json.id));
    } else {
      logMirror('gmail_mirror_label_create_failed', '', {label: name, http_status: created.status});
    }
  }
  return byName;
}

/** Import one MIME document with backoff on 429 / 5xx (max 4 attempts). Returns the Gmail message + thread ids.
 *  Uses the STANDARD messages.import endpoint (JSON body {raw, labelIds}) — the /upload/ media endpoint
 *  only accepts message/rfc822 bytes and rejects application/json ("Media type 'application/json' is
 *  not supported"), which broke every import on 2026-11-22. */
export async function importToGmail(
  accessToken: string,
  rawMime: string,
  labelIds: string[],
): Promise<{gmailMessageId: string; gmailThreadId: string | null}> {
  const url = `${GMAIL_API}/users/me/messages/import?internalDateSource=dateHeader&neverMarkSpam=true`;
  const body = JSON.stringify({raw: base64url(rawMime), labelIds});
  let lastError = 'Gmail import failed';
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await gmailFetch(accessToken, url, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body,
    });
    if (res.status === 200 && res.json?.id) {
      return {gmailMessageId: String(res.json.id), gmailThreadId: res.json.threadId ? String(res.json.threadId) : null};
    }
    if (res.status === 429 || res.status >= 500) {
      const wait = res.retryAfterMs ?? (1000 * 2 ** attempt);
      lastError = `Gmail import rate-limited/unavailable (HTTP ${res.status})`;
      await sleep(Math.min(wait, 16000));
      continue;
    }
    lastError = res.json?.error?.message || `Gmail import failed (HTTP ${res.status})`;
    throw new Error(lastError);
  }
  throw new Error(lastError);
}

export type MirrorOutcome = 'imported' | 'skipped' | 'failed';

export interface MirrorOneResult {
  outcome: MirrorOutcome;
  reason?: string;
  gmailMessageId?: string;
  /** True when the row was already mapped before this call (re-run idempotency). */
  alreadyMirrored?: boolean;
}

async function loadMirrorAttachments(workspaceId: string, mailboxId: string, d1MessageId: string): Promise<MirrorAttachment[]> {
  const rows = await dbQuery(
    'SELECT file_name, content_type, size_bytes, object_key FROM message_attachments WHERE workspace_id = ? AND mailbox_id = ? AND message_id = ?',
    [workspaceId, mailboxId, d1MessageId],
  );
  const out: MirrorAttachment[] = [];
  for (const row of rows || []) {
    const bytes = await kvGet(String(row.object_key));
    if (!bytes) throw new Error(`Attachment bytes missing for ${String(row.file_name)}`);
    out.push({
      fileName: String(row.file_name),
      contentType: String(row.content_type || 'application/octet-stream'),
      sizeBytes: bytes.length,
      base64: bytes.toString('base64'),
    });
  }
  return out;
}

async function recordSkipped(d1MessageId: string, reason: string): Promise<void> {
  await dbRun(
    `INSERT INTO gmail_mirror (d1_message_id, gmail_message_id, gmail_thread_id, imported_at, status, skip_reason)
     VALUES (?, NULL, NULL, ?, 'skipped', ?)
     ON CONFLICT(d1_message_id) DO UPDATE SET status = 'skipped', skip_reason = excluded.skip_reason, imported_at = excluded.imported_at`,
    [d1MessageId, nowIso(), reason],
  );
}

/** Mirror one D1 message. Already-mapped rows are a no-op (idempotent). Oversize messages are recorded as skipped with a reason, never attempted.
 *  labelIdByName maps custom label NAMES to their Gmail label ids (see ensureMirrorLabels); system
 *  labels (SENT/INBOX) pass through unchanged because their ids equal their names. */
export async function mirrorOneMessage(
  workspaceId: string,
  accessToken: string,
  d1MessageId: string,
  labelIdByName?: Map<string, string>,
): Promise<MirrorOneResult> {
  const existing = await dbOne('SELECT status, gmail_message_id FROM gmail_mirror WHERE d1_message_id = ?', [d1MessageId]);
  if (existing?.status === 'imported') return {outcome: 'imported', alreadyMirrored: true, gmailMessageId: String(existing.gmail_message_id || '')};
  if (existing?.status === 'skipped') return {outcome: 'skipped', reason: String(existing.skip_reason || 'Skipped previously')};
  const row = await dbOne(
    `SELECT id, mailbox_id, folder, from_email, to_email, subject, text_body, html_body, message_id, received_at, created_at
     FROM messages WHERE id = ? AND workspace_id = ?`,
    [d1MessageId, workspaceId],
  );
  if (!row) return {outcome: 'failed', reason: 'Message not found in this workspace'};
  const box = await dbOne('SELECT address FROM mailboxes WHERE id = ?', [row.mailbox_id]);
  const mailboxAddress = box ? String(box.address) : '';
  const attachments = await loadMirrorAttachments(workspaceId, String(row.mailbox_id), d1MessageId);
  const attachmentBytes = attachments.reduce((n, a) => n + a.sizeBytes, 0);
  const bodyBytes = Buffer.byteLength(String(row.text_body || ''), 'utf8') + Buffer.byteLength(String(row.html_body || ''), 'utf8');
  const estimatedTotal = Math.ceil((bodyBytes + attachmentBytes) * 4 / 3) + 4096;
  if (estimatedTotal > GMAIL_IMPORT_MAX_BYTES) {
    const reason = `Attachments exceed the 150 MB Gmail import ceiling (about ${Math.round(estimatedTotal / 1024 / 1024)} MB).`;
    await recordSkipped(d1MessageId, reason);
    return {outcome: 'skipped', reason};
  }
  const mime = buildMime(row as unknown as MirrorMessageRow, attachments);
  const labelIds = mirrorLabelIds(row as unknown as MirrorMessageRow, mailboxAddress).map(
    (name) => labelIdByName?.get(name) ?? name,
  );
  const imported = await importToGmail(accessToken, mime, labelIds);
  await dbRun(
    `INSERT INTO gmail_mirror (d1_message_id, gmail_message_id, gmail_thread_id, imported_at, status, skip_reason)
     VALUES (?, ?, ?, ?, 'imported', NULL)
     ON CONFLICT(d1_message_id) DO UPDATE SET gmail_message_id = excluded.gmail_message_id, gmail_thread_id = excluded.gmail_thread_id,
       imported_at = excluded.imported_at, status = 'imported', skip_reason = NULL`,
    [d1MessageId, imported.gmailMessageId, imported.gmailThreadId, nowIso()],
  );
  return {outcome: 'imported', gmailMessageId: imported.gmailMessageId};
}

export interface MirrorRunResult {
  total: number;
  imported: number;
  alreadyMirrored: number;
  skipped: Array<{id: string; subject: string; reason: string}>;
  failed: Array<{id: string; subject: string; reason: string}>;
}

/** Import every unmirrored message in the workspace (all folders except drafts and deleted). Per-message failures never abort the run. */
export async function mirrorAllUnmirrored(workspaceId: string, accessToken: string, limit = 500): Promise<MirrorRunResult> {
  const rows = await dbQuery(
    `SELECT id, mailbox_id, folder, from_email, to_email, subject, text_body, html_body, message_id, received_at, created_at
     FROM messages WHERE workspace_id = ? AND folder != 'drafts' AND deleted_at IS NULL ORDER BY received_at ASC LIMIT ?`,
    [workspaceId, limit],
  );
  const result: MirrorRunResult = {total: rows.length, imported: 0, alreadyMirrored: 0, skipped: [], failed: []};
  if (rows.length === 0) return result;
  const labelIdByName = await ensureMirrorLabels(accessToken);
  for (const row of rows) {
    const id = String(row.id);
    const subject = String(row.subject || '(No Subject)');
    try {
      const one = await mirrorOneMessage(workspaceId, accessToken, id, labelIdByName);
      if (one.outcome === 'imported') {
        if (one.alreadyMirrored) result.alreadyMirrored++;
        else result.imported++;
      } else if (one.outcome === 'skipped') {
        result.skipped.push({id, subject, reason: one.reason || 'Skipped'});
      }
    } catch (e) {
      result.failed.push({id, subject, reason: e instanceof Error ? e.message : 'Import failed'});
      logMirror('gmail_mirror_import_failed', workspaceId, {message_id: id, error: e instanceof Error ? e.message : 'unknown'});
    }
    await sleep(100);
  }
  logMirror('gmail_mirror_run', workspaceId, {
    total: result.total,
    imported: result.imported,
    skipped: result.skipped.length,
    failed: result.failed.length,
  });
  return result;
}

export interface MirrorStatus {
  connected: boolean;
  googleEmail: string | null;
  autoMirror: boolean;
  total: number;
  mirrored: number;
  skipped: number;
  unmirrored: number;
}

export async function getMirrorStatus(workspaceId: string): Promise<MirrorStatus> {
  const token = await getGmailMirrorTokenRow(workspaceId);
  const totalRow = await dbOne(
    "SELECT COUNT(*) AS n FROM messages WHERE workspace_id = ? AND folder != 'drafts' AND deleted_at IS NULL",
    [workspaceId],
  );
  const mirroredRow = await dbOne(
    `SELECT COUNT(*) AS n FROM gmail_mirror gm JOIN messages m ON m.id = gm.d1_message_id
     WHERE m.workspace_id = ? AND gm.status = 'imported'`,
    [workspaceId],
  );
  const skippedRow = await dbOne(
    `SELECT COUNT(*) AS n FROM gmail_mirror gm JOIN messages m ON m.id = gm.d1_message_id
     WHERE m.workspace_id = ? AND gm.status = 'skipped'`,
    [workspaceId],
  );
  const total = Number(totalRow?.n || 0);
  const mirrored = Number(mirroredRow?.n || 0);
  const skipped = Number(skippedRow?.n || 0);
  return {
    connected: !!token,
    googleEmail: token?.googleEmail || null,
    autoMirror: token?.autoMirror || false,
    total,
    mirrored,
    skipped,
    unmirrored: Math.max(0, total - mirrored - skipped),
  };
}

/**
 * Best-effort auto-mirror for one newly sent / received message.
 * Failure-isolated by design: it NEVER throws and NEVER blocks sending or
 * inbound delivery. Returns false when auto-mirror is off, no token is
 * stored, or the import fails (logged, metadata only).
 */
export async function autoMirrorMessage(workspaceId: string, d1MessageId: string): Promise<boolean> {
  try {
    const token = await getGmailMirrorTokenRow(workspaceId);
    if (!token || !token.autoMirror) return false;
    const accessToken = await getGmailAccessToken(workspaceId);
    if (!accessToken) {
      logMirror('gmail_mirror_auto_no_token', workspaceId, {message_id: d1MessageId});
      return false;
    }
    const one = await mirrorOneMessage(workspaceId, accessToken, d1MessageId);
    return one.outcome === 'imported';
  } catch (e) {
    logMirror('gmail_mirror_auto_failed', workspaceId, {
      message_id: d1MessageId,
      error: e instanceof Error ? e.message : 'unknown',
    });
    return false;
  }
}

/** Write a backup_runs row for a mirror export (decision D10: no backup claim without a verification read — the counts below are re-read from gmail_mirror by the caller). */
export async function recordMirrorBackupRun(
  workspaceId: string,
  run: MirrorRunResult,
  verifiedMirrored: number,
): Promise<void> {
  const details = JSON.stringify({
    workspace_id: workspaceId,
    total: run.total,
    imported: run.imported,
    skipped: run.skipped.length,
    failed: run.failed.length,
    verified_mirrored_in_d1: verifiedMirrored,
  });
  await dbRun(
    `INSERT INTO backup_runs (id, backup_kind, status, object_key, checksum, bytes, started_at, finished_at, details)
     VALUES (?, 'gmail_mirror', ?, NULL, NULL, NULL, ?, ?, ?)`,
    [newId(), run.failed.length > 0 ? 'partial' : 'ok', nowIso(), nowIso(), details],
  ).catch(() => {});
}
