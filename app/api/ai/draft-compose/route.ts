import {NextResponse} from 'next/server';
import {z} from 'zod';
import {dbOne} from '@/lib/db';
import {requireUser, workspaceRole, canAccessMailbox} from '@/lib/guards';
import {
  AiNotConfiguredError,
  AiProviderError,
  addToReviewQueue,
  buildComposePrompt,
  generateDraftText,
  logAiAction,
  saveAiDraft,
} from '@/lib/ai';

export const runtime = 'nodejs';

const schema = z.object({
  workspace_id: z.string().uuid(),
  mailbox_id: z.string().uuid(),
  to: z.string().email(),
  subject: z.string().max(998).optional(),
  instruction: z.string().min(1).max(4000),
});

// POST /api/ai/draft-compose — AI-draft a new email from an instruction.
// Creates a draft (folder 'drafts') + a pending review-queue entry.
// The user reviews the draft in compose and sends it via /api/send.
// Never sends by itself. 503 with a clear message when AI is not configured.
export async function POST(req: Request) {
  const {user, response} = await requireUser(req);
  if (response) return response;
  if (!user) return NextResponse.json({error: 'Unauthorized'}, {status: 401});
  const p = schema.safeParse(await req.json().catch(() => null));
  if (!p.success) return NextResponse.json({error: 'Invalid request'}, {status: 400});
  const d = p.data;
  if (!(await workspaceRole(user.id, d.workspace_id)))
    return NextResponse.json({error: 'Workspace access denied'}, {status: 403});
  if (!(await canAccessMailbox(user.id, d.mailbox_id, true)))
    return NextResponse.json({error: 'Mailbox write access denied'}, {status: 403});
  const box = await dbOne('SELECT address, workspace_id FROM mailboxes WHERE id = ?', [d.mailbox_id]);
  if (!box || String(box.workspace_id) !== d.workspace_id)
    return NextResponse.json({error: 'Mailbox not found'}, {status: 404});
  let text: string;
  let provider: string;
  let model: string;
  try {
    const out = await generateDraftText(
      buildComposePrompt({
        to: d.to,
        subject: d.subject || '',
        instruction: d.instruction,
        mailboxAddress: String(box.address),
      }),
      {workspaceId: d.workspace_id, inboundText: d.instruction},
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
  const subject = d.subject || '(No Subject)';
  const draftId = await saveAiDraft({
    workspaceId: d.workspace_id,
    mailboxId: d.mailbox_id,
    fromAddress: String(box.address),
    to: d.to,
    subject,
    text,
  });
  await addToReviewQueue(d.workspace_id, {
    draft_id: draftId,
    source_message_id: null,
    mailbox_id: d.mailbox_id,
    to: d.to,
    subject,
    auto: false,
    status: 'pending',
    created_at: new Date().toISOString(),
  });
  await logAiAction({
    action: 'ai.draft_created',
    workspaceId: d.workspace_id,
    actorUserId: user.id,
    mailboxId: d.mailbox_id,
    messageId: null,
    draftId,
    model,
    provider,
  });
  return NextResponse.json({draft_id: draftId, to: d.to, subject, text, model, provider});
}
