import {NextResponse} from 'next/server';
import {z} from 'zod';
import {createHash, randomUUID} from 'node:crypto';
import {dbOne, dbRun, newId, nowIso} from '@/lib/db';
import {authenticateApiKeyWithScope} from '@/lib/api-auth';
import {checkRateLimit, rateLimitResponse, V1_RATE_LIMITS} from '@/lib/rate-limit';
import {executeSend, type SendAttachmentRef, type SendExecution} from '@/lib/service-send';
import {computeNextAttemptIso} from '@/lib/retry';
import {kvDelete, kvPut} from '@/lib/kv';

export const runtime = 'nodejs';

// POST /api/v1/send — integration API (Phase 2, decision D4).
// Auth: API key ONLY (Authorization: Bearer wm_live_...), scope `send`.
// Session cookies and OPS_CRON_TOKEN are never accepted here —
// lib/api-auth.ts reads only the Bearer key header.
// The send itself reuses `executeSend` as {kind:'user', userId: key
// owner}, so the monthly cap, suppression, idempotency, per-provider
// caps and provider fallback apply exactly as they do for the UI.
// Response statuses are honest (RULE 0): `success` only when a
// provider accepted the message; unknown outcomes are 202, never a
// claimed success.
//
// Body caps are the same zod limits as POST /api/send (subject 998,
// text 100k, html 200k, 10 attachments / 10 MB total); a body over
// ~300 KB is rejected with 413 before parsing.
// Threading: pass thread_id (from an earlier message) and/or
// in_reply_to (the Message-ID being answered) when replying, exactly
// as /api/send does; without them the send starts a new thread.
//
// Attachments (E5-6): two forms are accepted in the same `attachments`
// array (max 10 entries total):
//   1. Inline base64 (the simple integrator path):
//      {filename, content_type, content_base64}. Each file <= 2 MB
//      decoded, total <= 1 MB decoded (413 above). The file type must
//      be on the same allow-list as the UI upload path
//      (POST /api/attachments). Decoded bytes are stored in KV with
//      the EXACT same mechanism as the UI compose flow
//      (`att/<workspaceId>/<mailboxId>/...`, kvPut) and handed to
//      executeSend as object_key refs — no second attachment
//      pipeline. The KV key is derived from the content SHA-256 (not
//      a fresh UUID) so a retry with the same idempotency key and the
//      same content resolves to the same object_key: otherwise the
//      idempotency hash would differ and a legitimate retry would 409.
//   2. KV refs (the pre-uploaded form, as in Phase 2):
//      {attachment_id} or {object_key, file_name, content_type,
//      size_bytes} — resolved by lib/service-send.ts exactly as for
//      the UI path (10 MB total, 25 MB per file).
// Templates (Phase 1, live): template_id + variables are passed
// straight through to executeSend, exactly as POST /api/send does.
// The stored template supplies subject + html/text (the caller's
// text/html are ignored when template_id is set); an unknown
// template variable rejects with 400 from the render, and a missing
// template with 409 — both before the idempotency key is reserved.

// API attachment caps (E5-6): stricter than the UI path (10 MB total /
// 25 MB per file) because the base64 form travels inside the JSON
// body and the smallest free provider message cap (SendPulse, 1 MB)
// bounds what can actually be delivered.
const V1_MAX_ATTACHMENT_FILE_BYTES = 2 * 1024 * 1024;
const V1_MAX_TOTAL_ATTACHMENT_BYTES = 1 * 1024 * 1024;
// Base64 inflates bytes by 4/3: 1 MB of attachments is ~1.4 MB of
// JSON, plus text (100k) + html (200k) caps — 2 MB bounds the body.
const MAX_BODY_BYTES = 2 * 1024 * 1024;
// Max base64 chars for a 2 MB file: ceil(2 MiB / 3) * 4.
const MAX_BASE64_CHARS = 2800000;

// Content-type allow-list — the SAME list as the UI upload path
// (POST /api/attachments `allowed`). Keep the two in sync: a type
// added here must also be added there, and vice versa.
const ALLOWED_V1_ATTACHMENT_TYPES = new Set([
  'application/pdf',
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'text/plain',
  'text/csv',
  'application/zip',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
]);

const attachmentRefSchema = z
  .object({
    attachment_id: z.string().min(1).max(200).optional(),
    object_key: z.string().min(1).max(500).optional(),
    file_name: z.string().min(1).max(150).optional(),
    content_type: z.string().min(1).max(255).optional(),
    size_bytes: z.number().int().positive().max(25 * 1024 * 1024).optional(),
  })
  .refine(
    (x) =>
      !!(x.attachment_id || x.object_key) &&
      (!x.object_key || (x.file_name && x.size_bytes !== undefined)),
    {message: 'Each attachment needs attachment_id, or object_key with file_name and size_bytes.'},
  );

