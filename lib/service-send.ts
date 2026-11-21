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
import {
  sendWithFallback,
  type ConfiguredProvider,
  type ProviderName,
} from '@/lib/providers';

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

  const hash = createHash('sha256')
    .update(JSON.stringify({to: input.to, subject: input.subject, text: input.text, html: input.html, mailbox: sender.id}))
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
    if (existing.status === 'accepted')
      return finish({
        status: 200,
        body: {success: true, duplicate: true, provider: existing.provider, messageId: existing.provider_message_id},
        outcome: 'duplicate',
        provider: (existing.provider as ProviderName) || null,
        providerMessageId: existing.provider_message_id ? String(existing.provider_message_id) : null,
        messageId: existing.message_id ? String(existing.message_id) : null,
      });
    return finish({
      status: 409,
      body: {error: 'This send is already processing or has an unknown provider outcome. Check delivery logs before retrying.'},
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
  const name = sender.display_name || 'WorkMail';
  const result = await sendWithFallback(
    input.workspaceId,
    {
      from,
      fromName: name,
      to: input.to,
      subject: input.subject,
      text: input.text,
      html: input.html,
      idempotencyKey: key,
    },
    configured,
  );

  if (result.outcome === 'accepted') {
    const msgId = newId();
    const now = nowIso();
    await dbRun(
      `INSERT INTO messages (id, workspace_id, mailbox_id, folder, from_email, to_email, subject, text_body, html_body, provider, delivery_state, message_id, received_at, created_at, updated_at)
       VALUES (?, ?, ?, 'sent', ?, ?, ?, ?, ?, ?, 'accepted', ?, ?, ?, ?)`,
      [msgId, input.workspaceId, sender.id, from, input.to, input.subject, input.text || '', input.html || '', result.provider, key, now, now, now],
    );
    await markKey(input.workspaceId, key, 'accepted', {
      provider: result.provider,
      provider_message_id: String(result.providerMessageId || ''),
      message_id: msgId,
    });
    await dbRun(
      `INSERT INTO usage_counters (workspace_id, period_start, sent_count, received_count, storage_bytes)
       VALUES (?, ?, 1, 0, 0)
       ON CONFLICT(workspace_id, period_start) DO UPDATE SET sent_count = usage_counters.sent_count + 1`,
      [input.workspaceId, period],
    );
    await dbRun(
      'INSERT INTO audit_events (id, workspace_id, actor_user_id, action, target_type, target_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [newId(), input.workspaceId, actor.userId, 'email.accepted', 'message', msgId, now],
    );
    return finish({
      status: 200,
      body: {success: true, provider: result.provider, messageId: result.providerMessageId, attempts: result.attempts},
      outcome: 'accepted',
      provider: result.provider,
      providerMessageId: result.providerMessageId,
      messageId: msgId,
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
    },
    {kind: 'service', userId: null, serviceContext: SERVICE_CONTEXT_AI_AUTO_REPLY},
  );
}
