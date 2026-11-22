import {NextResponse} from 'next/server';
import {z} from 'zod';
import {requireUser, workspaceRole} from '@/lib/guards';
import {checkRateLimit, rateLimitResponse} from '@/lib/rate-limit';
import {draftWithAi, AiDraftError} from '@/lib/ai-draft';

export const runtime = 'nodejs';

// POST /api/ai/draft — "Draft with AI" (E4, BYOK drafting helper).
// Body: {workspace_id, topic, tone?, to?, subject?}. Returns
// {subject, body, provider, model} for the user to review and edit —
// NOTHING is sent automatically. Rate-limited (D1 limiter,
// 10/min/workspace). The prompt is topic-only; no other user's mail
// content is ever included. Priority: user's own Gemini key, then
// Groq key, then Workers AI (lib/ai.ts); no key anywhere = a clear
// 503 naming the fix, never a crash, never a fake draft.

const draftSchema = z.object({
  workspace_id: z.string().uuid(),
  topic: z.string().min(2).max(1000),
  tone: z.enum(['formal', 'friendly', 'short']).optional(),
  to: z.string().max(320).optional(),
  subject: z.string().max(200).optional(),
});

export async function POST(req: Request) {
  const {user, response} = await requireUser(req);
  if (response) return response;
  if (!user) return NextResponse.json({error: 'Unauthorized'}, {status: 401});
  const parsed = draftSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success)
    return NextResponse.json({error: 'topic (2–1000 chars) and workspace_id are required', details: parsed.error.flatten()}, {status: 400});
  const d = parsed.data;
  const role = await workspaceRole(user.id, d.workspace_id);
  if (!role) return NextResponse.json({error: 'Workspace access denied'}, {status: 403});

  const limit = await checkRateLimit({scope: 'ai_draft', subject: d.workspace_id, limit: 10, windowSeconds: 60});
  if (!limit.allowed) return rateLimitResponse(limit);

  try {
    const out = await draftWithAi({
      workspaceId: d.workspace_id,
      topic: d.topic,
      tone: d.tone || 'friendly',
      to: d.to,
      subject: d.subject,
    });
    return NextResponse.json({subject: out.subject, body: out.body, provider: out.provider, model: out.model});
  } catch (e) {
    if (e instanceof AiDraftError)
      return NextResponse.json({error: e.message, code: e.code}, {status: e.status});
    return NextResponse.json({error: 'AI drafting failed. Try again, or add your own Gemini/Groq key in Settings.'}, {status: 502});
  }
}