const attachmentBase64Schema = z.object({
  filename: z.string().min(1).max(150),
  content_type: z.string().min(1).max(255),
  content_base64: z.string().min(1).max(MAX_BASE64_CHARS),
});

const schema = z
  .object({
    to: z.string().email(),
    subject: z.string().min(1).max(998),
    text: z.string().max(100000).optional(),
    html: z.string().max(200000).optional(),
    template_id: z.string().uuid().optional(),
    variables: z.record(z.string().max(2000)).optional(),
    provider: z.enum(['auto', 'sendpulse', 'brevo', 'mailjet', 'resend']).default('auto'),
    mailbox_id: z.string().uuid().optional(),
    thread_id: z.string().uuid().optional(),
    in_reply_to: z.string().max(998).optional(),
    idempotency_key: z.string().max(200).optional(),
    attachments: z.array(z.union([attachmentRefSchema, attachmentBase64Schema])).max(10).optional(),
  })
  .refine((x) => !!(x.text || x.html || x.template_id));

type Base64AttachmentInput = z.infer<typeof attachmentBase64Schema>;

/** Same filename sanitising as POST /api/attachments. */
function sanitizeFilename(name: string): string {
  return name.normalize('NFKC').replace(/[^\w.() -]/g, '_').slice(0, 150) || 'attachment';
}

/**
 * Strict base64 decode. Node's decoder silently ignores invalid
 * characters, so the input is gated first (whitespace stripped,
 * length a multiple of 4, base64 alphabet only) and the decode is
 * verified by re-encoding: a non-canonical encoding is rejected.
 * Returns null on any invalid input.
 */
function decodeBase64Strict(raw: string): Buffer | null {
  const compact = raw.replace(/\s+/g, '');
  if (!compact || compact.length % 4 !== 0) return null;
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(compact)) return null;
  const buf = Buffer.from(compact, 'base64');
  if (buf.toString('base64') !== compact) return null;
  return buf;
}

/**
 * Validate + store inline-base64 attachments in KV (the UI compose
 * mechanism — see module header), returning the object_key refs that
 * executeSend resolves. Runs BEFORE executeSend, so a 400/413/502
 * here never reserves the idempotency key. Only the refs (never the
 * base64 bytes) are returned, so nothing bulky lands in D1 payloads.
 */
async function uploadBase64Attachments(
  workspaceId: string,
  mailboxId: string,
  inputs: Base64AttachmentInput[],
): Promise<
  | {ok: true; refs: SendAttachmentRef[]; objectKeys: string[]}
  | {ok: false; status: 400 | 413 | 502; error: string}
> {
  let total = 0;
  const decoded: Array<{fileName: string; contentType: string; bytes: Buffer}> = [];
  for (const input of inputs) {
    const fileName = sanitizeFilename(input.filename);
    if (!ALLOWED_V1_ATTACHMENT_TYPES.has(input.content_type))
      return {
        ok: false,
        status: 400,
        error: `Attachment "${fileName}": content_type "${input.content_type}" is not allowed. Allowed types: PDF, PNG, JPEG, GIF, WebP, plain text, CSV, ZIP, Word (.docx), Excel (.xlsx).`,
      };
    const bytes = decodeBase64Strict(input.content_base64);
    if (!bytes)
      return {
        ok: false,
        status: 400,
        error: `Attachment "${fileName}": content_base64 is not valid base64.`,
      };
    if (bytes.length < 1 || bytes.length > V1_MAX_ATTACHMENT_FILE_BYTES)
      return {
        ok: false,
        status: 413,
        error: `Attachment "${fileName}" exceeds the 2 MB per-file limit for API sends.`,
      };
    total += bytes.length;
    if (total > V1_MAX_TOTAL_ATTACHMENT_BYTES)
      return {
        ok: false,
        status: 413,
        error: 'Attachments exceed the 1 MB total limit for API sends.',
      };
    decoded.push({fileName, contentType: input.content_type, bytes});
  }
  const refs: SendAttachmentRef[] = [];
  const objectKeys: string[] = [];
  for (const f of decoded) {
    const digest = createHash('sha256').update(f.bytes).digest('hex');
    const objectKey = `att/${workspaceId}/${mailboxId}/${digest}-${f.fileName}`;
    try {
      await kvPut(objectKey, f.bytes, f.contentType);
    } catch {
      // Roll back the files already stored for this request.
      await Promise.all(objectKeys.map((k) => kvDelete(k).catch(() => {})));
      return {ok: false, status: 502, error: 'Could not store attachment.'};
    }
    objectKeys.push(objectKey);
    refs.push({
      object_key: objectKey,
      file_name: f.fileName,
      content_type: f.contentType,
      size_bytes: f.bytes.length,
    });
  }
  return {ok: true, refs, objectKeys};
}

