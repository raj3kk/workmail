import {NextResponse} from 'next/server';
import {dbQuery} from '@/lib/db';
import {requireUser, canAccessMailbox} from '@/lib/guards';

export async function GET(req: Request) {
  const {user, response} = await requireUser(req);
  if (response) return response;
  if (!user) return NextResponse.json({error: 'Unauthorized'}, {status: 401});
  const u = new URL(req.url);
  const mailbox = u.searchParams.get('mailbox_id');
  const q = (u.searchParams.get('q') || '').trim().slice(0, 120);
  if (!mailbox || q.length < 2)
    return NextResponse.json({error: 'mailbox_id and q (at least 2 chars) required'}, {status: 400});
  if (!(await canAccessMailbox(user.id, mailbox, false)))
    return NextResponse.json({error: 'Mailbox access denied'}, {status: 403});
  // Escape LIKE wildcards so % and _ in the query are literal.
  const like = '%' + q.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_') + '%';
  const results = await dbQuery(
    `SELECT id, from_email, to_email, subject, text_body, folder, is_read, is_starred, thread_id, received_at
     FROM messages WHERE mailbox_id = ?
       AND (subject LIKE ? ESCAPE '\\' OR text_body LIKE ? ESCAPE '\\' OR from_email LIKE ? ESCAPE '\\' OR to_email LIKE ? ESCAPE '\\')
     ORDER BY received_at DESC LIMIT 100`,
    [mailbox, like, like, like, like],
  );
  return NextResponse.json({results});
}
