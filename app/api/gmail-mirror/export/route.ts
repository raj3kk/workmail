// Gmail backup mirror — status + export run (Phase 4, PRODUCTION-PLAN.md §7).
// Owner-only. GET returns the mirror status (connected account, counts —
// never the token). POST either toggles auto-mirror ({auto_mirror: true/false})
// or runs the export (imports every unmirrored message; re-runs import 0 new).
// A backup_runs row is written for every export run (decision D10) and the
// mirrored count is re-read from gmail_mirror before reporting.
import {NextResponse} from 'next/server';
import {z} from 'zod';
import {requireUser, workspaceRole} from '@/lib/guards';
import {dbOne} from '@/lib/db';
import {getGmailAccessToken, setGmailAutoMirror} from '@/lib/gmail-oauth';
import {getMirrorStatus, mirrorAllUnmirrored, recordMirrorBackupRun} from '@/lib/gmail-mirror';

export const runtime = 'nodejs';

async function requireOwner(req: Request, workspaceId: string) {
  const {user, response} = await requireUser(req);
  if (response) return {user: null, response};
  if (!user) return {user: null, response: NextResponse.json({error: 'Unauthorized'}, {status: 401})};
  if (!workspaceId) return {user: null, response: NextResponse.json({error: 'workspace_id is required'}, {status: 400})};
  const role = await workspaceRole(user.id, workspaceId);
  if (role !== 'owner')
    return {user: null, response: NextResponse.json({error: 'Gmail backup is available to the workspace owner only.'}, {status: 403})};
  return {user, response: null};
}

export async function GET(req: Request) {
  const workspaceId = new URL(req.url).searchParams.get('workspace_id') || '';
  const {response} = await requireOwner(req, workspaceId);
  if (response) return response;
  const status = await getMirrorStatus(workspaceId);
  return NextResponse.json(status);
}

const postSchema = z.object({
  workspace_id: z.string().min(1),
  auto_mirror: z.boolean().optional(),
});

export async function POST(req: Request) {
  const parsed = postSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({error: 'workspace_id is required'}, {status: 400});
  const {workspace_id: workspaceId, auto_mirror: autoMirror} = parsed.data;
  const {response} = await requireOwner(req, workspaceId);
  if (response) return response;

  // Toggle-only call: no export runs, just the setting.
  if (typeof autoMirror === 'boolean') {
    const status = await getMirrorStatus(workspaceId);
    if (!status.connected) return NextResponse.json({error: 'Connect Gmail backup first.'}, {status: 409});
    await setGmailAutoMirror(workspaceId, autoMirror);
    return NextResponse.json({...(await getMirrorStatus(workspaceId))});
  }

  const status = await getMirrorStatus(workspaceId);
  if (!status.connected)
    return NextResponse.json({error: 'Gmail backup is not connected. Connect it first, then back up.'}, {status: 409});
  const accessToken = await getGmailAccessToken(workspaceId);
  if (!accessToken)
    return NextResponse.json(
      {error: 'Google no longer accepts the stored Gmail grant (it may have been revoked, or the Google password changed). Disconnect and connect again.'},
      {status: 401},
    );
  const run = await mirrorAllUnmirrored(workspaceId, accessToken);
  // Verification read (D10): re-count mirrored rows from D1 after the run.
  const verified = await dbOne(
    `SELECT COUNT(*) AS n FROM gmail_mirror gm JOIN messages m ON m.id = gm.d1_message_id
     WHERE m.workspace_id = ? AND gm.status = 'imported'`,
    [workspaceId],
  );
  await recordMirrorBackupRun(workspaceId, run, Number(verified?.n || 0));
  return NextResponse.json({
    total: run.total,
    imported: run.imported,
    already_mirrored: run.alreadyMirrored,
    skipped: run.skipped,
    failed: run.failed,
    verified_mirrored: Number(verified?.n || 0),
  });
}
