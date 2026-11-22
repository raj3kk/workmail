import {NextResponse} from 'next/server';
import {dbOne} from '@/lib/db';
import {requireUser, canAccessMailbox} from '@/lib/guards';
import {saveMailboxPhoto, getMailboxPhoto, deleteMailboxPhoto, detectPhotoType} from '@/lib/photo';

export const runtime = 'nodejs';

// Per-mailbox profile photo API. The photo lives in Cloudflare KV and is
// shown as the avatar in the WorkMail UI only. It is NOT sent inside
// emails: nothing in an email's From header can carry a photo. The sender
// logo recipients see in their inboxes comes from BIMI (see docs/BIMI.md).
// Photo bytes are never logged.

async function mailboxWorkspace(mailboxId: string): Promise<string | null> {
  const row = await dbOne('SELECT workspace_id FROM mailboxes WHERE id = ? AND is_active = 1', [mailboxId]);
  return row ? String(row.workspace_id) : null;
}

function photoUrl(req: Request): string {
  return `/api/profile-photo?mailbox_id=${encodeURIComponent(new URL(req.url).searchParams.get('mailbox_id') || '')}`;
}

export async function POST(req: Request) {
  const {user, response} = await requireUser(req);
  if (response) return response;
  if (!user) return NextResponse.json({error: 'Unauthorized'}, {status: 401});
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({error: 'multipart/form-data body required'}, {status: 400});
  }
  const mailboxId = String(form.get('mailbox_id') || '');
  const file = form.get('file');
  if (!mailboxId || !(file instanceof File))
    return NextResponse.json({error: 'mailbox_id and file are required'}, {status: 400});
  const workspaceId = await mailboxWorkspace(mailboxId);
  if (!workspaceId) return NextResponse.json({error: 'Mailbox not found'}, {status: 404});
  // P-02: 404 (not 403) on denial, so a cross-tenant mailbox-id probe
  // cannot confirm another tenant's mailbox exists by the status code.
  if (!(await canAccessMailbox(user.id, mailboxId, true)))
    return NextResponse.json({error: 'Mailbox not found'}, {status: 404});
  let bytes: Buffer;
  try {
    bytes = Buffer.from(await file.arrayBuffer());
  } catch {
    return NextResponse.json({error: 'Could not read the uploaded file'}, {status: 400});
  }
  // Some browsers send an empty content-type; fall back to magic bytes so
  // a genuine image is not rejected for a missing header. Validation of
  // size, type and magic bytes happens in saveMailboxPhoto.
  const declaredType = file.type || detectPhotoType(bytes) || '';
  try {
    const saved = await saveMailboxPhoto(workspaceId, mailboxId, bytes, declaredType);
    return NextResponse.json({
      success: true,
      mailbox_id: mailboxId,
      content_type: saved.contentType,
      size_bytes: saved.sizeBytes,
      url: photoUrl(req),
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Photo save failed';
    // Validation errors (size / type / magic bytes) are the caller's fault.
    if (
      msg.includes('2 MB') ||
      msg.includes('Only JPEG') ||
      msg.includes('not a valid') ||
      msg.includes('do not match') ||
      msg.includes('empty')
    )
      return NextResponse.json({error: msg}, {status: 400});
    return NextResponse.json({error: 'Storage upload failed'}, {status: 502});
  }
}

export async function GET(req: Request) {
  const {user, response} = await requireUser(req);
  if (response) return response;
  if (!user) return NextResponse.json({error: 'Unauthorized'}, {status: 401});
  const mailboxId = new URL(req.url).searchParams.get('mailbox_id') || '';
  if (!mailboxId) return NextResponse.json({error: 'mailbox_id required'}, {status: 400});
  const workspaceId = await mailboxWorkspace(mailboxId);
  if (!workspaceId) return NextResponse.json({error: 'Mailbox not found'}, {status: 404});
  // P-02: 404 (not 403) on denial — see POST above.
  if (!(await canAccessMailbox(user.id, mailboxId, false)))
    return NextResponse.json({error: 'Mailbox not found'}, {status: 404});
  let photo;
  try {
    photo = await getMailboxPhoto(workspaceId, mailboxId);
  } catch {
    return NextResponse.json({error: 'Could not read photo'}, {status: 502});
  }
  if (!photo) return NextResponse.json({error: 'No photo for this mailbox'}, {status: 404});
  return new Response(new Uint8Array(photo.bytes), {
    status: 200,
    headers: {
      'Content-Type': photo.contentType,
      'Content-Length': String(photo.sizeBytes),
      'Cache-Control': 'private, no-store',
    },
  });
}

export async function DELETE(req: Request) {
  const {user, response} = await requireUser(req);
  if (response) return response;
  if (!user) return NextResponse.json({error: 'Unauthorized'}, {status: 401});
  const mailboxId = new URL(req.url).searchParams.get('mailbox_id') || '';
  if (!mailboxId) return NextResponse.json({error: 'mailbox_id required'}, {status: 400});
  const workspaceId = await mailboxWorkspace(mailboxId);
  if (!workspaceId) return NextResponse.json({error: 'Mailbox not found'}, {status: 404});
  // P-02: 404 (not 403) on denial, so a cross-tenant mailbox-id probe
  // cannot confirm another tenant's mailbox exists by the status code.
  if (!(await canAccessMailbox(user.id, mailboxId, true)))
    return NextResponse.json({error: 'Mailbox not found'}, {status: 404});
  try {
    await deleteMailboxPhoto(workspaceId, mailboxId);
  } catch {
    return NextResponse.json({error: 'Could not delete photo'}, {status: 502});
  }
  return NextResponse.json({success: true, mailbox_id: mailboxId});
}
