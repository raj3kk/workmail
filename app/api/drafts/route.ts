import {NextResponse} from 'next/server';
import {dbOne, dbQuery, dbRun, newId, nowIso} from '@/lib/db';
import {requireUser, canAccessMailbox, workspaceRole} from '@/lib/guards';

async function hasWriteAccess(userId: string, mailboxId: string): Promise<boolean> {
  const box = await dbOne('SELECT workspace_id FROM mailboxes WHERE id = ?', [mailboxId]);
  if (!box) return false;
  const role = await workspaceRole(userId, String(box.workspace_id));
  if (role === 'owner') return true;
  return canAccessMailbox(userId, mailboxId, true);
}

export async function GET(req: Request) {
  const {user, response} = await requireUser(req);
  if (response) return response;
  if (!user) return NextResponse.json({error: 'Unauthorized'}, {status: 401});
  const mailbox = new URL(req.url).searchParams.get('mailbox_id');
  if (!mailbox) return NextResponse.json({error: 'mailbox_id required'}, {status: 400});
  if (!(await canAccessMailbox(user.id, mailbox, false)))
    return NextResponse.json({error: 'Mailbox access denied'}, {status: 403});
  const drafts = await dbQuery(
    "SELECT id, to_email, subject, text_body, updated_at FROM messages WHERE mailbox_id = ? AND folder = 'drafts' ORDER BY updated_at DESC LIMIT 100",
    [mailbox],
  );
  return NextResponse.json({drafts});
}

export async function POST(req: Request) {
  const {user, response} = await requireUser(req);
  if (response) return response;
  if (!user) return NextResponse.json({error: 'Unauthorized'}, {status: 401});
  const b = await req.json().catch(() => null);
  if (!b?.workspace_id || !b?.mailbox_id)
    return NextResponse.json({error: 'workspace_id and mailbox_id required'}, {status: 400});
  const box = await dbOne('SELECT id, address, workspace_id FROM mailboxes WHERE id = ? AND workspace_id = ?', [
    b.mailbox_id,
    b.workspace_id,
  ]);
  if (!box) return NextResponse.json({error: 'Mailbox not found'}, {status: 404});
  if (!(await hasWriteAccess(user.id, box.id)))
    return NextResponse.json({error: 'Mailbox write access denied'}, {status: 403});
  const id = newId();
  try {
    await dbRun(
      `INSERT INTO messages (id, workspace_id, mailbox_id, folder, from_email, to_email, subject, text_body, delivery_state, received_at, created_at, updated_at)
       VALUES (?, ?, ?, 'drafts', ?, ?, ?, ?, 'draft', ?, ?, ?)`,
      [
        id,
        b.workspace_id,
        b.mailbox_id,
        box.address,
        String(b.to || ''),
        String(b.subject || '').slice(0, 998),
        String(b.text || '').slice(0, 100000),
        nowIso(),
        nowIso(),
        nowIso(),
      ],
    );
  } catch (e) {
    return NextResponse.json({error: e instanceof Error ? e.message : 'Could not save draft'}, {status: 400});
  }
  return NextResponse.json({draft_id: id});
}

export async function PATCH(req: Request) {
  const {user, response} = await requireUser(req);
  if (response) return response;
  if (!user) return NextResponse.json({error: 'Unauthorized'}, {status: 401});
  const b = await req.json().catch(() => null);
  if (!b?.id) return NextResponse.json({error: 'id required'}, {status: 400});
  const msg = await dbOne("SELECT mailbox_id FROM messages WHERE id = ? AND folder = 'drafts'", [b.id]);
  if (!msg) return NextResponse.json({error: 'Draft not found'}, {status: 404});
  // Owner override, same as POST: workspace owners may edit drafts even
  // without an explicit mailbox_members row.
  if (!(await hasWriteAccess(user.id, String(msg.mailbox_id))))
    return NextResponse.json({error: 'Mailbox write access denied'}, {status: 403});
  await dbRun(
    'UPDATE messages SET to_email = ?, subject = ?, text_body = ?, updated_at = ? WHERE id = ?',
    [String(b.to || ''), String(b.subject || '').slice(0, 998), String(b.text || '').slice(0, 100000), nowIso(), b.id],
  );
  return NextResponse.json({success: true});
}
