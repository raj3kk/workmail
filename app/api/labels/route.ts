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
  const labels = await dbQuery(
    'SELECT id, name, color, mailbox_id FROM labels WHERE workspace_id = ? ORDER BY name ASC',
    [wid],
  );
  return NextResponse.json({labels});
}

export async function POST(req: Request) {
  const {user, response} = await requireUser(req);
  if (response) return response;
  if (!user) return NextResponse.json({error: 'Unauthorized'}, {status: 401});
  const b = await req.json().catch(() => null);
  if (!b?.workspace_id || typeof b.name !== 'string' || !b.name.trim())
    return NextResponse.json({error: 'workspace_id and label name required'}, {status: 400});
  const role = await workspaceRole(user.id, b.workspace_id);
  if (!role || !['owner', 'admin'].includes(role))
    return NextResponse.json({error: 'Workspace admin required'}, {status: 403});
  if (b.mailbox_id) {
    const box = await dbOne('SELECT id FROM mailboxes WHERE id = ? AND workspace_id = ?', [b.mailbox_id, b.workspace_id]);
    if (!box) return NextResponse.json({error: 'mailbox_id does not belong to this workspace'}, {status: 400});
  }
  const id = newId();
  try {
    await dbRun(
      'INSERT INTO labels (id, workspace_id, mailbox_id, name, color, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      [
        id,
        b.workspace_id,
        b.mailbox_id || null,
        b.name.trim().slice(0, 60),
        /^#[0-9a-f]{6}$/i.test(b.color || '') ? b.color : '#64748b',
        nowIso(),
      ],
    );
  } catch (e) {
    return NextResponse.json({error: e instanceof Error ? e.message : 'Could not create label'}, {status: 400});
  }
  const label = await dbOne('SELECT * FROM labels WHERE id = ?', [id]);
  return NextResponse.json({label});
}

export async function DELETE(req: Request) {
  const {user, response} = await requireUser(req);
  if (response) return response;
  if (!user) return NextResponse.json({error: 'Unauthorized'}, {status: 401});
  const b = await req.json().catch(() => null);
  if (!b?.id) return NextResponse.json({error: 'id required'}, {status: 400});
  const label = await dbOne('SELECT workspace_id FROM labels WHERE id = ?', [b.id]);
  if (!label) return NextResponse.json({error: 'Label not found'}, {status: 404});
  const role = await workspaceRole(user.id, String(label.workspace_id));
  if (!role || !['owner', 'admin'].includes(role))
    return NextResponse.json({error: 'Workspace admin required'}, {status: 403});
  // message_labels rows cascade via FK; delete the label itself.
  await dbRun('DELETE FROM message_labels WHERE label_id = ?', [b.id]);
  await dbRun('DELETE FROM labels WHERE id = ?', [b.id]);
  return NextResponse.json({success: true});
}
