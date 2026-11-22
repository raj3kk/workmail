// WorkMail internal service-authenticated send.
//
// This module is the ONE place that executes an outbound send, shared by
// the user-session path (POST /api/send) and the service path (AI
// auto-reply). Both callers run the exact same pipeline, so the service
// path NEVER bypasses anything the user path enforces:
//   - idempotency keys (same key + same content = duplicate, never a
//     second delivery; a key stuck in `processing`/`unknown` = 409),
//   - monthly workspace send limit,
//   - suppression list (checked in the route AND re-checked by the
//     fallback engine before every provider attempt),
//   - per-provider caps, and the timeout = `unknown` rule: an unknown
//     provider outcome stops the chain, marks the key `unknown`, records
//     an outbound job for /api/ops/reconcile, and is NEVER blindly
//     resent.
//   - attachments: when the caller passes attachment refs, they are
//     resolved here (ownership-scoped to this workspace + mailbox, total
//     cap enforced) and handed to the fallback engine, so every provider
//     attempt carries the same files. See `resolveSendAttachments`.
//     AI auto-replies rarely carry attachments, but the service path
//     must not drop them if present.
//
// Service authentication (HTTP boundary only):
//   - Header: `Authorization: Bearer <token>` — the token is NEVER read
//     from query strings, bodies, or cookies.
//   - Token env var name: OPS_CRON_TOKEN (already set as a host var; the
//     value is never logged, never returned, never committed).
//   - Comparison is timing-safe (SHA-256 both sides, timingSafeEqual),
//     the same pattern as /api/ops/reconcile. A missing/empty expected
//     token never matches.
//   - The service token is accepted ONLY for AI auto-reply sends
//     (service_context 'ai-auto-reply', enforced in the route). It is
//     not a general-purpose send credential.
//
// Trust boundary for in-process callers: `executeServiceSend` is also
// called directly (same process, no HTTP hop) by lib/ai.ts
// `maybeAutoReply`, which itself is only reachable from the inbound
// webhook — an entry point already authenticated by its own token
// (INBOUND_WEBHOOK_TOKEN). There is no bearer token to present on an
// in-process call; the OPS_CRON_TOKEN check lives at the HTTP boundary
// (the /api/send service branch, via `validateServiceToken`), and the
// in-process caller is inside the same trust domain as that boundary.
//
// Logging: service sends emit one structured JSON line
// (event 'service_send') carrying metadata only — workspace, mailbox,
// outcome, provider, message id, idempotency key. Never message bodies,
// never secrets, never the token.
import {createHash, randomUUID, timingSafeEqual} from 'node:crypto';
import {dbOne, dbQuery, dbRun, newId, nowIso} from '@/lib/db';
import {decryptSecret} from '@/lib/crypto';
import {kvGet} from '@/lib/kv';
import {autoMirrorMessage} from '@/lib/gmail-mirror';
import {
  sendWithFallback,
  MAX_ATTACHMENT_COUNT,
  MAX_ATTACHMENT_FILE_BYTES,
  MAX_TOTAL_ATTACHMENT_BYTES,
  type ConfiguredProvider,
  type ProviderName,
  type SendAttachment,
} from '@/lib/providers';
import {
  buildUnsubscribeMailto,
  deriveBrandFromDomain,
  getTemplate,
  htmlToText,
  renderTemplateHtml,
  renderTemplateText,
  unsubscribeFooterHtml,
  unsubscribeFooterText,
  UnknownTemplateVariableError,
} from '@/lib/templates';

export const SERVICE_AUTH_HEADER = 'authorization';
export const SERVICE_TOKEN_ENV_VAR = 'OPS_CRON_TOKEN';
/** The only service use the token authorises. Anything else is rejected. */
export const SERVICE_CONTEXT_AI_AUTO_REPLY = 'ai-auto-reply';

// --- Service-token validation (header only, timing-safe) -------------------

