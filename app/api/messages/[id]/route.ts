import {NextResponse} from 'next/server';
import {dbOne, dbQuery, dbRun, newId, nowIso} from '@/lib/db';
import {requireUser, canAccessMailbox} from '@/lib/guards';

const FOLDERS = ['inbox', 'sent', 'drafts', 'archive', 'trash', 'spam'];

// GET /api/messages/[id] — full message detail (subject, sender, text +
// HTML body, attachments). The inbox list endpoint intentionally omits
// html_body to keep list payloads small, so the reader MUST fetch detail
// here on click; previously no GET handler existed at all, which left
// HTML-only messages (text_body === '') with a blank reader body.
export async function GET(req: Request, {params}: {params: {id: string}}) {
  const {user, response} = await requireUser(req);
  if (response) return response;
  if (!user) return NextResponse.json({error: 'Unauthorized'}, {status: 401});
  const msg = await dbOne('SELECT * FROM messages WHERE id = ?', [params.id]);
  if (!msg) return NextResponse.json({error: 'Message not found'}, {status: 404});
  // Read access on the owning mailbox; 404 (not 403) on denial so a
  // cross-tenant id probe cannot confirm another tenant's message exists.
  if (!(await canAccessMailbox(user.id, String(msg.mailbox_id), false)))
    return NextResponse.json({error: 'Message not found'}, {status: 404});
  const attachments = await dbQuery(
    'SELECT id, file_name, content_type, size_bytes, created_at FROM message_attachments WHERE message_id = ? ORDER BY created_at ASC',
    [params.id],
  );
  const labels = await dbQuery(
    'SELECT l.id, l.name, l.color FROM message_labels ml JOIN labels l ON l.id = ml.label_id WHERE ml.message_id = ? ORDER BY l.name ASC',
    [params.id],
  );
  return NextResponse.json({message: msg, attachments, labels});
}

// PATCH /api/messages/[id] — mutate one message. Accepted fields:
//   is_read: boolean — mark read/unread
//   is_starred: boolean — star / unstar
//   is_important: boolean — mark important / not important
//   folder: 'inbox'|'sent'|'drafts'|'archive'|'trash'|'spam' — move
//     (trash = delete, spam = report spam; moving back to inbox restores)
//   labels: string[] — REPLACE the message's label set (ids must belong
//     to the message's workspace; unknown ids are ignored)
//   attach: {object_key, file_name, content_type, size_bytes} — link a
//     file previously uploaded via POST /api/attachments (no message_id)
//     to this message, so compose-with-attachment files land on the sent
//     message record. The bytes must already exist in KV under object_key.
export async function PATCH(req: Request, {params}: {params: {id: string}}) {
  const {user, response} = await requireUser(req);
  if (response) return response;
  if (!user) return NextResponse.json({error: 'Unauthorized'}, {status: 401});
  const b = await req.json().catch(() => null);
  const hasKnownField =
    !!b &&
    (typeof b.is_read === 'boolean' ||
      typeof b.is_starred === 'boolean' ||
      typeof b.is_important === 'boolean' ||
      typeof b.folder === 'string' ||
      Array.isArray(b.labels) ||
      (b.attach && typeof b.attach === 'object'));
  if (!hasKnownField)
    return NextResponse.json({error: 'is_read, is_starred, is_important, folder, labels or attach required'}, {status: 400});
  if (typeof b.folder === 'string' && !FOLDERS.includes(b.folder))
    return NextResponse.json({error: 'Invalid folder'}, {status: 400});
  const msg = await dbOne('SELECT id, mailbox_id, workspace_id FROM messages WHERE id = ?', [params.id]);
  if (!msg) return NextResponse.json({error: 'Message not found'}, {status: 404});
  if (!(await canAccessMailbox(user.id, String(msg.mailbox_id), true)))
    return NextResponse.json({error: 'Mailbox write access denied'}, {status: 403});
  const sets: string[] = [];
  const values: unknown[] = [];
  if (typeof b.is_read === 'boolean') {
    sets.push('is_read = ?');
    values.push(b.is_read ? 1 : 0);
  }
  if (typeof b.is_starred === 'boolean') {
    sets.push('is_starred = ?');
    values.push(b.is_starred ? 1 : 0);
  }
  if (typeof b.is_important === 'boolean') {
    sets.push('is_important = ?');
    values.push(b.is_important ? 1 : 0);
  }
  if (typeof b.folder === 'string') {
    sets.push('folder = ?');
    values.push(b.folder);
  }
  if (sets.length > 0) {
    sets.push('updated_at = ?');
    values.push(nowIso());
    values.push(params.id);
    try {
      await dbRun(`UPDATE messages SET ${sets.join(', ')} WHERE id = ?`, values);
    } catch (e) {
      // Wave 2 migration not applied yet: is_important writes fail.
      // Report it clearly instead of a generic 500.
      if (e instanceof Error && /no such column/i.test(e.message))
        return NextResponse.json(
          {error: 'is_important column not migrated yet — apply the Wave 2 block in db/schema.sql to live D1'},
          {status: 503},
        );
      throw e;
    }
  }
  if (Array.isArray(b.labels)) {
    const wanted = b.labels.filter((x: unknown) => typeof x === 'string').slice(0, 20);
    const owned =
      wanted.length > 0
        ? await dbQuery(
            `SELECT id FROM labels WHERE workspace_id = ? AND id IN (${wanted.map(() => '?').join(',')})`,
            [String(msg.workspace_id), ...wanted],
          )
        : [];
    await dbRun('DELETE FROM message_labels WHERE message_id = ?', [params.id]);
    for (const row of owned) {
      await dbRun('INSERT OR IGNORE INTO message_labels (message_id, label_id, created_at) VALUES (?, ?, ?)', [
        params.id,
        String(row.id),
        nowIso(),
      ]);
    }
  }
  if (b.attach && typeof b.attach === 'object') {
    const a = b.attach;
    const key = String(a.object_key || '');
    const fileName = String(a.file_name || '').slice(0, 150);
    const size = Number(a.size_bytes || 0);
    if (!key.startsWith('att/') || !fileName || !Number.isFinite(size) || size < 1 || size > 25 * 1024 * 1024)
      return NextResponse.json({error: 'Invalid attachment reference'}, {status: 400});
    // The KV object must belong to this workspace/mailbox (key prefix
    // att/<workspace>/<mailbox>/…), so a caller cannot link another
    // tenant's bytes onto their message.
    const prefix = `att/${msg.workspace_id}/${msg.mailbox_id}/`;
    if (!key.startsWith(prefix))
      return NextResponse.json({error: 'Attachment does not belong to this mailbox'}, {status: 400});
    await dbRun(
      'INSERT INTO message_attachments (id, workspace_id, mailbox_id, message_id, file_name, content_type, size_bytes, object_key, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [
        newId(),
        String(msg.workspace_id),
        String(msg.mailbox_id),
        params.id,
        fileName,
        String(a.content_type || 'application/octet-stream').slice(0, 255),
        size,
        key,
        nowIso(),
      ],
    );
  }
  const message = await dbOne('SELECT * FROM messages WHERE id = ?', [params.id]);
  const labels = await dbQuery(
    'SELECT l.id, l.name, l.color FROM message_labels ml JOIN labels l ON l.id = ml.label_id WHERE ml.message_id = ? ORDER BY l.name ASC',
    [params.id],
  );
  return NextResponse.json({success: true, message, labels});
}
