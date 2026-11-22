import {NextResponse} from 'next/server';
import {z} from 'zod';
import {dbOne, dbQuery, dbRun, newId, nowIso} from '@/lib/db';
import {requireUser, workspaceRole} from '@/lib/guards';
import {isDisposableEmail} from '@/lib/email-validation';

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
  // G-12: disposable / temporary-mail addresses cannot be invited (the
  // user must sign in with Google once, and temp-mail accounts are not
  // allowed). Rejected with a clear message, never silently dropped.
  if (isDisposableEmail(p.data.email))
    return NextResponse.json(
      {error: 'Disposable or temporary email addresses cannot be invited. Ask the person to use their real email address.'},
      {status: 400},
    );
  const role = await workspaceRole(user.id, p.data.workspace_id);
  if (!role || !['owner', 'admin'].includes(role))
    return NextResponse.json({error: 'Admin permission required'}, {status: 403});
  const target = await dbOne('SELECT id, email FROM users WHERE email = ?', [p.data.email.toLowerCase()]);
  if (target) {
    // The workspace owner can never be demoted through a team change
    // (2026-11-22: an invite of the owner's own email with role
    // 'member' overwrote the owner row and silently revoked the
    // owner's admin rights — filters/labels/contacts all 403'd).
    const ws = await dbOne('SELECT owner_user_id FROM workspaces WHERE id = ?', [p.data.workspace_id]);
    if (ws && String(ws.owner_user_id) === String(target.id))
      return NextResponse.json({error: 'The workspace owner always keeps the owner role.'}, {status: 400});
    try {
      await dbRun(
        `INSERT INTO memberships (workspace_id, user_id, role, created_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(workspace_id, user_id) DO UPDATE SET role = excluded.role`,
        [p.data.workspace_id, target.id, p.data.role, nowIso()],
      );
    } catch {
      // P-01: never return the database error text — D1/Cloudflare
      // messages can name tables and constraints (internal detail).
      return NextResponse.json({error: 'Could not add member'}, {status: 400});
    }
    await dbRun(
      'INSERT INTO audit_events (id, workspace_id, actor_user_id, action, target_type, target_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [newId(), p.data.workspace_id, user.id, 'member.role_changed', 'membership', target.id, nowIso()],
    );
  }
  // P-01 (privacy): the response is IDENTICAL whether or not the
  // invited email has a WorkMail account. A 404 for "no such user"
  // would let any workspace admin enumerate WorkMail accounts by
  // email (confirm/deny). The person is added only when they exist;
  // the team list (their own workspace) shows who actually joined.
  // The UI must show this message, not claim "Team role updated."
  // when nobody was added — see the coordinator note in the S2 report.
  return NextResponse.json({
    success: true,
    message:
      'If the person has a WorkMail account, they have been added to the workspace. Ask them to sign in with Google first if they are not listed yet.',
  });
}