// Same thread resolution as POST /api/send (G-11): explicit thread_id
// wins; else join the thread of the message named by in_reply_to; else
// start a new thread.
async function resolveSendThread(
  mailboxId: string,
  threadId: string | undefined,
  inReplyTo: string | undefined,
): Promise<{threadId: string; inReplyTo: string | null}> {
  if (threadId) return {threadId, inReplyTo: inReplyTo || null};
  if (inReplyTo) {
    const parent = await dbOne(
      'SELECT thread_id FROM messages WHERE mailbox_id = ? AND message_id = ? AND thread_id IS NOT NULL',
      [mailboxId, inReplyTo],
    );
    if (parent?.thread_id) return {threadId: String(parent.thread_id), inReplyTo};
  }
  return {threadId: newId(), inReplyTo: inReplyTo || null};
}

// Outbound-jobs bookkeeping, mirroring POST /api/send: accepted ->
// 'accepted', failed -> 'retry', unknown -> payload attached to the
// row executeSend already wrote, suppressed/rejected -> 'failed'.
// Best-effort only — a failure here never changes the send response.
async function recordOutboundJob(input: {
  workspaceId: string;
  mailboxId: string;
  to: string;
  subject: string;
  text?: string;
  html?: string;
  idempotencyKey: string;
  exec: SendExecution;
  threadId?: string;
  inReplyTo?: string;
  attachments?: SendAttachmentRef[];
}): Promise<void> {
  const {exec} = input;
  if (exec.outcome === 'duplicate') return;
  const now = nowIso();
  try {
    const box = await dbOne('SELECT id, address, display_name, domain_id FROM mailboxes WHERE id = ? AND workspace_id = ?', [
      input.mailboxId,
      input.workspaceId,
    ]);
    const payload = JSON.stringify({
      to: input.to,
      subject: input.exec.rendered?.subject ?? input.subject,
      text: input.exec.rendered?.text ?? input.text ?? '',
      html: input.exec.rendered?.html ?? input.html ?? '',
      mailboxId: input.mailboxId,
      mailboxAddress: box ? String(box.address) : '',
      domainId: box ? String(box.domain_id) : '',
      displayName: box?.display_name ? String(box.display_name) : null,
      attachments: input.attachments || [],
    });
    if (exec.outcome === 'unknown') {
      await dbRun(
        'UPDATE outbound_jobs SET payload = ?, updated_at = ? WHERE workspace_id = ? AND idempotency_key = ? AND status = ?',
        [payload, now, input.workspaceId, input.idempotencyKey, 'unknown'],
      );
      return;
    }
    if (exec.outcome === 'accepted' && exec.messageId) {
      const thread = await resolveSendThread(input.mailboxId, input.threadId, input.inReplyTo);
      await dbRun('UPDATE messages SET thread_id = ?, in_reply_to = ? WHERE id = ?', [
        thread.threadId,
        thread.inReplyTo,
        exec.messageId,
      ]).catch(() => {});
    }
    let status: string;
    let nextAttemptAt: string | null = null;
    let lastError: string | null = null;
    if (exec.outcome === 'accepted') status = 'accepted';
    else if (exec.outcome === 'failed') {
      status = 'retry';
      nextAttemptAt = computeNextAttemptIso(1);
      lastError = 'All configured providers rejected the send.';
    } else {
      status = 'failed';
      lastError =
        exec.outcome === 'suppressed'
          ? 'Recipient is on the workspace suppression list.'
          : 'Send rejected (domain, limit, or idempotency).';
    }
    await dbRun(
      `INSERT INTO outbound_jobs (id, workspace_id, message_id, idempotency_key, status, provider, payload, attempts, next_attempt_at, last_error, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)
       ON CONFLICT(workspace_id, idempotency_key) DO UPDATE SET status = excluded.status, provider = excluded.provider, payload = excluded.payload, message_id = excluded.message_id, next_attempt_at = excluded.next_attempt_at, last_error = excluded.last_error, updated_at = excluded.updated_at`,
      [newId(), input.workspaceId, exec.messageId, input.idempotencyKey, status, exec.provider, payload, nextAttemptAt, lastError, now, now],
    );
  } catch {
    // Bookkeeping must never fail the send response.
  }
}

