// POST /api/export — user backup download (Phase 3b, G-30 / D10).
//
// Session + workspace owner/admin only. Builds a ZIP (messages as .eml +
// messages.json + metadata.json, attachments included) for the caller's
// OWN workspace only — never another workspace's data. Size-capped at
// 100 MB (refused with a clear message + per-mailbox option).
//
// Rate limit: 1 export / 10 min / workspace. lib/rate-limit.ts has no
// 'export' scope (Phase 3a owns that file), so the limit is enforced
// here from backup_runs: the last completed user_export run for this
// workspace within 10 minutes blocks a new one with 429. When Phase 3a
// adds an 'export' scope, switch this to checkRateLimit — same limit,
// same window. Every export writes a backup_runs row (D10) and is
// verified by re-reading the ZIP manifest inside lib/backup.ts.
import {NextResponse} from 'next/server';
import {dbQuery} from '@/lib/db';
import {requireUser, workspaceRole} from '@/lib/guards';
import {buildExportZip, writeBackupRun, ExportTooLargeError} from '@/lib/backup';

export const runtime = 'nodejs';

const EXPORT_WINDOW_MS = 10 * 60 * 1000;

async function lastExportAt(workspaceId: string): Promise<string | null> {
  // backup_runs has no workspace_id column; the workspace travels in
  // details JSON (written by writeBackupRun below). The table is tiny.
  const rows = await dbQuery(
    "SELECT started_at, details FROM backup_runs WHERE backup_kind = 'user_export' ORDER BY started_at DESC LIMIT 20",
  ).catch(() => []);
  for (const r of rows || []) {
    try {
      const d = JSON.parse(String(r.details || '{}')) as {workspace_id?: string};
      if (d.workspace_id === workspaceId) return String(r.started_at);
    } catch {
      // A row with unparsable details cannot be this workspace's — skip.
    }
  }
  return null;
}

export async function POST(req: Request) {
  const {user, response} = await requireUser(req);
  if (response) return response;
  if (!user) return NextResponse.json({error: 'Unauthorized'}, {status: 401});
  const b = await req.json().catch(() => null);
  const workspaceId = typeof b?.workspace_id === 'string' ? b.workspace_id : '';
  const mailboxId = typeof b?.mailbox_id === 'string' && b.mailbox_id ? b.mailbox_id : null;
  if (!workspaceId) return NextResponse.json({error: 'workspace_id required'}, {status: 400});
  const role = await workspaceRole(user.id, workspaceId);
  if (!role || !['owner', 'admin'].includes(role))
    return NextResponse.json({error: 'Workspace owner/admin required'}, {status: 403});
  if (mailboxId) {
    const box = await dbQuery('SELECT id FROM mailboxes WHERE id = ? AND workspace_id = ?', [mailboxId, workspaceId]).catch(() => []);
    if (!box.length) return NextResponse.json({error: 'Mailbox not found in this workspace'}, {status: 404});
  }
  const last = await lastExportAt(workspaceId);
  if (last && Date.now() - new Date(last).getTime() < EXPORT_WINDOW_MS) {
    const waitSec = Math.ceil((EXPORT_WINDOW_MS - (Date.now() - new Date(last).getTime())) / 1000);
    return NextResponse.json(
      {error: `Only one export every 10 minutes. Try again in about ${Math.ceil(waitSec / 60)} minute(s).`},
      {status: 429, headers: {'Retry-After': String(waitSec)}},
    );
  }
  let built;
  try {
    built = await buildExportZip(workspaceId, {mailboxId});
  } catch (e) {
    if (e instanceof ExportTooLargeError)
      return NextResponse.json({error: e.message}, {status: 413});
    return NextResponse.json(
      {error: 'Could not build export'},
      {status: 500},
    );
  }
  await writeBackupRun('user_export', 'ok', {
    bytes: built.bytes,
    checksum: built.checksum,
    details: {
      workspace_id: workspaceId,
      mailbox_id: mailboxId,
      requested_by: user.id,
      message_count: built.manifest.message_count,
      attachment_count: built.manifest.attachment_count,
      attachment_bytes: built.manifest.attachment_bytes,
      verified_eml_in_zip: built.manifest.eml_count,
    },
  }).catch(() => {});
  const stamp = new Date().toISOString().slice(0, 10);
  return new Response(new Uint8Array(built.zip), {
    status: 200,
    headers: {
      'Content-Type': 'application/zip',
      'Content-Length': String(built.bytes),
      'Content-Disposition': `attachment; filename="workmail-export-${stamp}.zip"`,
      'Cache-Control': 'private, no-store',
      'X-WorkMail-Export-Messages': String(built.manifest.message_count),
      'X-WorkMail-Export-Sha256': built.checksum,
    },
  });
}
