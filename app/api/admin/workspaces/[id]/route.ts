import {NextResponse} from 'next/server';
import {dbOne, dbRun, jstr, newId, nowIso} from '@/lib/db';
import {requireUser, requirePlatformAdmin} from '@/lib/guards';

export async function PATCH(req: Request, {params}: {params: {id: string}}) {
  const {user, response} = await requireUser(req);
  if (response) return response;
  if (!user) return NextResponse.json({error: 'Unauthorized'}, {status: 401});
  if (!(await requirePlatformAdmin(user.id)))
    return NextResponse.json({error: 'Platform admin only'}, {status: 403});
  const b = await req.json().catch(() => null);
  if (typeof b?.suspended !== 'boolean')
    return NextResponse.json({error: 'suspended boolean required'}, {status: 400});
  const ws = await dbOne('SELECT id FROM workspaces WHERE id = ?', [params.id]);
  if (!ws) return NextResponse.json({error: 'Workspace not found'}, {status: 404});
  const now = nowIso();
  const reason = b.suspended ? String(b.reason || 'Policy review').slice(0, 500) : null;
  await dbRun('UPDATE workspaces SET suspended_at = ?, suspension_reason = ? WHERE id = ?', [
    b.suspended ? now : null,
    reason,
    params.id,
  ]);
  await dbRun(
    'INSERT INTO admin_actions (id, admin_user_id, action, target_workspace_id, details, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    [newId(), user.id, b.suspended ? 'workspace.suspended' : 'workspace.reinstated', params.id, jstr({reason: b.reason || null}), now],
  );
  return NextResponse.json({success: true});
}
