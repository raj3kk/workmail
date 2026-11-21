import {NextResponse} from 'next/server';
import {dbOne, dbQuery, dbRun, newId, nowIso} from '@/lib/db';
import {requireUser, workspaceRole} from '@/lib/guards';

export async function GET(req: Request) {
  const {user, response} = await requireUser(req);
  if (response) return response;
  if (!user) return NextResponse.json({error: 'Unauthorized'}, {status: 401});
  const wid = new URL(req.url).searchParams.get('workspace_id');
  if (!wid) return NextResponse.json({error: 'workspace_id required'}, {status: 400});
  if (!(await workspaceRole(user.id, wid)))
    return NextResponse.json({error: 'Workspace access denied'}, {status: 403});
  const contacts = await dbQuery(
    'SELECT id, email, name, company, notes, updated_at FROM contacts WHERE workspace_id = ? ORDER BY name ASC LIMIT 500',
    [wid],
  );
  return NextResponse.json({contacts});
}

export async function POST(req: Request) {
  const {user, response} = await requireUser(req);
  if (response) return response;
  if (!user) return NextResponse.json({error: 'Unauthorized'}, {status: 401});
  const b = await req.json().catch(() => null);
  if (!b || typeof b.workspace_id !== 'string' || typeof b.email !== 'string' || !/^\S+@\S+\.\S+$/.test(b.email))
    return NextResponse.json({error: 'Valid workspace_id and email required'}, {status: 400});
  const role = await workspaceRole(user.id, b.workspace_id);
  if (!role || !['owner', 'admin'].includes(role))
    return NextResponse.json({error: 'Workspace admin required'}, {status: 403});
  const now = nowIso();
  const id = newId();
  try {
    await dbRun(
      `INSERT INTO contacts (id, workspace_id, email, name, company, notes, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(workspace_id, email) DO UPDATE SET name = excluded.name, company = excluded.company,
         notes = excluded.notes, created_by = excluded.created_by, updated_at = excluded.updated_at`,
      [
        id,
        b.workspace_id,
        b.email.toLowerCase(),
        String(b.name || '').slice(0, 160),
        String(b.company || '').slice(0, 160),
        String(b.notes || '').slice(0, 2000),
        user.id,
        now,
        now,
      ],
    );
  } catch (e) {
    return NextResponse.json({error: e instanceof Error ? e.message : 'Could not save contact'}, {status: 400});
  }
  const contact = await dbOne('SELECT * FROM contacts WHERE workspace_id = ? AND email = ?', [
    b.workspace_id,
    b.email.toLowerCase(),
  ]);
  return NextResponse.json({contact});
}
