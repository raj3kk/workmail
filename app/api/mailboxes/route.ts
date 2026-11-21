import {NextResponse} from 'next/server';
import {z} from 'zod';
import {dbOne, dbQuery, dbRun, newId, nowIso} from '@/lib/db';
import {requireUser, workspaceRole, listWorkspaceIds} from '@/lib/guards';

export async function GET(req: Request) {
  const {user, response} = await requireUser(req);
  if (response) return response;
  if (!user) return NextResponse.json({error: 'Unauthorized'}, {status: 401});
  const ids = await listWorkspaceIds(user.id);
  if (!ids.length) return NextResponse.json({data: []});
  const data = await dbQuery(
    `SELECT id, workspace_id, domain_id, address, display_name, is_active, created_at FROM mailboxes
     WHERE workspace_id IN (${ids.map(() => '?').join(',')}) ORDER BY created_at DESC`,
    ids,
  );
  return NextResponse.json({data});
}

export async function POST(req: Request) {
  const {user, response} = await requireUser(req);
  if (response) return response;
  if (!user) return NextResponse.json({error: 'Unauthorized'}, {status: 401});
  const p = z
    .object({
      workspace_id: z.string().uuid(),
      domain_id: z.string().uuid(),
      address: z.string().email(),
      display_name: z.string().max(100).optional(),
      assign_to: z.string().uuid().optional(),
    })
    .safeParse(await req.json().catch(() => null));
  if (!p.success) return NextResponse.json({error: 'Invalid mailbox'}, {status: 400});
  const role = await workspaceRole(user.id, p.data.workspace_id);
  if (!role || !['owner', 'admin'].includes(role))
    return NextResponse.json({error: 'Admin permission required'}, {status: 403});
  const d = await dbOne(
    'SELECT id, domain, ownership_status, dns_status FROM domains WHERE id = ? AND workspace_id = ?',
    [p.data.domain_id, p.data.workspace_id],
  );
  if (!d || d.ownership_status !== 'verified')
    return NextResponse.json({error: 'Verify domain ownership before creating mailboxes'}, {status: 409});
  if (!p.data.address.toLowerCase().endsWith('@' + String(d.domain).toLowerCase()))
    return NextResponse.json({error: 'Mailbox address must use the verified domain'}, {status: 400});
  if (p.data.assign_to) {
    const tm = await dbOne('SELECT user_id FROM memberships WHERE workspace_id = ? AND user_id = ?', [
      p.data.workspace_id,
      p.data.assign_to,
    ]);
    if (!tm) return NextResponse.json({error: 'assign_to must be a member of this workspace'}, {status: 400});
  }
  const id = newId();
  const now = nowIso();
  try {
    await dbRun(
      'INSERT INTO mailboxes (id, workspace_id, domain_id, address, display_name, is_active, created_by, created_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?)',
      [id, p.data.workspace_id, p.data.domain_id, p.data.address.toLowerCase(), p.data.display_name || '', user.id, now],
    );
  } catch (e) {
    return NextResponse.json({error: e instanceof Error ? e.message : 'Could not create mailbox'}, {status: 400});
  }
  // The DB trigger already grants the workspace owner + creator 'manage';
  // this covers an explicit assignee and is a no-op otherwise.
  await dbRun(
    'INSERT OR IGNORE INTO mailbox_members (mailbox_id, user_id, permission, created_at) VALUES (?, ?, ?, ?)',
    [id, p.data.assign_to || user.id, 'manage', now],
  );
  const box = await dbOne('SELECT * FROM mailboxes WHERE id = ?', [id]);
  return NextResponse.json({data: box}, {status: 201});
}
