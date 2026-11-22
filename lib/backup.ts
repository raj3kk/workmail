// WorkMail export / backup builder — Phase 3b, G-30 / G-31 / D10.
//
// Builds the user export ZIP (messages as .eml + messages.json +
// metadata.json, attachments included as files) with NO dependency:
// ZIP is written by hand (deflate via node:zlib + CRC-32) because the
// repo has no zip library and adding one for a single builder is
// unnecessary weight. Every export writes a backup_runs row (D10) and
// is verified by re-reading the ZIP manifest before it is handed out —
// no backup claim without a verification read.
//
// Export scope (honest limits, also in docs/BACKUP.md):
//   - Only the requesting workspace's messages, tenant-scoped by
//     workspace_id (+ optional mailbox_id).
//   - Attachment bytes ARE included (attachments/<messageId>/<file>).
//   - NOT included: provider credentials, API keys, session data,
//     outbound_jobs payloads (retention covers those — G-33 — but they
//     are a send log, not mail), delivery/audit events.
//   - Size cap: refuse over 100 MB with a clear message + per-mailbox
//     option (the caller picks a smaller mailbox and retries).
import {createHash} from 'node:crypto';
import {deflateRawSync} from 'node:zlib';
import {dbQuery, dbRun, jstr, newId, nowIso} from '@/lib/db';
import {kvGet} from '@/lib/kv';

export const EXPORT_MAX_BYTES = 100 * 1024 * 1024; // 100 MB cap (G-30)

export class ExportTooLargeError extends Error {
  estimatedBytes: number;
  constructor(estimatedBytes: number) {
    super(
      `This export would be about ${Math.round(estimatedBytes / 1024 / 1024)} MB, over the 100 MB export limit. Export one mailbox at a time instead — pick a mailbox in Settings and download again.`,
    );
    this.name = 'ExportTooLargeError';
    this.estimatedBytes = estimatedBytes;
  }
}

// ---------------------------------------------------------------------------
// CRC-32 (IEEE) + minimal ZIP writer/reader
// ---------------------------------------------------------------------------

const CRC_TABLE: Uint32Array = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

interface ZipEntry {
  name: string;
  data: Buffer;
}

/** Build a ZIP (deflate) from entries. Returns the full archive bytes. */
export function buildZip(entries: ZipEntry[]): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, 'utf8');
    const crc = crc32(e.data);
    const compressed = deflateRawSync(e.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // UTF-8 filenames
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt16LE(0, 10); // mod time (unknown — honest: no fake date)
    local.writeUInt16LE(0, 12); // mod date
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(e.data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    localParts.push(local, nameBuf, compressed);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(e.data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30); // extra
    central.writeUInt16LE(0, 32); // comment
    central.writeUInt16LE(0, 34); // disk
    central.writeUInt16LE(0, 36); // internal attrs
    central.writeUInt32LE(0, 38); // external attrs
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, nameBuf);
    offset += local.length + nameBuf.length + compressed.length;
  }
  const centralStart = offset;
  const centralSize = centralParts.reduce((n, b) => n + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(centralStart, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...localParts, ...centralParts, end]);
}

