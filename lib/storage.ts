// WorkMail storage accounting — Phase 3b, G-4 / G-14.
//
// Storage is real bytes, derived from D1 (never guessed, never "unlimited"):
//   usage = SUM(message bodies, text + html, as bytes)
//         + SUM(message_attachments.size_bytes)
// The plan limit comes from the workspace's plan in plan_catalog
// (Free = 512 MB, seeded). usage_counters.storage_bytes is the running
// per-period counter maintained by the send path (lib/service-send.ts)
// and the inbound path (app/api/inbound/route.ts); the D1-derived figure
// here is the authority for quota checks because it counts everything
// actually stored, regardless of period.
import {dbOne} from '@/lib/db';

export const DEFAULT_STORAGE_LIMIT_BYTES = 512 * 1024 * 1024; // Free plan: 512 MB

/** Plan storage limit for a workspace (bytes). Falls back to the Free limit. */
export async function getStorageLimitBytes(workspaceId: string): Promise<number> {
  const row = await dbOne(
    `SELECT pc.storage_limit_bytes AS n FROM workspace_settings ws
     JOIN plan_catalog pc ON pc.id = ws.plan
     WHERE ws.workspace_id = ? AND pc.is_active = 1`,
    [workspaceId],
  ).catch(() => null);
  const n = Number(row?.n || 0);
  return n > 0 ? n : DEFAULT_STORAGE_LIMIT_BYTES;
}

/** Real stored bytes for a workspace: message bodies + attachment sizes. */
export async function getStorageUsageBytes(workspaceId: string): Promise<number> {
  const row = await dbOne(
    `SELECT
       (SELECT COALESCE(SUM(LENGTH(CAST(text_body AS BLOB)) + LENGTH(CAST(html_body AS BLOB))), 0) FROM messages WHERE workspace_id = ?)
       + (SELECT COALESCE(SUM(size_bytes), 0) FROM message_attachments WHERE workspace_id = ?) AS n`,
    [workspaceId, workspaceId],
  ).catch(() => null);
  return Number(row?.n || 0);
}

/** Current-period usage_counters.storage_bytes (the running counter). */
export async function getCounterStorageBytes(workspaceId: string): Promise<number> {
  const period = new Date().toISOString().slice(0, 7) + '-01';
  const row = await dbOne(
    'SELECT storage_bytes FROM usage_counters WHERE workspace_id = ? AND period_start = ?',
    [workspaceId, period],
  ).catch(() => null);
  return Number(row?.storage_bytes || 0);
}

/**
 * Effective stored bytes for a quota decision: the larger of the
 * D1-derived real usage and the running counter (they agree once the
 * backfill + per-send accounting are in place; taking the max means an
 * old counter can never understate usage and let an over-limit upload
 * through).
 */
export async function getEffectiveStorageBytes(workspaceId: string): Promise<number> {
  const [derived, counter] = await Promise.all([
    getStorageUsageBytes(workspaceId),
    getCounterStorageBytes(workspaceId),
  ]);
  return Math.max(derived, counter);
}
