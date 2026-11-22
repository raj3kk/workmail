import {NextResponse} from 'next/server';
import {dbQuery} from '@/lib/db';
import {requireUser, canAccessMailbox} from '@/lib/guards';

// GET /api/search?mailbox_id=…&q=…[&folder=…][&limit=…][&offset=…]
//   — server-side search across subject, text body, from and to.
//   `mailbox_id=all` (E2) searches every mailbox the user can access
//   (same rule as /api/messages 'all' mode: owners see all mailboxes
//   in their workspaces; other members see only mailboxes with an
//   explicit mailbox_members row). Results carry mailbox_id and
//   workspace_id so the UI can badge which mailbox a hit belongs to.
export async function GET(req: Request) {
  const {user, response} = await requireUser(req);
  if (response) return response;
  if (!user) return NextResponse.json({error: 'Unauthorized'}, {status: 401});
  const u = new URL(req.url);
  const mailbox = u.searchParams.get('mailbox_id');
  const q = (u.searchParams.get('q') || '').trim().slice(0, 120);
  if (!mailbox || q.length < 2)
    return NextResponse.json({error: 'mailbox_id and q (at least 2 chars) required'}, {status: 400});

  let mailboxIds: string[];
  if (mailbox === 'all') {
    mailboxIds = await accessibleMailboxIds(user.id);
    if (!mailboxIds.length) return NextResponse.json({results: [], total: 0, limit: 50, offset: 0, has_more: false});
  } else {
    if (!(await canAccessMailbox(user.id, mailbox, false)))
      return NextResponse.json({error: 'Mailbox access denied'}, {status: 403});
    mailboxIds = [mailbox];
  }

  // Escape LIKE wildcards so % and _ in the query are literal.
  const like = '%' + q.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_') + '%';
  const limitRaw = Number(u.searchParams.get('limit') || '50');
  const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(Math.floor(limitRaw), 1), 100) : 50;
  const offsetRaw = Number(u.searchParams.get('offset') || '0');
  const offset = Number.isFinite(offsetRaw) ? Math.max(Math.floor(offsetRaw), 0) : 0;
  const folder = u.searchParams.get('folder');
  const inClause = `mailbox_id IN (${mailboxIds.map(() => '?').join(',')})`;
  const params: unknown[] = [...mailboxIds, like, like, like, like];
  let where = `${inClause}
       AND (subject LIKE ? ESCAPE '\\' OR text_body LIKE ? ESCAPE '\\' OR from_email LIKE ? ESCAPE '\\' OR to_email LIKE ? ESCAPE '\\')`;
  if (folder) {
    where += ' AND folder = ?';
    params.push(folder);
  }
  const totalRows = await dbQuery(`SELECT COUNT(*) AS c FROM messages WHERE ${where}`, params);
  const total = Number(totalRows[0]?.c || 0);
  // Same Wave 2 migration fallback as the list route (see there).
  const searchSql = (withImportant: boolean) =>
    `SELECT id, workspace_id, mailbox_id, from_email, to_email, subject, text_body, folder, is_read, is_starred, delivery_state, provider, ${
      withImportant ? 'is_important, ' : ''
    }thread_id, received_at
     FROM messages WHERE ${where}
     ORDER BY received_at DESC, id DESC LIMIT ? OFFSET ?`;
  let results: Array<Record<string, any>>;
  try {
    results = await dbQuery(searchSql(true), [...params, limit, offset]);
  } catch (e) {
    if (e instanceof Error && /no such column/i.test(e.message)) {
      results = await dbQuery(searchSql(false), [...params, limit, offset]);
      for (const r of results) r.is_important = 0;
    } else {
      throw e;
    }
  }
  return NextResponse.json({results, total, limit, offset, has_more: offset + results.length < total});
}

/** Mailbox ids the user may read (same rule as /api/messages). */
async function accessibleMailboxIds(userId: string): Promise<string[]> {
  const memberships = await dbQuery('SELECT workspace_id, role FROM memberships WHERE user_id = ?', [userId]);
  const ids: string[] = [];
  for (const m of memberships) {
    const wsId = String(m.workspace_id);
    if (String(m.role) === 'owner') {
      const rows = await dbQuery('SELECT id FROM mailboxes WHERE workspace_id = ? AND is_active = 1', [wsId]);
      for (const r of rows) ids.push(String(r.id));
    } else {
      const rows = await dbQuery(
        `SELECT mm.mailbox_id AS id FROM mailbox_members mm
         JOIN mailboxes b ON b.id = mm.mailbox_id
         WHERE mm.user_id = ? AND b.workspace_id = ? AND b.is_active = 1`,
        [userId, wsId],
      );
      for (const r of rows) ids.push(String(r.id));
    }
  }
  return [...new Set(ids)];
}
