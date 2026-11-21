import {NextResponse} from 'next/server';
import {z} from 'zod';
import {dbOne, dbQuery, dbRun, newId, nowIso} from '@/lib/db';
import {requireUser, workspaceRole} from '@/lib/guards';

export async function GET(req: Request) {
  const {user, response} = await requireUser(req);
  if (response) return response;
  if (!user) return NextResponse.json({error: 'Unauthorized'}, {status: 401});
  const requested = new URL(req.url).searchParams.get('workspace_id');
  let workspaceId = requested || null;
  if (!workspaceId) {
    const first = await dbOne(
      'SELECT w.id FROM workspaces w JOIN memberships m ON m.workspace_id = w.id WHERE m.user_id = ? ORDER BY w.created_at ASC LIMIT 1',
      [user.id],
    );
    if (!first) return NextResponse.json({error: 'Workspace not found'}, {status: 404});
    workspaceId = String(first.id);
  }
  if (!(await workspaceRole(user.id, workspaceId)))
    return NextResponse.json({error: 'Workspace access denied'}, {status: 403});
  const members = await dbQuery(
    `SELECT m.user_id, m.role, m.created_at, u.email FROM memberships m
     JOIN users u ON u.id = m.user_id WHERE m.workspace_id = ? ORDER BY m.created_at ASC`,
    [workspaceId],
  );
  return NextResponse.json({workspace_id: workspaceId, members});
}

export async function POST(req: Request) {
  const {user, response} = await requireUser(req);
  if (response) return response;
  if (!user) return NextResponse.json({error: 'Unauthorized'}, {status: 401});
  const p = z
    .object({
      workspace_id: z.string().uuid(),
      email: z.string().email(),
      role: z.enum(['admin', 'member', 'readonly']),
    })
    .safeParse(await req.json().catch(() => null));
  if (!p.success) return NextResponse.json({error: 'Invalid invitation'}, {status: 400});
  const role = await workspaceRole(user.id, p.data.workspace_id);
  if (!role || !['owner', 'admin'].includes(role))
    return NextResponse.json({error: 'Admin permission required'}, {status: 403});
  const target = await dbOne('SELECT id, email FROM users WHERE email = ?', [p.data.email.toLowerCase()]);
  if (!target)
    return NextResponse.json(
      {error: 'User must sign in with Google once before they can be added. Share the workspace invite instructions.'},
      {status: 404},
    );
  try {
    await dbRun(
      `INSERT INTO memberships (workspace_id, user_id, role, created_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(workspace_id, user_id) DO UPDATE SET role = excluded.role`,
      [p.data.workspace_id, target.id, p.data.role, nowIso()],
    );
  } catch (e) {
    return NextResponse.json({error: e instanceof Error ? e.message : 'Could not add member'}, {status: 400});
  }
  await dbRun(
    'INSERT INTO audit_events (id, workspace_id, actor_user_id, action, target_type, target_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [newId(), p.data.workspace_id, user.id, 'member.role_changed', 'membership', target.id, nowIso()],
  );
  return NextResponse.json({success: true});
}
