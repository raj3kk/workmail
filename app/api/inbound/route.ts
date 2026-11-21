import {NextResponse} from 'next/server';
import {z} from 'zod';
import {timingSafeEqual} from 'node:crypto';
import {dbOne, dbRun, newId, nowIso} from '@/lib/db';
import {kvPut, kvDelete} from '@/lib/kv';
import {maybeAutoReply} from '@/lib/ai';

export const runtime = 'nodejs';

// G-10: the 25 MB KV value cap is the per-attachment ceiling (same cap as
// the outbound /api/attachments upload path). The worker already enforces
// it; the API re-checks so a direct caller cannot smuggle in a larger
// value. At most 20 attachments per message.
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
const MAX_ATTACHMENTS = 20;

const attachmentSchema = z.object({
  fileName: z.string().max(255),
  contentType: z.string().max(255).optional(),
  sizeBytes: z.number().int().min(1).max(MAX_ATTACHMENT_BYTES),
  contentBase64: z.string().max(34 * 1024 * 1024), // ~25 MB decoded
  contentId: z.string().max(998).optional(),
  disposition: z.string().max(32).optional(),
});

const schema = z.object({
  from: z.string().email(),
  to: z.string().email(),
  subject: z.string().max(998).optional(),
  text: z.string().max(500000).optional(),
  html: z.string().max(1000000).optional(),
  messageId: z.string().max(998).optional(),
  // G-11 threading headers, forwarded by the inbound worker.
  inReplyTo: z.string().max(998).optional(),
  references: z.string().max(8000).optional(),
  // G-10 attachments, forwarded by the inbound worker as base64.
  attachments: z.array(attachmentSchema).max(MAX_ATTACHMENTS).optional(),
  attachmentsSkipped: z
    .array(z.object({fileName: z.string().max(255), sizeBytes: z.number().int().min(0), reason: z.string().max(64)}))
    .max(MAX_ATTACHMENTS)
    .optional(),
  receivedAt: z.string().datetime().optional(),
});

/**
 * Resolve the thread for an inbound message (G-11).
 * 1. If In-Reply-To names a message already in this mailbox, join its thread.
 * 2. Else walk the References chain (most recent ancestor first) and join
 *    the first known thread.
 * 3. Else start a new thread.
 * Returns {threadId, inReplyTo} — inReplyTo is the raw header value (or
 * null) so the reply chain stays traceable.
 */
async function resolveThread(
  mailboxId: string,
  inReplyTo: string | undefined,
  references: string | undefined,
): Promise<{threadId: string; inReplyTo: string | null}> {
  const candidates: string[] = [];
  if (inReplyTo) candidates.push(inReplyTo.trim());
  if (references) {
    const refs = references
      .split(/\s+/)
      .map((r) => r.trim())
      .filter(Boolean)
      .reverse(); // most recent ancestor first
    for (const r of refs) if (!candidates.includes(r)) candidates.push(r);
  }
  for (const candidate of candidates) {
    const parent = await dbOne(
      'SELECT thread_id FROM messages WHERE mailbox_id = ? AND message_id = ? AND thread_id IS NOT NULL',
      [mailboxId, candidate],
    );
    if (parent?.thread_id) return {threadId: String(parent.thread_id), inReplyTo: inReplyTo || null};
  }
  return {threadId: newId(), inReplyTo: inReplyTo || null};
}

function safeFileName(name: string): string {
  return name.normalize('NFKC').replace(/[^\w.() -]/g, '_').slice(0, 150) || 'attachment';
}

