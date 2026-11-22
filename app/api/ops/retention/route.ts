// POST /api/ops/retention — retention purge (Phase 3b, G-32 / G-33).
//
// Token-gated (OPS_CRON_TOKEN, Bearer — same pattern as /api/ops/monitor).
// Deletes per workspace per workspace_settings.retention_days (default 90):
//   messages + their attachments (KV bytes deleted first, then the
//   message_attachments rows) + message_labels for those messages,
//   delivery_events, audit_events, outbound_jobs (deleting the row
//   deletes its payload — G-33), and idempotency_keys older than
//   retention — EXCEPT accepted keys, which are kept 90 days for
//   duplicate protection and only then purged.
// Dry-run first: ?dry_run=true (or body {dry_run: true}) returns the
// counts and deletes NOTHING. Live runs return the deleted counts.
//
// No cron is wired to this route (vercel.json has no cron — the user's
// 19 crons are PAUSED by standing order). The daily 03:00 IST cron
// snippet is documented in docs/BACKUP.md for the user to approve later.
import {NextResponse} from 'next/server';
import {createHash, timingSafeEqual} from 'node:crypto';
import {dbOne, dbQuery, dbRun, nowIso} from '@/lib/db';
import {kvDelete} from '@/lib/kv';

function tokenMatches(supplied: string, expected: string): boolean {
  if (!supplied || !expected) return false;
  const a = createHash('sha256').update(supplied).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

const MAX_MESSAGES_PER_RUN = 1000;
const MAX_ROWS_PER_TABLE = 5000;
const ACCEPTED_KEY_KEEP_DAYS = 90;

interface WorkspaceCounts {
  messages: number;
  attachments: number;
  delivery_events: number;
  audit_events: number;
  outbound_jobs: number;
  idempotency_keys: number;
}

function emptyCounts(): WorkspaceCounts {
  return {messages: 0, attachments: 0, delivery_events: 0, audit_events: 0, outbound_jobs: 0, idempotency_keys: 0};
}

async function countFor(workspaceId: string, cutoff: string, acceptedCutoff: string): Promise<WorkspaceCounts> {
  const c = emptyCounts();
  const q = async (sql: string, params: unknown[]): Promise<number> => {
    const row = await dbOne(sql, params).catch(() => null);
    return Number(row?.n || 0);
  };
  c.messages = await q('SELECT COUNT(*) AS n FROM messages WHERE workspace_id = ? AND created_at < ?', [workspaceId, cutoff]);
  c.attachments = await q(
    'SELECT COUNT(*) AS n FROM message_attachments WHERE workspace_id = ? AND message_id IN (SELECT id FROM messages WHERE workspace_id = ? AND created_at < ?)',
    [workspaceId, workspaceId, cutoff],
  );
  c.delivery_events = await q('SELECT COUNT(*) AS n FROM delivery_events WHERE workspace_id = ? AND created_at < ?', [workspaceId, cutoff]);
  c.audit_events = await q('SELECT COUNT(*) AS n FROM audit_events WHERE workspace_id = ? AND created_at < ?', [workspaceId, cutoff]);
  c.outbound_jobs = await q(
    "SELECT COUNT(*) AS n FROM outbound_jobs WHERE workspace_id = ? AND (created_at < ? OR message_id IN (SELECT id FROM messages WHERE workspace_id = ? AND created_at < ?))",
    [workspaceId, cutoff, workspaceId, cutoff],
  );
  c.idempotency_keys = await q(
    "SELECT COUNT(*) AS n FROM idempotency_keys WHERE workspace_id = ? AND ((status = 'accepted' AND created_at < ?) OR (status <> 'accepted' AND created_at < ?))",
    [workspaceId, acceptedCutoff, cutoff],
  );
  return c;
}

async function purgeFor(workspaceId: string, cutoff: string, acceptedCutoff: string): Promise<WorkspaceCounts & {truncated: boolean}> {
  const deleted = emptyCounts();
  let truncated = false;
  // Messages first (bounded): collect ids, delete their KV bytes, then
  // the attachment rows, labels, and the messages themselves.
  const msgRows = await dbQuery(
    'SELECT id FROM messages WHERE workspace_id = ? AND created_at < ? ORDER BY created_at ASC LIMIT ?',
    [workspaceId, cutoff, MAX_MESSAGES_PER_RUN],
  ).catch(() => []);
  const msgIds = (msgRows || []).map((r) => String(r.id));
  const totalOld = await dbOne('SELECT COUNT(*) AS n FROM messages WHERE workspace_id = ? AND created_at < ?', [workspaceId, cutoff]).catch(() => null);
  if (Number(totalOld?.n || 0) > msgIds.length) truncated = true;
  if (msgIds.length > 0) {
    const placeholders = msgIds.map(() => '?').join(',');
    const attRows = await dbQuery(
      `SELECT object_key FROM message_attachments WHERE workspace_id = ? AND message_id IN (${placeholders})`,
      [workspaceId, ...msgIds],
    ).catch(() => []);
    for (const a of attRows || []) {
      await kvDelete(String(a.object_key)).catch(() => {});
      deleted.attachments += 1;
    }
    await dbRun(`DELETE FROM message_attachments WHERE workspace_id = ? AND message_id IN (${placeholders})`, [workspaceId, ...msgIds]).catch(() => {});
    await dbRun(`DELETE FROM message_labels WHERE message_id IN (${placeholders})`, [...msgIds]).catch(() => {});
    const res = await dbRun(`DELETE FROM messages WHERE workspace_id = ? AND id IN (${placeholders})`, [workspaceId, ...msgIds]).catch(() => ({changes: 0}));
    deleted.messages = res.changes;
  }
  // Event / job / key tables: bounded by id selection (SQLite DELETE has
  // no LIMIT). Count-then-delete in one statement each; the counts
  // returned are the pre-delete counts capped at the batch size.
  const delByAge = async (table: string, extraSql = ''): Promise<number> => {
    const ids = await dbQuery(
      `SELECT id FROM ${table} WHERE workspace_id = ? AND created_at < ? ORDER BY created_at ASC LIMIT ?`,
      [workspaceId, cutoff, MAX_ROWS_PER_TABLE],
    ).catch(() => []);
    const list = (ids || []).map((r) => String(r.id));
    if (list.length === 0) return 0;
    const ph = list.map(() => '?').join(',');
    const res = await dbRun(`DELETE FROM ${table} WHERE id IN (${ph}) ${extraSql}`, [...list]).catch(() => ({changes: 0}));
    return res.changes;
  };
  deleted.delivery_events = await delByAge('delivery_events');
  deleted.audit_events = await delByAge('audit_events');
  // outbound_jobs: age-based, plus jobs whose message was just deleted
  // (payload dies with the row — G-33). Its PK is (workspace_id,
  // idempotency_key), so delete by idempotency_key.
  const jobKeys = await dbQuery(
    `SELECT idempotency_key FROM outbound_jobs WHERE workspace_id = ? AND (created_at < ? OR message_id IN (SELECT id FROM messages WHERE workspace_id = ? AND created_at < ?)) LIMIT ?`,
    [workspaceId, cutoff, workspaceId, cutoff, MAX_ROWS_PER_TABLE],
  ).catch(() => []);
  // Note: message_id IN (...) above re-checks messages still present;
  // jobs of messages deleted in this run are caught by the age clause
  // only when old, so also delete jobs whose message_id is gone:
  const orphanJobs = await dbQuery(
    `SELECT idempotency_key FROM outbound_jobs WHERE workspace_id = ? AND message_id IS NOT NULL AND message_id NOT IN (SELECT id FROM messages) LIMIT ?`,
    [workspaceId, MAX_ROWS_PER_TABLE],
  ).catch(() => []);
  const jobKeySet = new Set<string>([
    ...(jobKeys || []).map((r) => String(r.idempotency_key)),
    ...(orphanJobs || []).map((r) => String(r.idempotency_key)),
  ]);
  if (jobKeySet.size > 0) {
    const keys = [...jobKeySet];
    const ph = keys.map(() => '?').join(',');
    const res = await dbRun(`DELETE FROM outbound_jobs WHERE workspace_id = ? AND idempotency_key IN (${ph})`, [workspaceId, ...keys]).catch(() => ({changes: 0}));
    deleted.outbound_jobs = res.changes;
  }
  // idempotency_keys: PK is (workspace_id, idempotency_key). Accepted
  // keys purge only after 90 days; all other statuses at retention.
  const keyRows = await dbQuery(
    `SELECT idempotency_key FROM idempotency_keys WHERE workspace_id = ? AND ((status = 'accepted' AND created_at < ?) OR (status <> 'accepted' AND created_at < ?)) LIMIT ?`,
    [workspaceId, acceptedCutoff, cutoff, MAX_ROWS_PER_TABLE],
  ).catch(() => []);
  const keyList = (keyRows || []).map((r) => String(r.idempotency_key));
  if (keyList.length > 0) {
    const ph = keyList.map(() => '?').join(',');
    const res = await dbRun(`DELETE FROM idempotency_keys WHERE workspace_id = ? AND idempotency_key IN (${ph})`, [workspaceId, ...keyList]).catch(() => ({changes: 0}));
    deleted.idempotency_keys = res.changes;
  }
  return {...deleted, truncated};
}

export async function POST(req: Request) {
  const tok = req.headers.get('authorization')?.replace(/^Bearer\s+/i, '');
  if (!tokenMatches(tok || '', process.env.OPS_CRON_TOKEN || ''))
    return NextResponse.json({error: 'Unauthorized'}, {status: 401});
  const url = new URL(req.url);
  const body = await req.json().catch(() => null);
  const dryRun = url.searchParams.get('dry_run') === 'true' || body?.dry_run === true;
  const onlyWorkspace = typeof body?.workspace_id === 'string' ? body.workspace_id : url.searchParams.get('workspace_id');
  const wsRows = onlyWorkspace
    ? [{id: onlyWorkspace}]
    : await dbQuery('SELECT id FROM workspaces').catch(() => []);
  const now = Date.now();
  const results: Array<Record<string, unknown>> = [];
  for (const w of wsRows || []) {
    const workspaceId = String(w.id);
    const settings = await dbOne('SELECT retention_days FROM workspace_settings WHERE workspace_id = ?', [workspaceId]).catch(() => null);
    const retentionDays = Number(settings?.retention_days || 90);
    const cutoff = new Date(now - retentionDays * 24 * 60 * 60 * 1000).toISOString();
    const acceptedCutoff = new Date(now - ACCEPTED_KEY_KEEP_DAYS * 24 * 60 * 60 * 1000).toISOString();
    if (dryRun) {
      const counts = await countFor(workspaceId, cutoff, acceptedCutoff);
      results.push({workspace_id: workspaceId, retention_days: retentionDays, cutoff, dry_run: true, would_delete: counts});
    } else {
      const deleted = await purgeFor(workspaceId, cutoff, acceptedCutoff);
      console.log(JSON.stringify({event: 'retention_purge', workspace_id: workspaceId, retention_days: retentionDays, cutoff, deleted, at: nowIso()}));
      results.push({workspace_id: workspaceId, retention_days: retentionDays, cutoff, dry_run: false, deleted});
    }
  }
  return NextResponse.json({success: true, dry_run: dryRun, workspaces: results});
}
