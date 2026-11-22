import {NextResponse} from 'next/server';
import {z} from 'zod';
import {randomUUID} from 'node:crypto';
import {dbOne, dbQuery, dbRun, newId, nowIso} from '@/lib/db';
import {requireUser, canAccessMailbox, workspaceRole, isValidOrigin} from '@/lib/guards';
import {withRateLimit, RATE_LIMIT_DEFAULTS} from '@/lib/rate-limit';
import {
  executeSend,
  type SendExecution,
} from '@/lib/service-send';
import {computeNextAttemptIso} from '@/lib/retry';

export const runtime = 'nodejs';

const schema = z
  .object({
    to: z.string().email(),
    subject: z.string().min(1).max(998),
    text: z.string().max(100000).optional(),
    html: z.string().max(200000).optional(),
    workspace_id: z.string().uuid(),
    mailbox_id: z.string().uuid().optional(),
    // G-11 threading: pass thread_id (from /api/threads or a previous
    // message) and/or in_reply_to (the Message-ID being answered) when
    // replying. Without them the send starts a new thread.
    thread_id: z.string().uuid().optional(),
    in_reply_to: z.string().max(998).optional(),
    // `idempotency_key` lets a caller use a deterministic key (one send
    // per key). The Idempotency-Key header still takes precedence.
    idempotency_key: z.string().max(200).optional(),
    // Provider pick (F1/F2): 'auto' = fallback chain (default), or one
    // of the four providers for a manual single-provider send. The
    // service path forces 'auto' regardless of what is passed here.
    provider: z.enum(['auto', 'sendpulse', 'brevo', 'mailjet', 'resend']).default('auto'),
    // Draft row id to delete once the send is provider-accepted
    // (server-side B-c cleanup; accepted sends only).
    draft_id: z.string().min(1).max(200).optional(),
    // Template to render server-side (lib/templates.ts). When set, the
    // stored template supplies subject + html/text and `text`/`html`
    // are ignored; `variables` supplies its values. Unknown variables
    // reject the send with 400 (see lib/service-send.ts).
    template_id: z.string().uuid().optional(),
    variables: z.record(z.string().max(2000)).optional(),
    // Attachments (see lib/service-send.ts `resolveSendAttachments`).
    // Each entry is either `{attachment_id}` (a message_attachments row
    // id belonging to the sender's workspace + mailbox) or
    // `{object_key, file_name, content_type, size_bytes}` (a file
    // uploaded via POST /api/attachments without a message_id — the
    // normal compose flow). Max 10 files; total <= 10 MB and per-file
    // <= 25 MB are enforced in the shared pipeline (413). Foreign ids
    // are 404 — never confirmed as existing or not.
    attachments: z
      .array(
        z
          .object({
            attachment_id: z.string().min(1).max(200).optional(),
            object_key: z.string().min(1).max(500).optional(),
            file_name: z.string().min(1).max(150).optional(),
            content_type: z.string().min(1).max(255).optional(),
            size_bytes: z
              .number()
              .int()
              .positive()
              .max(25 * 1024 * 1024)
              .optional(),
          })
          .refine(
            (x) =>
              !!(x.attachment_id || x.object_key) &&
              (!x.object_key || (x.file_name && x.size_bytes !== undefined)),
            {
              message:
                'Each attachment needs attachment_id, or object_key with file_name and size_bytes.',
            },
          ),
      )
      .max(10)
      .optional(),
  })
  .refine((x) => !!(x.text || x.html || x.template_id));

// --- G-11: thread resolution for an outbound send ---------------------------
// Explicit thread_id wins. Else, if in_reply_to names a message already in
// the mailbox, join its thread. Else start a new thread.
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

// --- G-23: outbound_jobs bookkeeping ----------------------------------------
// One row per send, keyed by (workspace_id, idempotency_key). The retry
// worker (lib/retry.ts, via /api/ops/reconcile) consumes `queued`/`retry`
// rows using the stored payload. Statuses:
//   accepted   -> 'accepted'  (terminal; provider + message recorded)
//   failed     -> 'retry'     (retryable: no provider accepted the mail,
//                  so a later attempt with a fresh key cannot duplicate)
//   unknown    -> already written by executeSend; only the payload is
//                  attached here for human reconciliation. NEVER retried.
//   suppressed/rejected -> 'failed' (terminal; retrying cannot help)
//   duplicate  -> nothing to record; the original send owns the row.
// Failures here are best-effort and never change the send response: the
// idempotency key is the source of truth for the outcome.
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
  // Attachment refs only (ids/keys + metadata, never bytes) so a later
  // retry can re-resolve the same files from KV. The retry worker must
  // pass them back through to the send pipeline.
  attachments?: Array<{
    attachment_id?: string;
    object_key?: string;
    file_name?: string;
    content_type?: string;
    size_bytes?: number;
  }>;
}): Promise<void> {
  const {exec} = input;
  if (exec.outcome === 'duplicate') return;
  const now = nowIso();
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
  try {
    if (exec.outcome === 'unknown') {
      // executeSend already wrote the 'unknown' row; attach the payload
      // so a human reconciling it can see what was (maybe) sent.
      await dbRun(
        'UPDATE outbound_jobs SET payload = ?, updated_at = ? WHERE workspace_id = ? AND idempotency_key = ? AND status = ?',
        [payload, now, input.workspaceId, input.idempotencyKey, 'unknown'],
      );
      return;
    }
    // G-11: thread the stored sent message (accepted sends only — the
    // message row exists only then).
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
    if (exec.outcome === 'accepted') {
      status = 'accepted';
    } else if (exec.outcome === 'failed') {
      status = 'retry';
      nextAttemptAt = computeNextAttemptIso(1);
      lastError = 'All configured providers rejected the send.';
    } else {
      // suppressed / rejected
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
      [
        newId(),
        input.workspaceId,
        exec.messageId,
        input.idempotencyKey,
        status,
        exec.provider,
        payload,
        nextAttemptAt,
        lastError,
        now,
        now,
      ],
    );
  } catch {
    // Bookkeeping must never fail the send response.
  }
}

