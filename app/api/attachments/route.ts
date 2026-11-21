import {NextResponse} from 'next/server';
import {randomUUID} from 'node:crypto';
import {dbOne, dbRun, newId, nowIso} from '@/lib/db';
import {requireUser, canAccessMailbox} from '@/lib/guards';
import {kvPut, kvGet, kvDelete} from '@/lib/kv';

export const runtime = 'nodejs';

const allowed = new Set([
  'application/pdf',
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'text/plain',
  'text/csv',
  'application/zip',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
]);

async function authorized(mailboxId: string, userId: string, workspaceId: string, write = true): Promise<boolean> {
  const b = await dbOne('SELECT id, workspace_id FROM mailboxes WHERE id = ? AND workspace_id = ? AND is_active = 1', [
    mailboxId,
    workspaceId,
  ]);
  if (!b) return false;
  return canAccessMailbox(userId, mailboxId, write);
}

export async function POST(req: Request) {
  try {
    const {user, response} = await requireUser(req);
    if (response) return response;
    if (!user) return NextResponse.json({error: 'Unauthorized'}, {status: 401});
    const form = await req.formData();
    const file = form.get('file');
    const mailboxId = String(form.get('mailbox_id') || '');
    const workspaceId = String(form.get('workspace_id') || '');
    const messageId = String(form.get('message_id') || '');
    if (!(file instanceof File) || !mailboxId || !workspaceId)
      return NextResponse.json({error: 'file, mailbox_id and workspace_id are required'}, {status: 400});
    if (file.size < 1 || file.size > 25 * 1024 * 1024 || !allowed.has(file.type))
      return NextResponse.json({error: 'File type not allowed or file exceeds 25 MB.'}, {status: 413});
    if (!(await authorized(mailboxId, user.id, workspaceId)))
      return NextResponse.json({error: 'Mailbox access denied'}, {status: 403});
    if (messageId) {
      const m = await dbOne(
        'SELECT id, mailbox_id, workspace_id FROM messages WHERE id = ? AND mailbox_id = ? AND workspace_id = ?',
        [messageId, mailboxId, workspaceId],
      );
      if (!m) return NextResponse.json({error: 'Message not found in this mailbox'}, {status: 404});
    }
    const safe = file.name.normalize('NFKC').replace(/[^\w.() -]/g, '_').slice(0, 150) || 'attachment';
    const key = `att/${workspaceId}/${mailboxId}/${randomUUID()}-${safe}`;
    const bytes = Buffer.from(await file.arrayBuffer());
    try {
      await kvPut(key, bytes, file.type);
    } catch (e) {
      return NextResponse.json({error: 'Storage upload failed', detail: e instanceof Error ? e.message : 'KV error'}, {status: 502});
    }
    if (messageId) {
      try {
        await dbRun(
          'INSERT INTO message_attachments (id, workspace_id, mailbox_id, message_id, file_name, content_type, size_bytes, object_key, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
          [newId(), workspaceId, mailboxId, messageId, safe, file.type, file.size, key, nowIso()],
        );
      } catch (e) {
        // Orphan KV object: metadata failed, so delete the bytes we stored.
        await kvDelete(key).catch(() => {});
        return NextResponse.json({error: 'Attachment metadata save failed'}, {status: 500});
      }
    }
    return NextResponse.json({
      success: true,
      attachment: {file_name: safe, content_type: file.type, size_bytes: file.size, object_key: key, message_id: messageId || null},
    });
  } catch (e) {
    return NextResponse.json({error: e instanceof Error ? e.message : 'Upload failed'}, {status: 500});
  }
}

export async function GET(req: Request) {
  const {user, response} = await requireUser(req);
  if (response) return response;
  if (!user) return NextResponse.json({error: 'Unauthorized'}, {status: 401});
  const u = new URL(req.url);
  const id = u.searchParams.get('id');
  const workspaceId = u.searchParams.get('workspace_id');
  if (!id || !workspaceId) return NextResponse.json({error: 'id and workspace_id required'}, {status: 400});
  const att = await dbOne('SELECT * FROM message_attachments WHERE id = ? AND workspace_id = ?', [id, workspaceId]);
  if (!att) return NextResponse.json({error: 'Attachment not found'}, {status: 404});
  if (!(await authorized(String(att.mailbox_id), user.id, workspaceId, false)))
    return NextResponse.json({error: 'Mailbox access denied'}, {status: 403});
  let bytes: Buffer | null;
  try {
    bytes = await kvGet(String(att.object_key));
  } catch (e) {
    return NextResponse.json({error: 'Could not read attachment'}, {status: 502});
  }
  if (!bytes) return NextResponse.json({error: 'Attachment bytes not found'}, {status: 404});
  const safeName = String(att.file_name).replace(/["\r\n]/g, '_');
  return new Response(new Uint8Array(bytes), {
    status: 200,
    headers: {
      'Content-Type': String(att.content_type),
      'Content-Length': String(bytes.length),
      'Content-Disposition': `attachment; filename="${safeName}"`,
      'Cache-Control': 'private, no-store',
    },
  });
}