export async function POST(req: Request) {
  const expected = process.env.INBOUND_WEBHOOK_TOKEN || '';
  const supplied = req.headers.get('x-inbound-token') || '';
  if (
    !expected ||
    !supplied ||
    expected.length !== supplied.length ||
    !timingSafeEqual(Buffer.from(expected), Buffer.from(supplied))
  )
    return NextResponse.json({error: 'Unauthorized'}, {status: 401});
  const p = schema.safeParse(await req.json().catch(() => null));
  if (!p.success) return NextResponse.json({error: 'Invalid inbound message'}, {status: 400});
  const d = p.data;
  const box = await dbOne(
    'SELECT id, workspace_id, is_active FROM mailboxes WHERE address = ? AND is_active = 1',
    [d.to.toLowerCase()],
  );
  if (!box) return NextResponse.json({error: 'Recipient mailbox not found'}, {status: 404});
  if (d.messageId) {
    const dup = await dbOne('SELECT id FROM messages WHERE mailbox_id = ? AND message_id = ?', [box.id, d.messageId]);
    if (dup) return NextResponse.json({accepted: true, duplicate: true}, {status: 202});
  }
  const now = nowIso();
  const messageId = newId();
  // G-11: thread the message before storing it.
  const thread = await resolveThread(String(box.id), d.inReplyTo, d.references);
  // G-10: attachments the worker could not forward (oversize / over the
  // transfer budget / too many) are recorded in the stored body so the
  // loss is visible to the recipient instead of silent.
  let textBody = d.text || '';
  const skipped = d.attachmentsSkipped || [];
  if (skipped.length > 0) {
    const lines = skipped.map(
      (s) => `- ${s.fileName} (${Math.round(s.sizeBytes / 1024)} KB, ${s.reason})`,
    );
    textBody += `\n\n[WorkMail: ${skipped.length} attachment(s) could not be stored with this message:\n${lines.join('\n')}\nAsk the sender to resend them, or split them across messages.]`;
  }
  try {
    await dbRun(
      `INSERT INTO messages (id, workspace_id, mailbox_id, folder, from_email, to_email, subject, text_body, html_body, message_id, in_reply_to, thread_id, delivery_state, received_at, created_at, updated_at)
       VALUES (?, ?, ?, 'inbox', ?, ?, ?, ?, ?, ?, ?, ?, 'received', ?, ?, ?)`,
      [
        messageId,
        box.workspace_id,
        box.id,
        d.from,
        d.to.toLowerCase(),
        d.subject || '(No Subject)',
        textBody,
        d.html || '',
        d.messageId || null,
        thread.inReplyTo,
        thread.threadId,
        d.receivedAt || now,
        now,
        now,
      ],
    );
  } catch (e) {
    return NextResponse.json({error: 'Could not store inbound message'}, {status: 500});
  }
  // G-10: store each forwarded attachment in KV and record its metadata.
  // A single attachment failure must not fail the message: the bytes are
  // best-effort, and the failure is appended to the stored body note.
  let storedAttachments = 0;
  let storedBytes = 0;
  const attachmentFailures: string[] = [];
  for (const att of d.attachments || []) {
    const safe = safeFileName(att.fileName);
    const key = `att/${box.workspace_id}/${box.id}/${newId()}-${safe}`;
    let bytes: Buffer;
    try {
      bytes = Buffer.from(att.contentBase64, 'base64');
    } catch {
      attachmentFailures.push(`${safe} (undecodable base64)`);
      continue;
    }
    if (bytes.length < 1 || bytes.length > MAX_ATTACHMENT_BYTES || bytes.length !== att.sizeBytes) {
      attachmentFailures.push(`${safe} (size mismatch: declared ${att.sizeBytes}, received ${bytes.length})`);
      continue;
    }
    try {
      await kvPut(key, bytes, att.contentType || 'application/octet-stream');
    } catch {
      attachmentFailures.push(`${safe} (KV store failed)`);
      continue;
    }
    try {
      await dbRun(
        'INSERT INTO message_attachments (id, workspace_id, mailbox_id, message_id, file_name, content_type, size_bytes, object_key, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [newId(), box.workspace_id, box.id, messageId, safe, att.contentType || 'application/octet-stream', bytes.length, key, now],
      );
    } catch {
      // Orphan KV object: metadata failed, so delete the bytes we stored.
      await kvDelete(key).catch(() => {});
      attachmentFailures.push(`${safe} (metadata save failed)`);
      continue;
    }
    storedAttachments++;
    storedBytes += bytes.length;
  }
  if (attachmentFailures.length > 0) {
    const note = `\n\n[WorkMail: ${attachmentFailures.length} attachment(s) failed to store: ${attachmentFailures.join('; ')}]`;
    await dbRun('UPDATE messages SET text_body = text_body || ? WHERE id = ?', [note, messageId]).catch(() => {});
  }
  const period = new Date().toISOString().slice(0, 7) + '-01';
  await dbRun(
    `INSERT INTO usage_counters (workspace_id, period_start, sent_count, received_count, storage_bytes)
     VALUES (?, ?, 0, 1, ?)
     ON CONFLICT(workspace_id, period_start) DO UPDATE SET received_count = usage_counters.received_count + 1, storage_bytes = usage_counters.storage_bytes + excluded.storage_bytes`,
    [box.workspace_id, period, storedBytes],
  );
  // AI auto-reply hook (additive, best-effort). When the per-mailbox
  // auto-reply toggle is ON and the AI agent is configured, the reply is
  // TRANSMITTED automatically via the service send path (see lib/ai.ts
  // maybeAutoReply — auto-send is LIVE); otherwise a draft is queued for
  // human review. Never throws and never changes the 202 acceptance of
  // the inbound message.
  try {
    await maybeAutoReply({
      workspaceId: String(box.workspace_id),
      mailboxId: String(box.id),
      mailboxAddress: d.to.toLowerCase(),
      messageId,
      from: d.from,
      subject: d.subject || '(No Subject)',
      body: d.text || '',
    });
  } catch {
    // Auto-reply must never break inbound delivery.
  }
  return NextResponse.json(
    {accepted: true, thread_id: thread.threadId, attachments_stored: storedAttachments},
    {status: 202},
  );
}
