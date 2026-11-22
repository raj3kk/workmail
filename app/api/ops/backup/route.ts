// POST /api/ops/backup — server-side backup job (Phase 3b, G-31).
//
// Token-gated (OPS_CRON_TOKEN, Bearer — same pattern as /api/ops/monitor).
// Snapshots live D1 counts + writes a backup_runs row (D10). The
// age-encrypted artifact backup itself is scripts/backup.sh, run by the
// GitHub Actions workflow .github/workflows/backup.yml (daily 02:23 UTC,
// artifacts kept 90 days) — this route records that a backup is DUE and
// what it must contain; it does not hold an age key and cannot encrypt
// an artifact from inside Vercel. See docs/BACKUP.md.
import {NextResponse} from 'next/server';
import {createHash, timingSafeEqual} from 'node:crypto';
import {dbOne, dbQuery} from '@/lib/db';
import {writeBackupRun} from '@/lib/backup';

function tokenMatches(supplied: string, expected: string): boolean {
  if (!supplied || !expected) return false;
  const a = createHash('sha256').update(supplied).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

const COUNT_QUERIES: Array<[string, string]> = [
  ['workspaces', 'SELECT COUNT(*) AS n FROM workspaces'],
  ['users', 'SELECT COUNT(*) AS n FROM users'],
  ['messages', 'SELECT COUNT(*) AS n FROM messages'],
  ['message_attachments', 'SELECT COUNT(*) AS n FROM message_attachments'],
  ['attachment_bytes', 'SELECT COALESCE(SUM(size_bytes), 0) AS n FROM message_attachments'],
  ['mailboxes', 'SELECT COUNT(*) AS n FROM mailboxes'],
  ['bulk_campaigns', 'SELECT COUNT(*) AS n FROM bulk_campaigns'],
  ['bulk_recipients', 'SELECT COUNT(*) AS n FROM bulk_recipients'],
  ['provider_secrets', 'SELECT COUNT(*) AS n FROM provider_secrets'],
  ['delivery_events', 'SELECT COUNT(*) AS n FROM delivery_events'],
  ['audit_events', 'SELECT COUNT(*) AS n FROM audit_events'],
  ['idempotency_keys', 'SELECT COUNT(*) AS n FROM idempotency_keys'],
  ['outbound_jobs', 'SELECT COUNT(*) AS n FROM outbound_jobs'],
  ['storage_bytes_counters', 'SELECT COALESCE(SUM(storage_bytes), 0) AS n FROM usage_counters'],
];

export async function POST(req: Request) {
  const tok = req.headers.get('authorization')?.replace(/^Bearer\s+/i, '');
  if (!tokenMatches(tok || '', process.env.OPS_CRON_TOKEN || ''))
    return NextResponse.json({error: 'Unauthorized'}, {status: 401});
  const counts: Record<string, number> = {};
  for (const [name, sql] of COUNT_QUERIES) {
    const row = await dbOne(sql).catch(() => null);
    counts[name] = Number(row?.n || 0);
  }
  // KV attachment count (live namespace size is reported by the backup
  // workflow itself; the D1 metadata count above is the cross-check).
  const kvKeys = await dbQuery('SELECT COUNT(*) AS n FROM message_attachments').catch(() => []);
  counts.kv_values_expected = Number(kvKeys[0]?.n || 0);
  const runId = await writeBackupRun('server_backup', 'ok', {
    details: {
      counts,
      artifact:
        'Age-encrypted D1 + KV artifacts are produced by scripts/backup.sh via .github/workflows/backup.yml (daily 02:23 UTC, 90-day artifact retention). This route is the counts snapshot + run record; verify the artifact by running scripts/restore-drill.sh against a disposable D1.',
    },
  }).catch(() => null);
  return NextResponse.json({
    success: true,
    backup_run_id: runId,
    counts,
    note: 'Counts snapshot recorded. Encrypted artifacts come from the GitHub Actions backup workflow (scripts/backup.sh); see docs/BACKUP.md.',
  });
}
