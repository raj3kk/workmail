import {NextResponse} from 'next/server';
import {dbQuery} from '@/lib/db';
import {requireUser, canAccessMailbox} from '@/lib/guards';

// GET /api/messages?mailbox_id=…&folder=…[&limit=…][&offset=…][&starred=1][&label_id=…]
//   — paginated list, newest first. `limit` defaults to 50 (max 100);
//     `offset` is a row offset into the same ordering, so "Load more"
//     appends without re-fetching page 1. Response: {messages, total,
//     limit, offset, has_more}.
// GET /api/messages?mailbox_id=…&counts=1 — unread counts per folder
//   (inbox/sent/drafts/archive/trash/spam) + starred unread, for the
//   sidebar badges. No message rows are returned in this mode.
// GET /api/messages?mailbox_id=all — the "All Messages" unified inbox
//   (E2): one list across every mailbox the user can access, summed
//   folder counts. Rows carry mailbox_id so the UI can badge which
//   mailbox each message belongs to. Workspace-scoped, same auth as
//   the single-mailbox mode: owners see all mailboxes in their
//   workspaces; other members see only mailboxes with an explicit
//   mailbox_members row (the same rule as canAccessMailbox).
export async function GET(req: Request) {
  const {user, response} = await requireUser(req);
  if (response) return response;
  if (!user) return NextResponse.json({error: 'Unauthorized'}, {status: 401});
  const u = new URL(req.url);
  const mailboxId = u.searchParams.get('mailbox_id');
  const folder = u.searchParams.get('folder');
  if (!mailboxId) return NextResponse.json({error: 'mailbox_id required'}, {status: 400});

  // Resolve the mailbox set for this request. Single-mailbox mode
  // keeps the existing canAccessMailbox check; 'all' mode resolves
  // every mailbox the user may read (see header comment).
  let mailboxIds: string[];
  if (mailboxId === 'all') {
    mailboxIds = await accessibleMailboxIds(user.id);
    if (!mailboxIds.length) {
      if (u.searchParams.get('counts') === '1')
        return NextResponse.json({counts: {inbox: 0, sent: 0, drafts: 0, archive: 0, trash: 0, spam: 0, starred: 0, total_unread: 0}});
      return NextResponse.json({messages: [], total: 0, limit: 50, offset: 0, has_more: false});
    }
  } else {
    if (!(await canAccessMailbox(user.id, mailboxId, false)))
      return NextResponse.json({error: 'Mailbox access denied'}, {status: 403});
    mailboxIds = [mailboxId];
  }
  const placeholders = mailboxIds.map(() => '?').join(',');
  const inClause = `mailbox_id IN (${placeholders})`;

  if (u.searchParams.get('counts') === '1') {
    const rows = await dbQuery(
      `SELECT folder, COUNT(*) AS c FROM messages WHERE ${inClause} AND is_read = 0 GROUP BY folder`,
      mailboxIds,
    );
    const counts: Record<string, number> = {inbox: 0, sent: 0, drafts: 0, archive: 0, trash: 0, spam: 0};
    for (const r of rows) counts[String(r.folder)] = Number(r.c || 0);
    const starred = await dbQuery(
      `SELECT COUNT(*) AS c FROM messages WHERE ${inClause} AND is_read = 0 AND is_starred = 1`,
      mailboxIds,
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
  const labelId = u.searchParams.get('label_id');
  const params: unknown[] = [...mailboxIds];
  let where = `WHERE ${inClause}`;
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
  // S3 (E5-2): filter the list by label — works in single-mailbox and
  // All view alike (labels are workspace-scoped; the message list is
  // already restricted to mailboxes the caller may read). A label id
  // from a workspace the caller has no membership in matches nothing:
  // the label row must belong to one of the caller's workspaces, else
  // the list is empty (no cross-workspace probe signal beyond that).
  if (labelId) {
    const memberships = await dbQuery('SELECT workspace_id FROM memberships WHERE user_id = ?', [user.id]);
    const wsIds = [...new Set(memberships.map((m) => String(m.workspace_id)))];
    let labelOk = false;
    if (wsIds.length) {
      const row = await dbQuery(
        `SELECT id FROM labels WHERE id = ? AND workspace_id IN (${wsIds.map(() => '?').join(',')})`,
        [labelId, ...wsIds],
      );
      labelOk = row.length > 0;
    }
    if (!labelOk) return NextResponse.json({messages: [], total: 0, limit, offset, has_more: false});
    where += ' AND EXISTS (SELECT 1 FROM message_labels ml WHERE ml.message_id = messages.id AND ml.label_id = ?)';
    params.push(labelId);
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
    const placeholders2 = ids.map(() => '?').join(',');
    const labelRows = await dbQuery(
      `SELECT ml.message_id AS message_id, l.id AS label_id, l.name AS name, l.color AS color
       FROM message_labels ml JOIN labels l ON l.id = ml.label_id
       WHERE ml.message_id IN (${placeholders2})`,
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

/** Mailbox ids the user may read: every active mailbox in workspaces
 *  they own, plus mailboxes with an explicit mailbox_members row in
 *  workspaces where they are a non-owner member — the same rule as
 *  canAccessMailbox, applied across all of the user's workspaces. */
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