// POST /api/send — ONE authenticated entry point, ONE send pipeline
// (lib/service-send.ts `executeSend`, shared so no path can bypass
// idempotency, suppression, caps, or the timeout=unknown rule):
//   User session only: session cookie via requireUser, workspace
//   membership + mailbox send permission, sender mailbox resolved
//   from the user's accessible mailboxes.
//
// G-02 (closed): the HTTP service branch is DELETED. It accepted
// `Authorization: Bearer <OPS_CRON_TOKEN>` and sent as any
// workspace/mailbox — a single-token arbitrary-send hole. The grep
// (2026-11-22) found NO live HTTP caller of it: the AI auto-reply
// calls `executeServiceSend` in-process (lib/ai.ts, no HTTP hop),
// the inbound worker calls only /api/inbound, no cron calls it
// (vercel.json has no crons), and the UI sends with a session cookie.
// Per decision D5 the branch dies rather than being kept "just in
// case". OPS_CRON_TOKEN still authenticates the ops routes
// (/api/ops/monitor, /api/ops/reconcile) — those are untouched.
// NOTE: lib/service-send.ts still exports validateServiceToken /
// executeServiceSend / SERVICE_CONTEXT_AI_AUTO_REPLY for the
// in-process AI caller; the HTTP validation half is now dead code
// owned by that file — Phase 3b / the coordinator may remove it.
export async function POST(req: Request) {
  if (!isValidOrigin(req))
    return NextResponse.json({error: 'Invalid origin'}, {status: 403});
  const raw = await req.json().catch(() => null);
  const {user, response} = await requireUser(req);
  if (response) return response;
  if (!user) return NextResponse.json({error: 'Unauthorized'}, {status: 401});
  const limited = await withRateLimit({
    scope: 'send',
    subject: user.id,
    limit: RATE_LIMIT_DEFAULTS.send.limit,
    windowSeconds: RATE_LIMIT_DEFAULTS.send.windowSeconds,
  });
  if (limited) return limited;
  const parsed = schema.safeParse(raw);
  if (!parsed.success)
    return NextResponse.json({error: 'Invalid message', details: parsed.error.flatten()}, {status: 400});
  const d = parsed.data;
  const memberRole = await workspaceRole(user.id, d.workspace_id);
  if (!memberRole) return NextResponse.json({error: 'Workspace access denied'}, {status: 403});
  const boxes = await dbQuery(
    'SELECT id, address, display_name, domain_id FROM mailboxes WHERE workspace_id = ? AND is_active = 1' +
      (d.mailbox_id ? ' AND id = ?' : '') +
      ' LIMIT 20',
    d.mailbox_id ? [d.workspace_id, d.mailbox_id] : [d.workspace_id],
  );
  let sender: any = null;
  for (const b of boxes) {
    if (await canAccessMailbox(user.id, String(b.id), true)) {
      sender = b;
      break;
    }
  }
  if (!sender)
    return NextResponse.json({error: 'No mailbox assigned to you with send permission.'}, {status: 403});
  const idempotencyKey = req.headers.get('idempotency-key') || d.idempotency_key || randomUUID();
  const exec = await executeSend(
    {
      workspaceId: d.workspace_id,
      sender: {
        id: String(sender.id),
        address: String(sender.address),
        display_name: sender.display_name ? String(sender.display_name) : null,
        domain_id: String(sender.domain_id),
      },
      to: d.to,
      subject: d.subject,
      text: d.text,
      html: d.html,
      idempotencyKey,
      provider: d.provider,
      draftId: d.draft_id,
      attachments: d.attachments,
      templateId: d.template_id,
      variables: d.variables,
    },
    {kind: 'user', userId: user.id},
  );
  await recordOutboundJob({
    workspaceId: d.workspace_id,
    mailboxId: String(sender.id),
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
