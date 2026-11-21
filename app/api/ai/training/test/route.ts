import {NextResponse} from 'next/server';
import {z} from 'zod';
import {requireUser, workspaceRole} from '@/lib/guards';
import {
  AiNotConfiguredError,
  AiProviderError,
  buildReplyPrompt,
  generateDraftText,
  logAiAction,
} from '@/lib/ai';

export const runtime = 'nodejs';

const schema = z.object({
  workspace_id: z.string().uuid(),
  message: z.string().min(1).max(6000),
  subject: z.string().max(998).optional(),
  from: z.string().max(320).optional(),
});

// POST /api/ai/training/test — "Ask the agent" test box.
// Takes a sample inbound customer message and returns an AI draft reply
// built from this workspace's training. The draft is returned for review
// ONLY: it is never saved as a draft, never queued, and never sent —
// there is no send path in this route at all. Requires a signed-in
// session + workspace membership. 503 when AI is not configured.
export async function POST(req: Request) {
  const {user, response} = await requireUser(req);
  if (response) return response;
  if (!user) return NextResponse.json({error: 'Unauthorized'}, {status: 401});
  const p = schema.safeParse(await req.json().catch(() => null));
  if (!p.success) return NextResponse.json({error: 'Invalid request'}, {status: 400});
  if (!(await workspaceRole(user.id, p.data.workspace_id)))
    return NextResponse.json({error: 'Workspace access denied'}, {status: 403});
  let out;
  try {
    out = await generateDraftText(
      buildReplyPrompt({
        from: p.data.from || 'test customer <test@example.com>',
        subject: p.data.subject || '(Test message)',
        body: p.data.message,
        mailboxAddress: 'test mailbox',
      }),
      {workspaceId: p.data.workspace_id, inboundText: `${p.data.subject || ''}\n${p.data.message}`},
    );
  } catch (e) {
    if (e instanceof AiNotConfiguredError)
      return NextResponse.json({error: e.message, code: 'AI_NOT_CONFIGURED'}, {status: 503});
    if (e instanceof AiProviderError)
      return NextResponse.json({error: e.message, code: 'AI_PROVIDER_ERROR'}, {status: 503});
    return NextResponse.json({error: 'AI test draft failed'}, {status: 502});
  }
  // Metadata only: which training entries were used (ids + count), never
  // the sample message body or the training content.
  await logAiAction({
    action: 'ai.training_tested',
    workspaceId: p.data.workspace_id,
    actorUserId: user.id,
    training: {count: out.trainingUsed.entryIds.length, entryIds: out.trainingUsed.entryIds},
    model: out.config.model,
    provider: out.config.provider,
  });
  return NextResponse.json({
    draft: out.text,
    model: out.config.model,
    provider: out.config.provider,
    training_used: {
      entries: out.trainingUsed.entryIds.length,
      entry_ids: out.trainingUsed.entryIds,
      chars: out.trainingUsed.chars,
      total_entries: out.trainingUsed.totalEntries,
    },
    // Explicit: this draft was NOT saved, queued, or sent anywhere.
    saved: false,
    sent: false,
  });
}
