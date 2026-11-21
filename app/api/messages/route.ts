import {NextResponse} from 'next/server';
import {dbQuery} from '@/lib/db';
import {requireUser, canAccessMailbox} from '@/lib/guards';

export async function GET(req: Request) {
  const {user, response} = await requireUser(req);
  if (response) return response;
  if (!user) return NextResponse.json({error: 'Unauthorized'}, {status: 401});
  const u = new URL(req.url);
  const mailboxId = u.searchParams.get('mailbox_id');
  const folder = u.searchParams.get('folder');
  if (!mailboxId) return NextResponse.json({error: 'mailbox_id required'}, {status: 400});
  if (!(await canAccessMailbox(user.id, mailboxId, false)))
    return NextResponse.json({error: 'Mailbox access denied'}, {status: 403});
  const params: unknown[] = [mailboxId];
  let sql =
    'SELECT id, workspace_id, mailbox_id, folder, from_email, to_email, subject, text_body, is_read, is_starred, thread_id, delivery_state, received_at, created_at FROM messages WHERE mailbox_id = ?';
  if (folder) {
    sql += ' AND folder = ?';
    params.push(folder);
  }
  sql += ' ORDER BY received_at DESC LIMIT 100';
  const messages = await dbQuery(sql, params);
  return NextResponse.json({messages});
}
