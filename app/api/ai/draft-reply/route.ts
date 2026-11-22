import {NextResponse} from 'next/server';
import {z} from 'zod';
import {dbOne} from '@/lib/db';
import {requireUser, canAccessMailbox} from '@/lib/guards';
import {
  AiNotConfiguredError,
  AiProviderError,
  addToReviewQueue,
  buildReplyPrompt,
  generateDraftText,
  logAiAction,
  saveAiDraft,
} from '@/lib/ai';

export const runtime = 'nodejs';

const schema = z.object({
  message_id: z.string().uuid(),
  instruction: z.string().max(2000).optional(),
});

// POST /api/ai/draft-reply — AI-draft a reply to an inbox message.
// Creates a draft (folder 'drafts') + a pending review-queue entry.
// Never sends. 503 with a clear message when AI is not configured.
export async function POST(req: Request) {
  const {user, response} = await requireUser(req);
  if (response) return response;
  if (!user) return NextResponse.json({error: 'Unauthorized'}, {status: 401});
  const p = schema.safeParse(await req.json().catch(() => null));
  if (!p.success) return NextResponse.json({error: 'Invalid request'}, {status: 400});
  const msg = await dbOne(
    'SELECT id, workspace_id, mailbox_id, from_email, to_email, subject, text_body FROM messages WHERE id = ?',
    [p.data.message_id],
  );
  if (!msg) return NextResponse.json({error: 'Message not found'}, {status: 404});
  // P-02: 404 (not 403) on denial, so a cross-tenant message-id probe
  // cannot confirm another tenant's message exists by the status code.
  if (!(await canAccessMailbox(user.id, String(msg.mailbox_id), true)))
    return NextResponse.json({error: 'Message not found'}, {status: 404});
  const box = await dbOne('SELECT address FROM mailboxes WHERE id = ?', [msg.mailbox_id]);
  if (!box) return NextResponse.json({error: 'Mailbox not found'}, {status: 404});
  let text: string;
  let provider: string;
  let model: string;
  try {
    const out = await generateDraftText(
      buildReplyPrompt({
        from: String(msg.from_email),
        subject: String(msg.subject || ''),
        body: String(msg.text_body || ''),
        mailboxAddress: String(box.address),
        instruction: p.data.instruction,
      }),
      {workspaceId: String(msg.workspace_id), inboundText: String(msg.text_body || '')},
    );
    text = out.text;
    provider = String(out.config.provider);
    model = out.config.model;
  } catch (e) {
    if (e instanceof AiNotConfiguredError)
      return NextResponse.json({error: e.message, code: 'AI_NOT_CONFIGURED'}, {status: 503});
    if (e instanceof AiProviderError)
      return NextResponse.json({error: e.message, code: 'AI_PROVIDER_ERROR'}, {status: 503});
    return NextResponse.json({error: 'AI draft failed'}, {status: 502});
  }
  const subject = String(msg.subject || '').startsWith('Re: ')
    ? String(msg.subject)
    : `Re: ${msg.subject || '(No Subject)'}`;
  const draftId = await saveAiDraft({
    workspaceId: String(msg.workspace_id),
    mailboxId: String(msg.mailbox_id),
    fromAddress: String(box.address),
    to: String(msg.from_email),
    subject,
    text,
  });
  await addToReviewQueue(String(msg.workspace_id), {
    draft_id: draftId,
    source_message_id: String(msg.id),
    mailbox_id: String(msg.mailbox_id),
    to: String(msg.from_email),
    subject,
    auto: false,
    status: 'pending',
    created_at: new Date().toISOString(),
  });
  await logAiAction({
    action: 'ai.reply_drafted',
    workspaceId: String(msg.workspace_id),
    actorUserId: user.id,
    mailboxId: String(msg.mailbox_id),
    messageId: String(msg.id),
    draftId,
    model,
    provider,
  });
  return NextResponse.json({draft_id: draftId, to: msg.from_email, subject, text, model, provider});
}
