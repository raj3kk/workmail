import {NextResponse} from 'next/server';
import {dbQuery} from '@/lib/db';
import {requireUser, canAccessMailbox} from '@/lib/guards';

// GET /api/messages?mailbox_id=…&folder=…[&limit=…][&offset=…][&starred=1]
//   — paginated list, newest first. `limit` defaults to 50 (max 100);
//     `offset` is a row offset into the same ordering, so "Load more"
//     appends without re-fetching page 1. Response: {messages, total,
//     limit, offset, has_more}.
// GET /api/messages?mailbox_id=…&counts=1 — unread counts per folder
//   (inbox/sent/drafts/archive/trash/spam) + starred unread, for the
//   sidebar badges. No message rows are returned in this mode.
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

  if (u.searchParams.get('counts') === '1') {
    const rows = await dbQuery(
      'SELECT folder, COUNT(*) AS c FROM messages WHERE mailbox_id = ? AND is_read = 0 GROUP BY folder',
      [mailboxId],
    );
    const counts: Record<string, number> = {inbox: 0, sent: 0, drafts: 0, archive: 0, trash: 0, spam: 0};
    for (const r of rows) counts[String(r.folder)] = Number(r.c || 0);
    const starred = await dbQuery(
      'SELECT COUNT(*) AS c FROM messages WHERE mailbox_id = ? AND is_read = 0 AND is_starred = 1',
      [mailboxId],
    );
    counts.starred = Number(starred[0]?.c || 0);
    counts.total_unread = Object.values(counts).reduce((a, b) => a + b, 0) - counts.starred;
    return NextResponse.json({counts});
  }

  const limitRaw = Number(u.searchParams.get('limit') || '50');
  const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(Math.floor(limitRaw), 1), 100) : 50;
  const offsetRaw = Number(u.searchParams.get('offset') || '0');
  const offset = Number.isFinite(offsetRaw) ? Math.max(Math.floor(offsetRaw), 0) : 0;
  const starredOnly = u.searchParams.get('starred') === '1';
  const params: unknown[] = [mailboxId];
  let where = 'WHERE mailbox_id = ?';
  if (folder) {
    where += ' AND folder = ?';
    params.push(folder);
  }
  if (folder === 'sent') {
    // Defence in depth (B-b): a draft must be unlistable as sent even
    // if it was ever mis-filed — only genuinely accepted / in-flight
    // delivery states may appear under Sent.
    where += " AND delivery_state IN ('accepted','sent','delivered','opened','clicked','deferred')";
  }
  if (starredOnly) {
    where += ' AND is_starred = 1';
  }
  const totalRows = await dbQuery(`SELECT COUNT(*) AS c FROM messages ${where}`, params);
  const total = Number(totalRows[0]?.c || 0);
  // is_important comes from the Wave 2 migration (db/schema.sql). If the
  // coordinator has not applied it yet, fall back to a query without that
  // column so the inbox keeps working (important flags read as 0).
  let messages: Array<Record<string, any>>;
  const listSql = (withImportant: boolean) =>
    `SELECT id, workspace_id, mailbox_id, folder, from_email, to_email, subject, text_body, is_read, is_starred, ${
      withImportant ? 'is_important, ' : ''
    }thread_id, delivery_state, received_at, created_at FROM messages ${where} ORDER BY received_at DESC, id DESC LIMIT ? OFFSET ?`;
  try {
    messages = await dbQuery(listSql(true), [...params, limit, offset]);
  } catch (e) {
    if (e instanceof Error && /no such column/i.test(e.message)) {
      messages = await dbQuery(listSql(false), [...params, limit, offset]);
      for (const m of messages) m.is_important = 0;
    } else {
      throw e;
    }
  }
  // Label chips for the list rows (one extra query, batched by message).
  if (messages.length > 0) {
    const ids = messages.map((m) => String(m.id));
    const placeholders = ids.map(() => '?').join(',');
    const labelRows = await dbQuery(
      `SELECT ml.message_id AS message_id, l.id AS label_id, l.name AS name, l.color AS color
       FROM message_labels ml JOIN labels l ON l.id = ml.label_id
       WHERE ml.message_id IN (${placeholders})`,
      ids,
    );
    const byMessage = new Map<string, Array<{id: string; name: string; color: string}>>();
    for (const r of labelRows) {
      const list = byMessage.get(String(r.message_id)) || [];
      list.push({id: String(r.label_id), name: String(r.name), color: String(r.color)});
      byMessage.set(String(r.message_id), list);
    }
    for (const m of messages) m.labels = byMessage.get(String(m.id)) || [];
  }
  return NextResponse.json({messages, total, limit, offset, has_more: offset + messages.length < total});
}
