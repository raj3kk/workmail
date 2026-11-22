import {NextResponse} from 'next/server';
import {z} from 'zod';
import {dbOne, dbRun, nowIso} from '@/lib/db';
import {requireUser, workspaceRole, canAccessMailbox} from '@/lib/guards';
import {
  getAutoReplySetting,
  setAutoReplySetting,
  getReviewQueue,
  updateQueueItem,
  logAiAction,
} from '@/lib/ai';

export const runtime = 'nodejs';

const toggleSchema = z.object({mailbox_id: z.string().uuid(), enabled: z.boolean()});
const queueSchema = z.object({
  action: z.enum(['approve', 'discard', 'sent']),
  draft_id: z.string().uuid(),
  workspace_id: z.string().uuid(),
  // Provider that transmitted the reply, recorded when a queue entry is
  // marked 'sent' (human Send via /api/send, or the auto-send path).
  provider: z.string().max(64).optional(),
});

// GET /api/ai/auto-reply?mailbox_id=… — per-mailbox auto-reply setting
// (default OFF when no setting exists) + the workspace human-review queue.
export async function GET(req: Request) {
  const {user, response} = await requireUser(req);
  if (response) return response;
  if (!user) return NextResponse.json({error: 'Unauthorized'}, {status: 401});
  const mailboxId = new URL(req.url).searchParams.get('mailbox_id');
  if (!mailboxId) return NextResponse.json({error: 'mailbox_id required'}, {status: 400});
  const box = await dbOne('SELECT id, workspace_id FROM mailboxes WHERE id = ?', [mailboxId]);
  if (!box) return NextResponse.json({error: 'Mailbox not found'}, {status: 404});
  if (!(await canAccessMailbox(user.id, mailboxId, false)))
    return NextResponse.json({error: 'Mailbox access denied'}, {status: 403});
  const setting = await getAutoReplySetting(mailboxId);
  const queue = (await getReviewQueue(String(box.workspace_id))).filter(
    (q) => q.mailbox_id === mailboxId,
  );
  return NextResponse.json({mailbox_id: mailboxId, auto_reply: setting, queue});
}

// POST /api/ai/auto-reply — either:
//   {mailbox_id, enabled} — flip the per-mailbox auto-reply toggle
//     (workspace owner/admin only; default OFF; enabling it authorises
//     the agent to auto-SEND replies on inbound mail via the internal
//     service send path — see lib/service-send.ts — not just
//     auto-drafting. Toggle OFF (or unconfigured AI) means drafts are
//     queued for human review only and nothing is transmitted), or
//   {action: 'approve'|'discard'|'sent', draft_id, workspace_id,
//   provider?} — human review of a queued draft. 'approve' only marks
//   it ready; 'sent' marks a draft that was transmitted (by a human Send
//   via /api/send, or by the auto-send path, which marks it itself with
//   provider + sent_at); 'discard' trashes it.
export async function POST(req: Request) {
  const {user, response} = await requireUser(req);
  if (response) return response;
  if (!user) return NextResponse.json({error: 'Unauthorized'}, {status: 401});
  const b = await req.json().catch(() => null);

  const toggle = toggleSchema.safeParse(b);
  if (toggle.success) {
    const box = await dbOne('SELECT id, workspace_id FROM mailboxes WHERE id = ?', [toggle.data.mailbox_id]);
    if (!box) return NextResponse.json({error: 'Mailbox not found'}, {status: 404});
    const role = await workspaceRole(user.id, String(box.workspace_id));
    if (!role || !['owner', 'admin'].includes(role))
      return NextResponse.json({error: 'Owner or admin permission required'}, {status: 403});
    const setting = await setAutoReplySetting(toggle.data.mailbox_id, toggle.data.enabled, user.id);
    await logAiAction({
      action: 'ai.auto_reply_toggled',
      workspaceId: String(box.workspace_id),
      actorUserId: user.id,
      mailboxId: toggle.data.mailbox_id,
      messageId: null,
      draftId: null,
    });
    return NextResponse.json({mailbox_id: toggle.data.mailbox_id, auto_reply: setting});
  }

  const q = queueSchema.safeParse(b);
  if (q.success) {
    if (!(await workspaceRole(user.id, q.data.workspace_id)))
      return NextResponse.json({error: 'Workspace access denied'}, {status: 403});
    const draft = await dbOne(
      "SELECT id, mailbox_id FROM messages WHERE id = ? AND workspace_id = ? AND folder = 'drafts'",
      [q.data.draft_id, q.data.workspace_id],
    );
    if (!draft) return NextResponse.json({error: 'Queued draft not found'}, {status: 404});
    if (!(await canAccessMailbox(user.id, String(draft.mailbox_id), true)))
      return NextResponse.json({error: 'Mailbox write access denied'}, {status: 403});
    const status = q.data.action === 'approve' ? 'approved' : q.data.action === 'sent' ? 'sent' : 'discarded';
    const item = await updateQueueItem(
      q.data.workspace_id,
      q.data.draft_id,
      status,
      q.data.action === 'sent'
        ? {provider: q.data.provider ?? null, sent_at: new Date().toISOString()}
        : undefined,
    );
    if (!item) return NextResponse.json({error: 'Queued draft not found'}, {status: 404});
    if (q.data.action === 'discard') {
      await dbRun("UPDATE messages SET folder = 'trash', updated_at = ? WHERE id = ?", [nowIso(), q.data.draft_id]);
    }
    if (q.data.action === 'sent') {
      // The queued draft was transmitted: move its draft row to Trash
      // (mirroring 'discard') so a queued send leaves no orphan draft
      // behind (B-c — sendQueued never cleaned up).
      await dbRun("UPDATE messages SET folder = 'trash', updated_at = ? WHERE id = ?", [nowIso(), q.data.draft_id]);
    }
    await logAiAction({
      action:
        q.data.action === 'approve'
          ? 'ai.queue_approved'
          : q.data.action === 'sent'
            ? 'ai.queue_sent'
            : 'ai.queue_discarded',
      workspaceId: q.data.workspace_id,
      actorUserId: user.id,
      mailboxId: String(draft.mailbox_id),
      messageId: null,
      draftId: q.data.draft_id,
    });
    return NextResponse.json({draft_id: q.data.draft_id, status});
  }

  return NextResponse.json({error: 'Invalid request'}, {status: 400});
}
