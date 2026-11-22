import {NextResponse} from 'next/server';
import {z} from 'zod';
import {randomUUID} from 'node:crypto';
import {dbOne, dbRun, newId, nowIso} from '@/lib/db';
import {authenticateApiKeyWithScope} from '@/lib/api-auth';
import {checkRateLimit, rateLimitResponse, V1_RATE_LIMITS} from '@/lib/rate-limit';
import {executeSend, type SendExecution} from '@/lib/service-send';
import {computeNextAttemptIso} from '@/lib/retry';

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
// NOTE on template_id: the field is accepted and validated here, but
// template rendering lives in lib/service-send.ts, which Phase 1 owns
// in parallel — until that lands, a request carrying template_id gets
// a clear 400 instead of silently sending untemplated mail. The
// coordinator wires it when Phase 1 merges; nothing else in this
// route needs to change.

const schema = z
  .object({
    to: z.string().email(),
    subject: z.string().min(1).max(998),
    text: z.string().max(100000).optional(),
    html: z.string().max(200000).optional(),
    template_id: z.string().uuid().optional(),
    provider: z.enum(['auto', 'sendpulse', 'brevo', 'mailjet', 'resend']).default('auto'),
    mailbox_id: z.string().uuid().optional(),
    thread_id: z.string().uuid().optional(),
    in_reply_to: z.string().max(998).optional(),
    idempotency_key: z.string().max(200).optional(),
    attachments: z
      .array(
        z
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
          ),
      )
      .max(10)
      .optional(),
  })
  .refine((x) => !!(x.text || x.html));

const MAX_BODY_BYTES = 300 * 1024;

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
  attachments?: Array<{attachment_id?: string; object_key?: string; file_name?: string; content_type?: string; size_bytes?: number}>;
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
      subject: input.subject,
      text: input.text || '',
      html: input.html || '',
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
  if (d.template_id)
    return NextResponse.json(
      {error: 'template_id is not available yet — email templates ship with Phase 1; send text/html directly for now.'},
      {status: 400},
    );

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
      attachments: d.attachments,
    },
    {kind: 'user', userId: key.createdBy},
  );
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
    attachments: d.attachments,
  });
  return NextResponse.json(exec.body, {status: exec.status});
}
