import {NextResponse} from 'next/server';
import {dbOne, dbRun, nowIso} from '@/lib/db';
import {requireUser, canAccessMailbox} from '@/lib/guards';

const FOLDERS = ['inbox', 'sent', 'drafts', 'archive', 'trash'];

export async function PATCH(req: Request, {params}: {params: {id: string}}) {
  const {user, response} = await requireUser(req);
  if (response) return response;
  if (!user) return NextResponse.json({error: 'Unauthorized'}, {status: 401});
  const b = await req.json().catch(() => null);
  if (!b || (typeof b.is_read !== 'boolean' && typeof b.folder !== 'string'))
    return NextResponse.json({error: 'is_read or folder required'}, {status: 400});
  if (typeof b.folder === 'string' && !FOLDERS.includes(b.folder))
    return NextResponse.json({error: 'Invalid folder'}, {status: 400});
  const msg = await dbOne('SELECT id, mailbox_id FROM messages WHERE id = ?', [params.id]);
  if (!msg) return NextResponse.json({error: 'Message not found'}, {status: 404});
  if (!(await canAccessMailbox(user.id, String(msg.mailbox_id), true)))
    return NextResponse.json({error: 'Mailbox write access denied'}, {status: 403});
  const sets: string[] = [];
  const values: unknown[] = [];
  if (typeof b.is_read === 'boolean') {
    sets.push('is_read = ?');
    values.push(b.is_read ? 1 : 0);
  }
  if (typeof b.folder === 'string') {
    sets.push('folder = ?');
    values.push(b.folder);
  }
  sets.push('updated_at = ?');
  values.push(nowIso());
  values.push(params.id);
  await dbRun(`UPDATE messages SET ${sets.join(', ')} WHERE id = ?`, values);
  const message = await dbOne('SELECT * FROM messages WHERE id = ?', [params.id]);
  return NextResponse.json({success: true, message});
}
