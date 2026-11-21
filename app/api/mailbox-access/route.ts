import {NextResponse} from 'next/server';
import {z} from 'zod';
import {dbOne, dbRun, jstr, newId, nowIso} from '@/lib/db';
import {requireUser, workspaceRole} from '@/lib/guards';

export async function POST(req: Request) {
  const {user, response} = await requireUser(req);
  if (response) return response;
  if (!user) return NextResponse.json({error: 'Unauthorized'}, {status: 401});
  const p = z
    .object({
      workspace_id: z.string().uuid(),
      mailbox_id: z.string().uuid(),
      user_id: z.string().uuid(),
      permission: z.enum(['read', 'read_write', 'manage']),
    })
    .safeParse(await req.json().catch(() => null));
  if (!p.success) return NextResponse.json({error: 'Invalid mailbox permission'}, {status: 400});
  const role = await workspaceRole(user.id, p.data.workspace_id);
  if (!role || !['owner', 'admin'].includes(role))
    return NextResponse.json({error: 'Workspace admin permission required'}, {status: 403});
  const box = await dbOne('SELECT id FROM mailboxes WHERE id = ? AND workspace_id = ?', [
    p.data.mailbox_id,
    p.data.workspace_id,
  ]);
  const target = await dbOne('SELECT user_id FROM memberships WHERE workspace_id = ? AND user_id = ?', [
    p.data.workspace_id,
    p.data.user_id,
  ]);
  if (!box || !target)
    return NextResponse.json({error: 'Mailbox or workspace member not found'}, {status: 404});
  try {
    await dbRun(
      `INSERT INTO mailbox_members (mailbox_id, user_id, permission, created_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(mailbox_id, user_id) DO UPDATE SET permission = excluded.permission`,
      [p.data.mailbox_id, p.data.user_id, p.data.permission, nowIso()],
    );
  } catch (e) {
    return NextResponse.json({error: e instanceof Error ? e.message : 'Could not grant mailbox access'}, {status: 400});
  }
  await dbRun(
    'INSERT INTO audit_events (id, workspace_id, actor_user_id, action, target_type, target_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [newId(), p.data.workspace_id, user.id, 'mailbox.permission_changed', 'mailbox', p.data.mailbox_id, nowIso()],
  );
  return NextResponse.json({success: true});
}
