import {NextResponse} from 'next/server';
import {dbQuery} from '@/lib/db';
import {requireUser, canAccessMailbox} from '@/lib/guards';

export async function GET(req: Request) {
  const {user, response} = await requireUser(req);
  if (response) return response;
  if (!user) return NextResponse.json({error: 'Unauthorized'}, {status: 401});
  const u = new URL(req.url);
  const mailbox = u.searchParams.get('mailbox_id');
  const thread = u.searchParams.get('thread_id');
  if (!mailbox || !thread)
    return NextResponse.json({error: 'mailbox_id and thread_id required'}, {status: 400});
  if (!(await canAccessMailbox(user.id, mailbox, false)))
    return NextResponse.json({error: 'Mailbox access denied'}, {status: 403});
  const messages = await dbQuery(
    'SELECT * FROM messages WHERE mailbox_id = ? AND thread_id = ? ORDER BY received_at ASC LIMIT 200',
    [mailbox, thread],
  );
  return NextResponse.json({messages});
}
