import {NextResponse} from 'next/server';
import {timingSafeEqual, createHash} from 'node:crypto';
import {dbQuery, dbRun, nowIso} from '@/lib/db';
import {processDueOutboundJobs} from '@/lib/retry';

export const runtime = 'nodejs';

function tokenMatches(supplied: string, expected: string): boolean {
  if (!supplied || !expected) return false;
  const a = createHash('sha256').update(supplied).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

export async function POST(req: Request) {
  const token = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (!tokenMatches(token, process.env.OPS_CRON_TOKEN || ''))
    return NextResponse.json({error: 'Unauthorized'}, {status: 401});
  const now = nowIso();
  // 1. Flag stale ambiguous sends: a job stuck in `processing` or
  // `unknown` for >15 minutes needs manual/provider-log reconciliation.
  // `unknown` rows are NEVER auto-retried (G-23): the provider may
  // already have delivered, so blindly resending could duplicate mail.
  const cutoff = new Date(Date.now() - 15 * 60 * 1000).toISOString();
  const stale = await dbQuery(
    "SELECT id, workspace_id, attempts FROM outbound_jobs WHERE status IN ('processing','unknown') AND updated_at < ? LIMIT 100",
    [cutoff],
  );
  let reset = 0;
  for (const j of stale) {
    const r = await dbRun(
      'UPDATE outbound_jobs SET status = ?, last_error = ?, updated_at = ? WHERE id = ?',
      ['unknown', 'Provider outcome requires reconciliation; do not blindly resend.', now, j.id],
    );
    if (r.changes > 0) reset++;
  }
  // 2. Consume due retry rows (G-23): `queued`/`retry` jobs whose
  // next_attempt_at has passed are re-sent through the shared send
  // pipeline with backoff (1m/5m/15m/30m/60m, max 5 attempts). See
  // lib/retry.ts and docs/PRODUCTION-OPERATIONS.md "Outbound retry policy".
  let retry: Awaited<ReturnType<typeof processDueOutboundJobs>>;
  try {
    retry = await processDueOutboundJobs(25);
  } catch (e) {
    return NextResponse.json({
      success: false,
      stale_jobs_reviewed: reset,
      retry: null,
      error: `Retry worker failed: ${e instanceof Error ? e.message : 'unknown error'}`,
      note: 'Stale ambiguous sends were still flagged above; retry consumption failed and will be attempted on the next tick.',
    });
  }
  return NextResponse.json({
    success: true,
    stale_jobs_reviewed: reset,
    retry,
    note: 'Stale ambiguous sends are flagged for manual/provider-log reconciliation and are never auto-retried. Due queued/retry jobs were consumed by the retry worker (see retry summary).',
  });
}