export async function POST(req: Request) {
  const auth = await authenticateApiKeyWithScope(req, 'send');
  if (!auth.ok) return NextResponse.json({error: auth.error}, {status: auth.status});
  const {auth: key} = auth;

  const rl = await checkRateLimit({
    scope: 'v1_send',
    subject: key.keyId,
    limit: V1_RATE_LIMITS.v1_send.limit,
    windowSeconds: V1_RATE_LIMITS.v1_send.windowSeconds,
  });
  if (!rl.allowed) return rateLimitResponse(rl);

  const contentLength = Number(req.headers.get('content-length') || '0');
  if (contentLength > MAX_BODY_BYTES)
    return NextResponse.json({error: 'Request body too large.'}, {status: 413});
  const raw = await req.json().catch(() => null);
  const parsed = schema.safeParse(raw);
  if (!parsed.success)
    return NextResponse.json({error: 'Invalid message', details: parsed.error.flatten()}, {status: 400});
  const d = parsed.data;

  // Resolve the sender mailbox: explicit id must belong to this
  // workspace and be active (foreign/nonexistent ids get the same
  // 403, so a cross-tenant probe learns nothing); otherwise the
  // workspace default (earliest active mailbox).
  const box = d.mailbox_id
    ? await dbOne(
        'SELECT id, address, display_name, domain_id FROM mailboxes WHERE id = ? AND workspace_id = ? AND is_active = 1',
        [d.mailbox_id, key.workspaceId],
      )
    : await dbOne(
        'SELECT id, address, display_name, domain_id FROM mailboxes WHERE workspace_id = ? AND is_active = 1 ORDER BY created_at ASC LIMIT 1',
        [key.workspaceId],
      );
  if (!box)
    return NextResponse.json({error: 'No mailbox available for this workspace.'}, {status: 403});

  // Inline-base64 attachments are decoded + stored in KV BEFORE the
  // send runs (so a bad file never reserves the idempotency key).
  // The merged refs — uploaded files + any KV refs the caller passed
  // — are what executeSend resolves, exactly as for the UI path.
  const base64Inputs = (d.attachments || []).filter(
    (a): a is Base64AttachmentInput => 'content_base64' in a,
  );
  const refAttachments: SendAttachmentRef[] = (d.attachments || []).filter(
    (a): a is SendAttachmentRef => !('content_base64' in a),
  );
  let uploadedObjectKeys: string[] = [];
  let attachments: SendAttachmentRef[] = refAttachments;
  if (base64Inputs.length > 0) {
    const uploaded = await uploadBase64Attachments(key.workspaceId, String(box.id), base64Inputs);
    if (!uploaded.ok) return NextResponse.json({error: uploaded.error}, {status: uploaded.status});
    uploadedObjectKeys = uploaded.objectKeys;
    attachments = [...refAttachments, ...uploaded.refs];
  }

  const idempotencyKey = req.headers.get('idempotency-key') || d.idempotency_key || randomUUID();
  const exec = await executeSend(
    {
      workspaceId: key.workspaceId,
      sender: {
        id: String(box.id),
        address: String(box.address),
        display_name: box.display_name ? String(box.display_name) : null,
        domain_id: String(box.domain_id),
      },
      to: d.to,
      subject: d.subject,
      text: d.text,
      html: d.html,
      idempotencyKey,
      provider: d.provider,
      attachments,
      templateId: d.template_id,
      variables: d.variables,
    },
    {kind: 'user', userId: key.createdBy},
  );
  // Terminal rejections only: the send did not happen and nothing
  // will retry it, so the KV files uploaded for this request are
  // removed (a later retry re-uploads them — the keys are content
  // derived). Accepted / duplicate / unknown / failed outcomes KEEP
  // the files: the sent message references them, or the retry worker
  // re-resolves them from the stored outbound-jobs payload.
  if ((exec.outcome === 'rejected' || exec.outcome === 'suppressed') && uploadedObjectKeys.length > 0) {
    await Promise.all(uploadedObjectKeys.map((k) => kvDelete(k).catch(() => {})));
  }
  await recordOutboundJob({
    workspaceId: key.workspaceId,
    mailboxId: String(box.id),
    to: d.to,
    subject: d.subject,
    text: d.text,
    html: d.html,
    idempotencyKey,
    exec,
    threadId: d.thread_id,
    inReplyTo: d.in_reply_to,
    attachments,
  });
  return NextResponse.json(exec.body, {status: exec.status});
}
