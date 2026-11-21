import {NextResponse} from 'next/server';
import {timingSafeEqual, createHash} from 'node:crypto';
import {dbQuery, dbRun, nowIso} from '@/lib/db';

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
  return NextResponse.json({
    success: true,
    stale_jobs_reviewed: reset,
    note: 'This endpoint flags ambiguous sends for manual/provider-log reconciliation. It does not resend messages automatically.',
  });
}
