// Outbound retry worker logic (G-23).
//
// /api/send writes one `outbound_jobs` row per send (see
// app/api/send/route.ts). This module is the consumer: /api/ops/reconcile
// calls `processDueOutboundJobs()` on each tick and retries every due
// `queued`/`retry` job through the SAME shared pipeline
// (`executeSend` in lib/service-send.ts) as a first attempt — so a retry
// re-checks domain verification, the monthly cap, suppression and
// per-provider caps, and honours the timeout=unknown rule.
//
// RETRY POLICY (documented in docs/PRODUCTION-OPERATIONS.md):
//   - Only jobs in status `queued` or `retry` whose `next_attempt_at`
//     has passed are ever retried, at most MAX_RETRY_ATTEMPTS attempts.
//   - Backoff between attempts: 1m, 5m, 15m, 30m, 60m (capped at 60m).
//   - `unknown` rows are NEVER auto-retried: the provider outcome is
//     ambiguous (the mail may already have been delivered), so they are
//     left for manual/provider-log reconciliation only. This module does
//     not even select them.
//   - `failed` is terminal (suppression, definitive rejection, bad
//     payload, or attempts exhausted). A `failed` job is never retried.
//   - Each retry attempt uses a FRESH idempotency key
//     (`retry:<job-id>:<attempt>`): the original key is already marked
//     `failed` in `idempotency_keys`, and reusing it would 409. A fresh
//     key is safe because a `failed` outcome means no provider accepted
//     the mail, so no duplicate delivery is possible from the retry.
//   - Jobs are claimed with `locked_at` before work starts so two
//     concurrent reconcile ticks cannot retry the same job.
import {dbOne, dbQuery, dbRun, nowIso, jparse} from '@/lib/db';
import {executeSend, type ResolvedSender} from '@/lib/service-send';

/** Maximum send attempts per job (initial attempt + retries). */
export const MAX_RETRY_ATTEMPTS = 5;
/** Minutes to wait after attempt N fails, before attempt N+1. */
export const RETRY_BACKOFF_MINUTES = [1, 5, 15, 30, 60];

/** ISO timestamp of the next attempt after `attempts` failed attempts. */
export function computeNextAttemptIso(attempts: number, fromMs: number = Date.now()): string {
  const idx = Math.min(Math.max(attempts - 1, 0), RETRY_BACKOFF_MINUTES.length - 1);
  return new Date(fromMs + RETRY_BACKOFF_MINUTES[idx] * 60 * 1000).toISOString();
}

/** Only these statuses may be consumed by the retry worker. */
export function isRetryableJobStatus(status: string): boolean {
  return status === 'queued' || status === 'retry';
}

export interface RetryJobPayload {
  to: string;
  subject: string;
  text?: string;
  html?: string;
  mailboxId: string;
  mailboxAddress: string;
  domainId: string;
  displayName?: string | null;
}

export interface RetrySummary {
  reviewed: number;
  accepted: number;
  retried: number;
  failed: number;
  unknown: number;
  skipped: number;
}

async function markJob(
  jobId: string,
  status: string,
  extra: {attempts?: number; nextAttemptAt?: string | null; lastError?: string | null; provider?: string | null; messageId?: string | null} = {},
): Promise<void> {
  const sets = ['status = ?', 'updated_at = ?'];
  const values: unknown[] = [status, nowIso()];
  if (extra.attempts !== undefined) {
    sets.push('attempts = ?');
    values.push(extra.attempts);
  }
  if (extra.nextAttemptAt !== undefined) {
    sets.push('next_attempt_at = ?');
    values.push(extra.nextAttemptAt);
  }
  if (extra.lastError !== undefined) {
    sets.push('last_error = ?');
    values.push(extra.lastError);
  }
  if (extra.provider !== undefined) {
    sets.push('provider = ?');
    values.push(extra.provider);
  }
  if (extra.messageId !== undefined) {
    sets.push('message_id = ?');
    values.push(extra.messageId);
  }
  // Release the claim on every terminal transition.
  sets.push('locked_at = NULL');
  await dbRun(`UPDATE outbound_jobs SET ${sets.join(', ')} WHERE id = ?`, [...values, jobId]);
}

/**
 * Consume due `queued`/`retry` jobs: claim, re-send through the shared
 * pipeline, and update each row. Never touches `unknown` rows.
 */