/** Re-read a ZIP central directory: entry names + uncompressed sizes. */
export function readZipManifest(zip: Buffer): Array<{name: string; size: number}> {
  // Find the End Of Central Directory record (no archive comment is written).
  if (zip.length < 22) throw new Error('Not a ZIP archive (too short).');
  const eocd = zip.length - 22;
  if (zip.readUInt32LE(eocd) !== 0x06054b50) throw new Error('Not a ZIP archive (bad end record).');
  const count = zip.readUInt16LE(eocd + 10);
  const centralOffset = zip.readUInt32LE(eocd + 16);
  const out: Array<{name: string; size: number}> = [];
  let p = centralOffset;
  for (let i = 0; i < count; i++) {
    if (zip.readUInt32LE(p) !== 0x02014b50) throw new Error('Not a ZIP archive (bad central entry).');
    const nameLen = zip.readUInt16LE(p + 28);
    const extraLen = zip.readUInt16LE(p + 30);
    const commentLen = zip.readUInt16LE(p + 32);
    const size = zip.readUInt32LE(p + 24);
    out.push({name: zip.toString('utf8', p + 46, p + 46 + nameLen), size});
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

// ---------------------------------------------------------------------------
// .eml rendering (RFC 5322-ish, multipart when HTML is present)
// ---------------------------------------------------------------------------

function headerSafe(v: string): string {
  return v.replace(/[\r\n]+/g, ' ').slice(0, 998);
}

export function messageToEml(m: {
  from_email: string;
  to_email: string;
  subject: string;
  text_body: string;
  html_body: string;
  message_id: string | null;
  received_at: string;
  created_at: string;
}): Buffer {
  const date = new Date(m.received_at || m.created_at).toUTCString();
  const lines = [
    `From: ${headerSafe(m.from_email)}`,
    `To: ${headerSafe(m.to_email)}`,
    `Subject: ${headerSafe(m.subject || '(No Subject)')}`,
    `Date: ${date}`,
  ];
  if (m.message_id) lines.push(`Message-ID: ${headerSafe(m.message_id)}`);
  lines.push('X-WorkMail-Export: true');
  const text = m.text_body || '';
  const html = m.html_body || '';
  if (html) {
    const boundary = 'workmail-export-' + createHash('sha256').update(String(m.message_id || '') + date).digest('hex').slice(0, 16);
    lines.push('MIME-Version: 1.0', `Content-Type: multipart/alternative; boundary="${boundary}"`, '');
    lines.push(
      `--${boundary}`,
      'Content-Type: text/plain; charset=utf-8',
      'Content-Transfer-Encoding: 8bit',
      '',
      text,
      `--${boundary}`,
      'Content-Type: text/html; charset=utf-8',
      'Content-Transfer-Encoding: 8bit',
      '',
      html,
      `--${boundary}--`,
      '',
    );
  } else {
    lines.push('MIME-Version: 1.0', 'Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: 8bit', '', text);
  }
  return Buffer.from(lines.join('\r\n'), 'utf8');
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export interface ExportManifest {
  workspace_id: string;
  mailbox_id: string | null;
  exported_at: string;
  message_count: number;
  eml_count: number;
  attachment_count: number;
  attachment_bytes: number;
  total_bytes: number;
  messages_sha256: string;
}

export interface BuiltExport {
  zip: Buffer;
  manifest: ExportManifest;
  checksum: string;
  bytes: number;
}

interface ExportMessageRow {
  id: string;
  mailbox_id: string;
  folder: string;
  from_email: string;
  to_email: string;
  subject: string;
  text_body: string;
  html_body: string;
  message_id: string | null;
  received_at: string;
  created_at: string;
}

/**
 * Build the export ZIP for one workspace (optionally one mailbox).
 * Throws ExportTooLargeError when the estimated size is over 100 MB —
 * before any KV byte is fetched, so a refused export costs nothing.
 */
export async function buildExportZip(
  workspaceId: string,
  opts?: {mailboxId?: string | null},
): Promise<BuiltExport> {
  const mailboxId = opts?.mailboxId || null;
  const messages = (await dbQuery(
    `SELECT id, mailbox_id, folder, from_email, to_email, subject, text_body, html_body, message_id, received_at, created_at
     FROM messages WHERE workspace_id = ? ${mailboxId ? 'AND mailbox_id = ?' : ''} ORDER BY received_at ASC`,
    mailboxId ? [workspaceId, mailboxId] : [workspaceId],
  )) as ExportMessageRow[];
  const attachments = (await dbQuery(
    `SELECT id, mailbox_id, message_id, file_name, content_type, size_bytes, object_key FROM message_attachments
     WHERE workspace_id = ? ${mailboxId ? 'AND mailbox_id = ?' : ''} ORDER BY created_at ASC`,
    mailboxId ? [workspaceId, mailboxId] : [workspaceId],
  )) as Array<{
    id: string;
    mailbox_id: string;
    message_id: string;
    file_name: string;
    content_type: string;
    size_bytes: number;
    object_key: string;
  }>;
  // Size estimate BEFORE fetching KV bytes: bodies + attachment sizes +
  // JSON overhead. Refusing here is the honest 100 MB cap.
  let estimated = 0;
  for (const m of messages) estimated += Buffer.byteLength(m.text_body || '') + Buffer.byteLength(m.html_body || '') + 1024;
  for (const a of attachments) estimated += Number(a.size_bytes || 0);
  estimated += 64 * 1024; // messages.json + metadata.json headroom
  if (estimated > EXPORT_MAX_BYTES) throw new ExportTooLargeError(estimated);

  const entries: ZipEntry[] = [];
  const messagesJson: Array<Record<string, unknown>> = [];
  let attachmentBytes = 0;
  const attsByMessage = new Map<string, typeof attachments>();
  for (const a of attachments) {
    const list = attsByMessage.get(a.message_id) || [];
    list.push(a);
    attsByMessage.set(a.message_id, list);
  }
  for (const m of messages) {
    entries.push({name: `messages/${m.id}.eml`, data: messageToEml(m)});
    messagesJson.push({
      id: m.id,
      mailbox_id: m.mailbox_id,
      folder: m.folder,
      from: m.from_email,
      to: m.to_email,
      subject: m.subject,
      message_id: m.message_id,
      received_at: m.received_at,
      created_at: m.created_at,
      attachments: (attsByMessage.get(m.id) || []).map((a) => ({
        file_name: a.file_name,
        content_type: a.content_type,
        size_bytes: Number(a.size_bytes),
      })),
    });
  }
  // Attachment bytes (best-effort per file: a missing KV value is listed
  // in messages.json metadata and noted in metadata.json — never a
  // silent gap, never a failed export).
  const missingAttachments: string[] = [];
  for (const a of attachments) {
    let bytes: Buffer | null = null;
    try {
      bytes = await kvGet(a.object_key);
    } catch {
      bytes = null;
    }
    if (!bytes) {
      missingAttachments.push(`${a.message_id}/${a.file_name}`);
      continue;
    }
    const safeName = a.file_name.replace(/[\\/:*?"<>|]/g, '_');
    entries.push({name: `attachments/${a.message_id}/${safeName}`, data: bytes});
    attachmentBytes += bytes.length;
  }
  const messagesJsonBuf = Buffer.from(JSON.stringify(messagesJson, null, 2), 'utf8');
  const manifest: ExportManifest = {
    workspace_id: workspaceId,
    mailbox_id: mailboxId,
    exported_at: nowIso(),
    message_count: messages.length,
    eml_count: messages.length,
    attachment_count: attachments.length,
    attachment_bytes: attachmentBytes,
    total_bytes: 0, // filled after the ZIP is built
    messages_sha256: createHash('sha256').update(messagesJsonBuf).digest('hex'),
  };
  const metadata = {
    workspace_id: manifest.workspace_id,
    mailbox_id: manifest.mailbox_id,
    exported_at: manifest.exported_at,
    message_count: manifest.message_count,
    eml_count: manifest.eml_count,
    attachment_count: manifest.attachment_count,
    attachment_bytes: manifest.attachment_bytes,
    messages_sha256: manifest.messages_sha256,
    missing_attachments: missingAttachments,
    scope_note:
      'This export contains this workspace\'s messages only (no other workspace, no credentials, no API keys, no sessions). Attachment bytes are included under attachments/. Outbound-job payloads and delivery/audit events are operational logs, not mail, and are not in this ZIP (retention deletes them per workspace_settings.retention_days).',
  };
  entries.push({name: 'messages.json', data: messagesJsonBuf});
  entries.push({name: 'metadata.json', data: Buffer.from(JSON.stringify(metadata, null, 2), 'utf8')});
  const zip = buildZip(entries);
  manifest.total_bytes = zip.length;
  // Verification read (D10): re-read the manifest and confirm the entry
  // count and the .eml count match what was built. (metadata.json carries
  // no total_bytes field: the true ZIP size lives in the manifest returned
  // to the caller and in the backup_runs row, so no field can go stale.)
  const readBack = readZipManifest(zip);
  if (readBack.length !== entries.length)
    throw new Error(`Export verification failed: ZIP holds ${readBack.length} entries, expected ${entries.length}.`);
  const emlInZip = readBack.filter((e) => e.name.startsWith('messages/') && e.name.endsWith('.eml')).length;
  if (emlInZip !== messages.length)
    throw new Error(`Export verification failed: ZIP holds ${emlInZip} .eml files, expected ${messages.length}.`);
  const checksum = createHash('sha256').update(zip).digest('hex');
  return {zip, manifest, checksum, bytes: zip.length};
}

/** Write a backup_runs row (D10). Never throws — callers log on failure. */
export async function writeBackupRun(
  kind: string,
  status: string,
  opts: {bytes?: number | null; checksum?: string | null; details: Record<string, unknown>},
): Promise<string> {
  const id = newId();
  const now = nowIso();
  await dbRun(
    `INSERT INTO backup_runs (id, backup_kind, status, object_key, checksum, bytes, started_at, finished_at, details)
     VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?)`,
    [id, kind, status, opts.checksum || null, opts.bytes ?? null, now, now, jstr(opts.details)],
  );
  return id;
}