function serviceTokenMatches(supplied: string): boolean {
  const expected = process.env[SERVICE_TOKEN_ENV_VAR] || '';
  if (!supplied || !expected) return false;
  const a = createHash('sha256').update(supplied).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

/** True when `authHeader` (`Authorization: Bearer <token>`) carries the valid service token. */
export function validateServiceToken(authHeader: string | null): boolean {
  if (!authHeader) return false;
  const supplied = authHeader.replace(/^Bearer\s+/i, '');
  return serviceTokenMatches(supplied);
}

/** True when the request bears a valid service token in the Authorization header. Never reads query strings. */
export function isServiceAuthenticated(req: Request): boolean {
  return validateServiceToken(req.headers.get(SERVICE_AUTH_HEADER));
}

// --- Attachment resolution --------------------------------------------------
// Compose uploads a file first (POST /api/attachments, bytes in KV) and
// the send references it. Two reference forms are accepted:
//   1. `{attachment_id}` — a `message_attachments` row id. The row must
//      belong to this workspace AND this mailbox; any other id (foreign
//      tenant, or nonexistent) is 404, deliberately the same response
//      for both, so a cross-tenant probe cannot confirm another
//      tenant's file exists (same pattern as GET /api/messages/[id]).
//   2. `{object_key, file_name, content_type, size_bytes}` — a file
//      uploaded WITHOUT a message_id (the normal compose flow: the
//      sent message does not exist yet, so no row exists to reference).
//      Ownership is proven by the KV key prefix
//      `att/<workspaceId>/<mailboxId>/` — the same check PATCH
//      /api/messages/[id] `attach` uses — so a caller cannot name
//      another tenant's bytes.
// Caps (documented in docs/FREE-PROVIDER-QUOTAS.md "Attachments"):
//   per file <= 25 MB (KV value cap, enforced at upload), total per
//   message <= 10 MB, max 10 files. Over-cap is 413, before any
//   provider is called and before the idempotency key is reserved.
// Bytes are read from KV one file at a time and base64-encoded once;
//   with the 10 MB total cap the peak extra memory is bounded (~14 MB
//   base64). Attachment bytes / base64 are NEVER logged and NEVER
//   appear in error responses — only filename + size.

export interface SendAttachmentRef {
  attachment_id?: string;
  object_key?: string;
  file_name?: string;
  content_type?: string;
  size_bytes?: number;
}

export type ResolvedAttachments =
  | {ok: true; attachments: SendAttachment[]}
  | {ok: false; status: number; error: string};

/** Make filenames unique within one message (SendPulse's
 *  `attachments_binary` is a filename-keyed object, so a duplicate name
 *  would silently drop a file). `report (2).pdf`, `report (3).pdf`. */
function uniqueFilenames(names: string[]): string[] {
  const seen = new Map<string, number>();
  return names.map((name) => {
    const n = (seen.get(name) || 0) + 1;
    seen.set(name, n);
    if (n === 1) return name;
    const dot = name.lastIndexOf('.');
    return dot > 0 ? `${name.slice(0, dot)} (${n})${name.slice(dot)}` : `${name} (${n})`;
  });
}

export async function resolveSendAttachments(
  workspaceId: string,
  mailboxId: string,
  refs: SendAttachmentRef[],
): Promise<ResolvedAttachments> {
  // Dedupe identical refs (same row id / same object key) — a repeated
  // entry must not send the file twice or double-count the cap.
  const seenRef = new Set<string>();
  const deduped = refs.filter((r) => {
    const k = r.attachment_id ? `id:${r.attachment_id}` : `key:${r.object_key || ''}`;
    if (seenRef.has(k)) return false;
    seenRef.add(k);
    return true;
  });
  if (deduped.length === 0) return {ok: true, attachments: []};
  if (deduped.length > MAX_ATTACHMENT_COUNT)
    return {ok: false, status: 413, error: `Too many attachments (max ${MAX_ATTACHMENT_COUNT} per message).`};

  // Resolve the metadata for both forms into one uniform list.
  type Meta = {fileName: string; contentType: string; sizeBytes: number; objectKey: string};
  const metas: Meta[] = [];
  const idRefs = deduped.filter((r) => r.attachment_id);
  if (idRefs.length > 0) {
    const ids = idRefs.map((r) => r.attachment_id as string);
    const rows = await dbQuery(
      `SELECT id, file_name, content_type, size_bytes, object_key FROM message_attachments
       WHERE workspace_id = ? AND mailbox_id = ? AND id IN (${ids.map(() => '?').join(',')})`,
      [workspaceId, mailboxId, ...ids],
    );
    const byId = new Map(rows.map((row) => [String(row.id), row]));
    for (const r of idRefs) {
      const row = byId.get(r.attachment_id as string);
      // 404 for foreign AND nonexistent ids alike — never confirm
      // whether another tenant's id exists.
      if (!row) return {ok: false, status: 404, error: 'Attachment not found.'};
      metas.push({
        fileName: String(row.file_name),
        contentType: String(row.content_type),
        sizeBytes: Number(row.size_bytes),
        objectKey: String(row.object_key),
      });
    }
  }
  const keyPrefix = `att/${workspaceId}/${mailboxId}/`;
  for (const r of deduped.filter((x) => !x.attachment_id)) {
    const key = String(r.object_key || '');
    if (!key.startsWith(keyPrefix))
      return {ok: false, status: 404, error: 'Attachment not found.'};
    if (!r.file_name || r.size_bytes === undefined)
      return {ok: false, status: 400, error: 'Attachment object_key requires file_name and size_bytes.'};
    metas.push({
      fileName: r.file_name,
      contentType: r.content_type || 'application/octet-stream',
      sizeBytes: r.size_bytes,
      objectKey: key,
    });
  }

  // Caps on declared sizes first (cheap rejection before any KV read).
  let declaredTotal = 0;
  for (const m of metas) {
    if (!Number.isFinite(m.sizeBytes) || m.sizeBytes < 1 || m.sizeBytes > MAX_ATTACHMENT_FILE_BYTES)
      return {ok: false, status: 413, error: 'Attachment exceeds the 25 MB per-file limit.'};
    declaredTotal += m.sizeBytes;
  }
  if (declaredTotal > MAX_TOTAL_ATTACHMENT_BYTES)
    return {ok: false, status: 413, error: 'Attachments exceed the 10 MB total limit per message.'};

  // Fetch bytes one file at a time; re-check the cap against ACTUAL
  // bytes (metadata could be stale) and stop at the first failure.
  const names = uniqueFilenames(metas.map((m) => m.fileName));
  const attachments: SendAttachment[] = [];
  let actualTotal = 0;
  for (let i = 0; i < metas.length; i++) {
    const m = metas[i];
    let bytes: Buffer | null;
    try {
      bytes = await kvGet(m.objectKey);
    } catch {
      return {ok: false, status: 502, error: 'Could not read attachment.'};
    }
    if (!bytes) return {ok: false, status: 404, error: 'Attachment bytes not found.'};
    if (bytes.length > MAX_ATTACHMENT_FILE_BYTES)
      return {ok: false, status: 413, error: 'Attachment exceeds the 25 MB per-file limit.'};
    actualTotal += bytes.length;
    if (actualTotal > MAX_TOTAL_ATTACHMENT_BYTES)
      return {ok: false, status: 413, error: 'Attachments exceed the 10 MB total limit per message.'};
    attachments.push({
      filename: names[i],
      contentType: m.contentType,
      sizeBytes: bytes.length,
      base64: bytes.toString('base64'),
      objectKey: m.objectKey,
    });
  }
  return {ok: true, attachments};
}

// --- Shared send execution --------------------------------------------------

export interface ResolvedSender {
  id: string;
  address: string;
  display_name: string | null;
  domain_id: string;
}

export interface ExecuteSendInput {
  workspaceId: string;
  sender: ResolvedSender;
  to: string;
  subject: string;
  text?: string;
  html?: string;
  /** Caller-supplied key; when absent a fresh UUID is used. */
  idempotencyKey?: string;
  /** Manual provider pick ('auto' = fallback chain). Default 'auto'.
   *  A manual pick is validated before any provider is called: the
   *  workspace must have an enabled + sender-verified provider_secrets
   *  row for it, otherwise the send is rejected with 409 and NO
   *  attempt is made (no host-env fallback for a manual pick). */
  provider?: 'auto' | 'sendpulse' | 'brevo' | 'mailjet' | 'resend';
  /** Draft row id to DELETE once the send is provider-accepted
   *  (accepted sends and duplicates-of-accepted only — never on
   *  failed / unknown / suppressed / rejected). */
  draftId?: string;
  /** Attachment refs (see `resolveSendAttachments`). Resolved before
   *  the idempotency key is reserved, so a 404/413 never consumes it,
   *  and included in the request hash, so reusing a key with different
   *  attachments is a 409. */
  attachments?: SendAttachmentRef[];
  /** Template to render server-side (lib/templates.ts). The stored
   *  template is the content: subject + html/text are rendered from it
   *  and the caller's `text`/`html` (if any) are ignored. Unknown
   *  template variables reject the send with 400 — never silently
   *  dropped. */
  templateId?: string;
  /** Values for the template's variables (name, otp, action_url, ...).
   *  `sender_name` and `unsubscribe_url` are always supplied by the
   *  server and cannot be overridden by the caller. */
  variables?: Record<string, string>;
  /** Unsubscribe address for this send (a mailto: link). Supplied by
   *  bulk sends and template sends; when present, the List-Unsubscribe
   *  header is set and the footer link is appended unless the rendered
   *  HTML already carries it. */
  unsubscribeUrl?: string;
}

export interface SendActor {
  kind: 'user' | 'service';
  userId: string | null;
  serviceContext?: string | null;
}

export type SendOutcome = 'accepted' | 'duplicate' | 'unknown' | 'failed' | 'suppressed' | 'rejected';

export interface SendExecution {
  /** HTTP status the route should return. */
  status: number;
  /** JSON body the route should return. */
  body: Record<string, unknown>;
  outcome: SendOutcome;
  provider: ProviderName | null;
  providerMessageId: string | null;
  /** D1 messages row id of the accepted send, or null. */
  messageId: string | null;
  /** Final rendered text/html (after template render + footer). The
   *  route stores these in the outbound_jobs payload so a retry
   *  re-sends the rendered content, not the unrendered template. */
  rendered?: {subject?: string; text?: string; html?: string};
}

/** Workspace names that are not a real brand (setup defaults, generic
 *  words). A workspace with one of these names falls through to the
 *  domain brand part instead of sending as e.g. "My Workspace". */
const GENERIC_WORKSPACE_NAMES = new Set([
  'workmail',
  'my workspace',
  'workspace',
  'default',
  'untitled',
  'new workspace',
  'personal',
  'test',
  'demo',
  'my business',
  'business',
  'my company',
  'company',
]);

/**
 * From-name fallback (D3). Mailbox display_name first; then the
 * workspace name when it looks like a real brand; then the domain
 * brand part (flow99.in -> Flow99). There is NO hard-coded brand
 * literal here and "WorkMail" is never used as a sender name.
 */
export async function resolveFromName(workspaceId: string, sender: ResolvedSender): Promise<string> {
  if (sender.display_name && sender.display_name.trim()) return sender.display_name.trim();
  const ws = await dbOne('SELECT name FROM workspaces WHERE id = ?', [workspaceId]);
  const rawName = ws ? String(ws.name || '').trim() : '';
  if (rawName && rawName.length >= 2 && rawName.length <= 80 && !GENERIC_WORKSPACE_NAMES.has(rawName.toLowerCase())) {
    // A workspace named e.g. "Flipify's Workspace" is the Flipify
    // brand with a generic suffix — strip the suffix before using it.
    const stripped = rawName
      .replace(/'s workspace$/i, '')
      .replace(/ workspace$/i, '')
      .trim();
    const candidate = stripped.length >= 2 ? stripped : rawName;
    if (candidate.length <= 80 && !GENERIC_WORKSPACE_NAMES.has(candidate.toLowerCase())) return candidate;
  }
  const wsName = rawName;
  const dom = await dbOne('SELECT domain FROM domains WHERE id = ?', [sender.domain_id]);
  const brand = deriveBrandFromDomain(dom ? String(dom.domain || '') : '');
  if (brand) return brand;
  return wsName || 'Mail';
}

async function markKey(
  workspaceId: string,
  key: string,
  status: string,
  extra: Record<string, unknown> = {},
): Promise<void> {
  const sets = ['status = ?'];
  const values: unknown[] = [status];
  if (extra.provider !== undefined) {
    sets.push('provider = ?');
    values.push(extra.provider);
  }
  if (extra.provider_message_id !== undefined) {
    sets.push('provider_message_id = ?');
    values.push(extra.provider_message_id);
  }
  if (extra.message_id !== undefined) {
    sets.push('message_id = ?');
    values.push(extra.message_id);
  }
  sets.push('updated_at = ?');
  values.push(nowIso(), workspaceId, key);
  await dbRun(`UPDATE idempotency_keys SET ${sets.join(', ')} WHERE workspace_id = ? AND idempotency_key = ?`, values);
}

const PROVIDER_DISPLAY: Record<ProviderName, string> = {
  sendpulse: 'SendPulse',
  brevo: 'Brevo',
  mailjet: 'Mailjet',
  resend: 'Resend',
};

/** Delete a draft row after a provider-accepted send. Returns true when
 *  no draft row with this id remains in 'drafts' afterwards (deleted, or
 *  already gone). Best-effort: a failure is logged, never thrown — the
 *  send was already accepted, and the caller reports the outcome via
 *  `draft_deleted` in the response body. */
async function deleteDraftRow(workspaceId: string, mailboxId: string, draftId: string): Promise<boolean> {
  try {
    await dbRun(
      "DELETE FROM messages WHERE id = ? AND mailbox_id = ? AND workspace_id = ? AND folder = 'drafts'",
      [draftId, mailboxId, workspaceId],
    );
    const remaining = await dbOne("SELECT id FROM messages WHERE id = ? AND folder = 'drafts'", [draftId]);
    return !remaining;
  } catch (e) {
    console.log(
      JSON.stringify({
        event: 'draft_delete_failed',
        workspace_id: workspaceId,
        mailbox_id: mailboxId,
        draft_id: draftId,
        error: e instanceof Error ? e.message : 'unknown error',
      }),
    );
    return false;
  }
}

/** Log a failed bookkeeping step on the accepted path (markKey, usage,
 *  audit). The send was already accepted by the provider, so the step
 *  is logged with the key / workspace / message id and the send still
 *  returns 'accepted' — one failing bookkeeping step must never turn
 *  an accepted send into a failure. */
function logBookkeepingFailure(step: string, workspaceId: string, key: string, messageId: string, e: unknown): void {
  console.log(
    JSON.stringify({
      event: 'send_bookkeeping_failed',
      step,
      workspace_id: workspaceId,
      idempotency_key: key,
      message_id: messageId,
      error: e instanceof Error ? e.message : 'unknown error',
    }),
  );
}

/**
 * Execute one outbound send through the provider fallback engine.
 * Identical pipeline for the user-session caller and the service caller:
 * domain verification, idempotency, monthly limit, suppression, provider
 * configs, fallback engine, and the accepted / unknown / suppressed /
 * failed outcome handling (including the timeout=unknown + no-blind-resend
 * rules). The caller is responsible for resolving + authorising the
 * sender mailbox before calling this.
 */
export async function executeSend(input: ExecuteSendInput, actor: SendActor): Promise<SendExecution> {
  const key = input.idempotencyKey || randomUUID();
  const sender = input.sender;

  // Metadata-only service-send log line, emitted once per execution.
  const finish = (exec: SendExecution): SendExecution => {
    if (actor.kind === 'service') {
      console.log(
        JSON.stringify({
          event: 'service_send',
          actor: 'service',
          service_context: actor.serviceContext || null,
          workspace_id: input.workspaceId,
          mailbox_id: sender.id,
          outcome: exec.outcome,
          provider: exec.provider,
          message_id: exec.messageId,
          idempotency_key: key,
        }),
      );
    }
    return exec;
  };

  const domain = await dbOne('SELECT ownership_status, dns_status FROM domains WHERE id = ?', [sender.domain_id]);
  if (!domain || domain.ownership_status !== 'verified' || domain.dns_status !== 'verified')
    return finish({
      status: 409,
      body: {error: 'Verify domain ownership and email DNS before sending.'},
      outcome: 'rejected',
      provider: null,
      providerMessageId: null,
      messageId: null,
    });

  // From-name (D3) — resolved once, used by the template context, the
  // provider From header, and the unsubscribe footer alike.
  const fromName = await resolveFromName(input.workspaceId, sender);
  // Unsubscribe address for this send: explicit (bulk) or the sender
  // mailto for template sends. Plain single sends without a template
  // carry neither header nor footer.
  const unsubscribeUrl = input.unsubscribeUrl || (input.templateId ? buildUnsubscribeMailto(sender.address) : undefined);

  // Template render (server-side only). Runs BEFORE the idempotency key
  // is reserved, so a missing template or an unknown variable rejects
  // with 400 and consumes nothing. The rendered subject/html/text are
  // what is hashed, sent to providers, and stored as the message.
  let finalSubject = input.subject;
  let finalText = input.text;
  let finalHtml = input.html;
  if (input.templateId) {
    const template = await getTemplate(input.workspaceId, input.templateId);
    if (!template)
      return finish({
        status: 409,
        body: {error: 'Template not found for this workspace.'},
        outcome: 'rejected',
        provider: null,
        providerMessageId: null,
        messageId: null,
      });
    const ctx: Record<string, string> = {
      ...(input.variables || {}),
      sender_name: fromName,
      unsubscribe_url: unsubscribeUrl || buildUnsubscribeMailto(sender.address),
    };
    try {
      finalSubject = renderTemplateText(template.subject, ctx, true);
      finalHtml = renderTemplateHtml(template.html_body, ctx, true);
      finalText = template.text_body
        ? renderTemplateText(template.text_body, ctx, true)
        : htmlToText(finalHtml);
    } catch (e) {
      if (e instanceof UnknownTemplateVariableError)
        return finish({
          status: 400,
          body: {error: e.message, unknown_variables: e.variables},
          outcome: 'rejected',
          provider: null,
          providerMessageId: null,
          messageId: null,
        });
      throw e;
    }
  }
  // List-Unsubscribe footer: appended when this send carries an
  // unsubscribe address and the rendered HTML does not already link it
  // (template footers already do). The header is passed to the provider
  // call below; the footer is part of the stored message body.
  if (unsubscribeUrl) {
    if (finalHtml && !finalHtml.includes(unsubscribeUrl))
      finalHtml = finalHtml + unsubscribeFooterHtml(fromName, unsubscribeUrl);
    if (finalText && !finalText.includes(unsubscribeUrl))
      finalText = finalText + unsubscribeFooterText(fromName, unsubscribeUrl);
    else if (!finalText && finalHtml) finalText = htmlToText(finalHtml);
  }

  // Manual provider pick (F1/F2): validate BEFORE any provider is
  // called and before the idempotency key is reserved, so a rejected
  // pick consumes nothing and makes NO send attempt. The workspace
  // must have a provider_secrets row for the picked provider with
  // enabled = 1 AND sender_verified = 1. No host-env fallback for a
  // manual pick: a workspace that never connected the provider (or
  // never verified its sender) gets a clear 409, never a silent send
  // from a host key.
  const pickedProvider =
    input.provider && input.provider !== 'auto' ? (input.provider as ProviderName) : null;
  if (pickedProvider) {
    const verifiedRow = await dbOne(
      'SELECT provider FROM provider_secrets WHERE workspace_id = ? AND provider = ? AND enabled = 1 AND sender_verified = 1',
      [input.workspaceId, pickedProvider],
    );
    if (!verifiedRow)
      return finish({
        status: 409,
        body: {
          error: `${PROVIDER_DISPLAY[pickedProvider]} is not enabled and sender-verified for this workspace — pick Auto or another provider.`,
        },
        outcome: 'rejected',
        provider: null,
        providerMessageId: null,
        messageId: null,
      });
  }

  // Attachments resolve BEFORE the idempotency key is reserved: a
  // 404 (foreign/missing id) or 413 (over cap) must not consume the
  // key, and must not reach any provider.
  let attachments: SendAttachment[] = [];
  if (input.attachments?.length) {
    const resolved = await resolveSendAttachments(input.workspaceId, sender.id, input.attachments);
    if (!resolved.ok)
      return finish({
        status: resolved.status,
        body: {error: resolved.error},
        outcome: 'rejected',
        provider: null,
        providerMessageId: null,
        messageId: null,
      });
    attachments = resolved.attachments;
  }
  const attachmentHash = (input.attachments || [])
    .map((r) => (r.attachment_id ? `id:${r.attachment_id}` : `key:${r.object_key || ''}`))
    .sort();

  const hash = createHash('sha256')
    .update(JSON.stringify({to: input.to, subject: finalSubject, text: finalText, html: finalHtml, mailbox: sender.id, template: input.templateId || null, attachments: attachmentHash}))
    .digest('hex');
  const existing = await dbOne(
    'SELECT * FROM idempotency_keys WHERE workspace_id = ? AND idempotency_key = ?',
    [input.workspaceId, key],
  );
  if (existing) {
    if (existing.request_hash !== hash)
      return finish({
        status: 409,
        body: {error: 'Idempotency key reused with different content'},
        outcome: 'rejected',
        provider: null,
        providerMessageId: null,
        messageId: null,
      });
    if (existing.status === 'accepted') {
      // Duplicate of an accepted send: the draft (if any) is deleted
      // here too — the send already happened, so no orphan may remain.
      let draftDeleted = true;
      if (input.draftId) draftDeleted = await deleteDraftRow(input.workspaceId, sender.id, input.draftId);
      return finish({
        status: 200,
        body: {
          success: true,
          duplicate: true,
          provider: existing.provider,
          messageId: existing.provider_message_id,
          sent_message_id: existing.message_id ? String(existing.message_id) : null,
          delivery_state: 'accepted',
          draft_deleted: draftDeleted,
        },
        outcome: 'duplicate',
        provider: (existing.provider as ProviderName) || null,
        providerMessageId: existing.provider_message_id ? String(existing.provider_message_id) : null,
        messageId: existing.message_id ? String(existing.message_id) : null,
      });
    }
    if (existing.status === 'processing' || existing.status === 'unknown')
      return finish({
        status: 202,
        body: {
          error:
            'This send is already processing or has an unknown provider outcome. Check delivery logs before retrying.',
          outcome: 'unknown',
        },
        outcome: 'unknown',
        provider: null,
        providerMessageId: null,
        messageId: null,
      });
    return finish({
      status: 409,
      body: {error: 'This send request was already used and did not complete. Check delivery logs before retrying.'},
      outcome: 'rejected',
      provider: null,
      providerMessageId: null,
      messageId: null,
    });
  }
  try {
    await dbRun(
      'INSERT INTO idempotency_keys (workspace_id, idempotency_key, request_hash, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
      [input.workspaceId, key, hash, 'processing', nowIso(), nowIso()],
    );
  } catch {
    return finish({
      status: 409,
      body: {error: 'Could not reserve send request'},
      outcome: 'rejected',
      provider: null,
      providerMessageId: null,
      messageId: null,
    });
  }
  const settings = await dbOne('SELECT monthly_send_limit FROM workspace_settings WHERE workspace_id = ?', [input.workspaceId]);
  const period = new Date().toISOString().slice(0, 7) + '-01';
  const usage = await dbOne('SELECT sent_count FROM usage_counters WHERE workspace_id = ? AND period_start = ?', [
    input.workspaceId,
    period,
  ]);
  if ((usage?.sent_count || 0) >= (settings?.monthly_send_limit || 300)) {
    await markKey(input.workspaceId, key, 'failed');
    return finish({
      status: 429,
      body: {error: 'Monthly sending limit reached.'},
      outcome: 'rejected',
      provider: null,
      providerMessageId: null,
      messageId: null,
    });
  }
  // Suppression is checked here for the fast 409, AND re-checked by the
  // fallback engine before every provider attempt (defence in depth).
  const suppressed = await dbOne('SELECT email, reason FROM suppressions WHERE workspace_id = ? AND email = ?', [
    input.workspaceId,
    input.to.toLowerCase(),
  ]);
  if (suppressed) {
    await markKey(input.workspaceId, key, 'failed');
    return finish({
      status: 409,
      body: {error: 'Recipient is on this workspace suppression list.', reason: suppressed.reason},
      outcome: 'suppressed',
      provider: null,
      providerMessageId: null,
      messageId: null,
    });
  }
  // Workspace provider rows (encrypted at rest). The engine also tries the
  // host env fallback for providers the workspace has not connected at all.
  // Rows whose sender is not verified are not eligible to send.
  const configs = await dbQuery(
    'SELECT provider, secret_ciphertext, priority, sender_verified FROM provider_secrets WHERE workspace_id = ? AND enabled = 1 ORDER BY priority ASC',
    [input.workspaceId],
  );
  const configured: ConfiguredProvider[] = [];
  for (const config of configs || []) {
    try {
      const secret = JSON.parse(decryptSecret(config.secret_ciphertext));
      configured.push({
        provider: config.provider as ProviderName,
        secret: {api_key: secret.api_key, api_secret: secret.api_secret || ''},
        senderVerified: config.sender_verified === 1,
      });
    } catch {
      // A corrupt / undecryptable row must not kill the whole send: the
      // engine logs it as unconfigured for that provider and moves on.
      // (The row stays in place for an admin to re-save.)
      console.log(
        JSON.stringify({
          event: 'provider_attempt',
          workspace_id: input.workspaceId,
          idempotency_key: key,
          provider: config.provider,
          result: 'decrypt_error',
          latency_ms: 0,
          cap: null,
          http_status: null,
          reason: 'stored provider secret could not be decrypted',
        }),
      );
    }
  }

  const from = sender.address;
  const name = fromName;
  // Providers the workspace explicitly disabled (enabled = 0): passed
  // to the engine so they are skipped entirely in auto mode (B-e) —
  // no attempt, no log, no env-fallback call.
  const disabledRows = await dbQuery(
    'SELECT provider FROM provider_secrets WHERE workspace_id = ? AND enabled = 0',
    [input.workspaceId],
  );
  const disabledProviders = (disabledRows || [])
    .map((r) => String(r.provider))
    .filter((p): p is ProviderName => p === 'sendpulse' || p === 'brevo' || p === 'mailjet' || p === 'resend');
  const result = await sendWithFallback(
    input.workspaceId,
    {
      from,
      fromName: name,
      to: input.to,
      subject: finalSubject,
      text: finalText,
      html: finalHtml,
      idempotencyKey: key,
      attachments,
      // List-Unsubscribe header (RFC 8058 mailto form) on every bulk
      // and template send. Plain single sends carry no header.
      headers: unsubscribeUrl ? {'List-Unsubscribe': `<${unsubscribeUrl}>`} : undefined,
    },
    configured,
    {onlyProvider: pickedProvider ?? undefined, disabledProviders},
  );

  if (result.outcome === 'accepted') {
    const msgId = newId();
    const now = nowIso();
    await dbRun(
      `INSERT INTO messages (id, workspace_id, mailbox_id, folder, from_email, to_email, subject, text_body, html_body, provider, delivery_state, message_id, received_at, created_at, updated_at)
       VALUES (?, ?, ?, 'sent', ?, ?, ?, ?, ?, ?, 'accepted', ?, ?, ?, ?)`,
      [msgId, input.workspaceId, sender.id, from, input.to, finalSubject, finalText || '', finalHtml || '', result.provider, key, now, now, now],
    );
    // Record the attachments on the sent message so the reader shows
    // them (GET /api/messages/[id] lists by message_id). A NEW row per
    // file is inserted even for `{attachment_id}` refs: the original
    // row still belongs to its draft/other message and is left alone;
    // the KV bytes are shared (same object_key), only metadata is
    // duplicated. Best-effort — a failure here must not fail the send.
    for (const a of attachments) {
      await dbRun(
        'INSERT INTO message_attachments (id, workspace_id, mailbox_id, message_id, file_name, content_type, size_bytes, object_key, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [newId(), input.workspaceId, sender.id, msgId, a.filename, a.contentType, a.sizeBytes, a.objectKey, now],
      ).catch(() => {});
    }
    // The provider accepted the send: the compose draft (if any) is
    // deleted here, server-side (B-c). Accepted only — never on
    // failed / unknown / suppressed / rejected.
    let draftDeleted = true;
    if (input.draftId) draftDeleted = await deleteDraftRow(input.workspaceId, sender.id, input.draftId);
    // Each bookkeeping step below is failure-isolated: one failing
    // step is logged and the send still returns 'accepted' — the
    // provider already accepted the message, so bookkeeping must
    // never turn it into a failure (B-d).
    await markKey(input.workspaceId, key, 'accepted', {
      provider: result.provider,
      provider_message_id: String(result.providerMessageId || ''),
      message_id: msgId,
    }).catch((e) => logBookkeepingFailure('markKey', input.workspaceId, key, msgId, e));
    await dbRun(
      `INSERT INTO usage_counters (workspace_id, period_start, sent_count, received_count, storage_bytes)
       VALUES (?, ?, 1, 0, 0)
       ON CONFLICT(workspace_id, period_start) DO UPDATE SET sent_count = usage_counters.sent_count + 1`,
      [input.workspaceId, period],
    ).catch((e) => logBookkeepingFailure('usage_counters', input.workspaceId, key, msgId, e));
    await dbRun(
      'INSERT INTO audit_events (id, workspace_id, actor_user_id, action, target_type, target_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [newId(), input.workspaceId, actor.userId, 'email.accepted', 'message', msgId, now],
    ).catch((e) => logBookkeepingFailure('audit_events', input.workspaceId, key, msgId, e));
    // Phase 4 Gmail backup mirror — auto-mirror hook (best-effort, never
    // throws, never blocks the accepted send; OFF by default per workspace).
    await autoMirrorMessage(input.workspaceId, msgId);
    return finish({
      status: 200,
      body: {
        success: true,
        provider: result.provider,
        messageId: result.providerMessageId,
        sent_message_id: msgId,
        delivery_state: 'accepted',
        draft_deleted: draftDeleted,
        attempts: result.attempts,
      },
      outcome: 'accepted',
      provider: result.provider,
      providerMessageId: result.providerMessageId,
      messageId: msgId,
      rendered: {subject: finalSubject, text: finalText, html: finalHtml},
    });
  }

  if (result.outcome === 'unknown') {
    // TIMEOUT: outcome unknown. Mark the key `unknown` (never `failed`),
    // record an outbound job so /api/ops/reconcile flags it, and return
    // 202. DO NOT resend, DO NOT try another provider — the engine already
    // stopped the chain. Reconciliation happens via the delivery webhook
    // or the ops reconcile endpoint, never by blind retry.
    await markKey(input.workspaceId, key, 'unknown', {provider: result.provider});
    try {
      await dbRun(
        `INSERT INTO outbound_jobs (id, workspace_id, message_id, idempotency_key, status, attempts, last_error, created_at, updated_at)
         VALUES (?, ?, NULL, ?, 'unknown', 1, ?, ?, ?)
         ON CONFLICT(workspace_id, idempotency_key) DO UPDATE SET status = 'unknown', last_error = excluded.last_error, updated_at = excluded.updated_at`,
        [
          newId(),
          input.workspaceId,
          key,
          'Provider outcome unknown after timeout. Do not resend until provider logs are checked.',
          nowIso(),
          nowIso(),
        ],
      );
    } catch {
      // The idempotency key already records the unknown outcome; the
      // outbound_jobs row is a convenience for reconcile, not a gate.
    }
    return finish({
      status: 202,
      body: {error: 'Provider outcome unknown after timeout. Do not resend until provider logs are checked.', attempts: result.attempts},
      outcome: 'unknown',
      provider: result.provider,
      providerMessageId: null,
      messageId: null,
    });
  }

  if (result.outcome === 'suppressed') {
    await markKey(input.workspaceId, key, 'failed');
    return finish({
      status: 409,
      body: {error: 'Recipient is on this workspace suppression list.', reason: result.reason, attempts: result.attempts},
      outcome: 'suppressed',
      provider: null,
      providerMessageId: null,
      messageId: null,
    });
  }

  // Every provider either rejected definitively, was capped, or was
  // unconfigured. The same idempotency key + content may be retried later
  // (a new attempt re-runs the chain); no message was accepted, so no
  // duplicate delivery is possible from this attempt.
  await markKey(input.workspaceId, key, 'failed');
  return finish({
    status: 502,
    body: {success: false, error: 'All configured providers rejected the send.', attempts: result.attempts},
    outcome: 'failed',
    provider: null,
    providerMessageId: null,
    messageId: null,
  });
}

// --- Service entry point ----------------------------------------------------
// Resolves the mailbox by id (must belong to the workspace and be active)
// and runs the shared pipeline as the service actor. No user session is
// involved. Callers over HTTP must have passed `validateServiceToken`
// first; the in-process caller (lib/ai.ts) runs inside the server behind
// the already-authenticated inbound webhook (see module header).
export async function executeServiceSend(input: {
  workspaceId: string;
  mailboxId: string;
  to: string;
  subject: string;
  text?: string;
  html?: string;
  idempotencyKey?: string;
  /** Draft row id to delete once the send is provider-accepted
   *  (passed through; the service path always sends with provider
   *  'auto' — a manual pick is never honoured here). */
  draftId?: string;
  /** Passed through unchanged — the service path must not drop
   *  attachments if an auto-reply ever carries them. */
  attachments?: SendAttachmentRef[];
  /** Template to render server-side (same rule as the user path). */
  templateId?: string;
  variables?: Record<string, string>;
}): Promise<SendExecution> {
  const box = await dbOne(
    'SELECT id, address, display_name, domain_id FROM mailboxes WHERE id = ? AND workspace_id = ? AND is_active = 1',
    [input.mailboxId, input.workspaceId],
  );
  if (!box) {
    console.log(
      JSON.stringify({
        event: 'service_send',
        actor: 'service',
        service_context: SERVICE_CONTEXT_AI_AUTO_REPLY,
        workspace_id: input.workspaceId,
        mailbox_id: input.mailboxId,
        outcome: 'rejected',
        provider: null,
        message_id: null,
        idempotency_key: input.idempotencyKey || null,
      }),
    );
    return {
      status: 403,
      body: {error: 'Mailbox not found or not active for this workspace.'},
      outcome: 'rejected',
      provider: null,
      providerMessageId: null,
      messageId: null,
    };
  }
  return executeSend(
    {
      workspaceId: input.workspaceId,
      sender: {
        id: String(box.id),
        address: String(box.address),
        display_name: box.display_name ? String(box.display_name) : null,
        domain_id: String(box.domain_id),
      },
      to: input.to,
      subject: input.subject,
      text: input.text,
      html: input.html,
      idempotencyKey: input.idempotencyKey,
      provider: 'auto',
      draftId: input.draftId,
      attachments: input.attachments,
      templateId: input.templateId,
      variables: input.variables,
    },
    {kind: 'service', userId: null, serviceContext: SERVICE_CONTEXT_AI_AUTO_REPLY},
  );
}