export async function processDueOutboundJobs(limit = 25): Promise<RetrySummary> {
  const summary: RetrySummary = {reviewed: 0, accepted: 0, retried: 0, failed: 0, unknown: 0, skipped: 0};
  const now = nowIso();
  const due = await dbQuery(
    `SELECT * FROM outbound_jobs
     WHERE status IN ('queued','retry') AND next_attempt_at <= ?
       AND (locked_at IS NULL OR locked_at < ?)
     ORDER BY next_attempt_at ASC LIMIT ?`,
    [now, new Date(Date.now() - 15 * 60 * 1000).toISOString(), limit],
  );
  for (const job of due || []) {
    summary.reviewed++;
    const jobId = String(job.id);
    const attempts = Number(job.attempts || 0);
    // Claim: only proceed if we won the row (prevents double retry).
    const claimed = await dbRun(
      `UPDATE outbound_jobs SET status = 'processing', locked_at = ? WHERE id = ? AND status IN ('queued','retry')`,
      [now, jobId],
    );
    if (claimed.changes === 0) {
      summary.skipped++;
      continue;
    }
    const payload = jparse<RetryJobPayload | null>(String(job.payload || ''), null);
    if (!payload || !payload.to || !payload.subject || !payload.mailboxId) {
      await markJob(jobId, 'failed', {
        attempts: attempts + 1,
        lastError: 'Retry payload missing or unparseable; cannot resend safely.',
      });
      summary.failed++;
      continue;
    }
    // Suspended workspace: never send. Park the job as failed (terminal)
    // so it does not spin forever; an admin can re-queue it after review.
    const ws = await dbOne('SELECT suspended_at FROM workspaces WHERE id = ?', [job.workspace_id]);
    if (!ws || ws.suspended_at) {
      await markJob(jobId, 'failed', {
        attempts: attempts + 1,
        lastError: ws ? 'Workspace is suspended.' : 'Workspace not found.',
      });
      summary.failed++;
      continue;
    }
    const box = await dbOne(
      'SELECT id, address, display_name, domain_id FROM mailboxes WHERE id = ? AND workspace_id = ? AND is_active = 1',
      [payload.mailboxId, job.workspace_id],
    );
    if (!box) {
      await markJob(jobId, 'failed', {
        attempts: attempts + 1,
        lastError: 'Sender mailbox not found or no longer active.',
      });
      summary.failed++;
      continue;
    }
    const sender: ResolvedSender = {
      id: String(box.id),
      address: String(box.address),
      display_name: box.display_name ? String(box.display_name) : null,
      domain_id: String(box.domain_id),
    };
    let exec;
    try {
      exec = await executeSend(
        {
          workspaceId: String(job.workspace_id),
          sender,
          to: payload.to,
          subject: payload.subject,
          text: payload.text,
          html: payload.html,
          idempotencyKey: `retry:${jobId}:${attempts + 1}`,
        },
        {kind: 'service', userId: null, serviceContext: 'ops-retry'},
      );
    } catch (e) {
      // executeSend threw (D1/provider plumbing). Treat as a retryable
      // failure — the outcome is definitively "not accepted".
      const nextAttempts = attempts + 1;
      if (nextAttempts >= MAX_RETRY_ATTEMPTS) {
        await markJob(jobId, 'failed', {
          attempts: nextAttempts,
          lastError: `Retry error: ${e instanceof Error ? e.message : 'send threw'}`,
        });
        summary.failed++;
      } else {
        await markJob(jobId, 'retry', {
          attempts: nextAttempts,
          nextAttemptAt: computeNextAttemptIso(nextAttempts),
          lastError: `Retry error: ${e instanceof Error ? e.message : 'send threw'}`,
        });
        summary.retried++;
      }
      continue;
    }
    if (exec.outcome === 'accepted' || exec.outcome === 'duplicate') {
      await markJob(jobId, 'accepted', {
        attempts: attempts + 1,
        nextAttemptAt: null,
        provider: exec.provider,
        messageId: exec.messageId,
      });
      summary.accepted++;
    } else if (exec.outcome === 'unknown') {
      // Timeout: outcome ambiguous. NEVER auto-retry — park as unknown
      // for manual/provider-log reconciliation, exactly like a first
      // attempt. The idempotency key for this attempt is already marked
      // `unknown` by executeSend.
      await markJob(jobId, 'unknown', {
        attempts: attempts + 1,
        nextAttemptAt: null,
        lastError: 'Provider outcome unknown after timeout on retry. Do not resend until provider logs are checked.',
        provider: exec.provider,
      });
      summary.unknown++;
    } else if (exec.outcome === 'suppressed' || exec.outcome === 'rejected') {
      // Terminal: retrying cannot help (suppression / domain / limit).
      await markJob(jobId, 'failed', {
        attempts: attempts + 1,
        nextAttemptAt: null,
        lastError:
          exec.outcome === 'suppressed'
            ? 'Recipient is on the workspace suppression list.'
            : 'Send rejected (domain, limit, or idempotency).',
      });
      summary.failed++;
    } else {
      // Definitive provider rejection: retry with backoff until the cap.
      const nextAttempts = attempts + 1;
      if (nextAttempts >= MAX_RETRY_ATTEMPTS) {
        await markJob(jobId, 'failed', {
          attempts: nextAttempts,
          nextAttemptAt: null,
          lastError: `All providers rejected the send after ${nextAttempts} attempts.`,
        });
        summary.failed++;
      } else {
        await markJob(jobId, 'retry', {
          attempts: nextAttempts,
          nextAttemptAt: computeNextAttemptIso(nextAttempts),
          lastError: 'All configured providers rejected the send.',
        });
        summary.retried++;
      }
    }
  }
  return summary;
}
