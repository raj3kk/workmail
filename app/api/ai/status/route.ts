import {NextResponse} from 'next/server';
import {requireUser, workspaceRole} from '@/lib/guards';
import {aiConfig, AI_PROMPT_VERSION} from '@/lib/ai';
import {listTraining} from '@/lib/ai-training';

export const runtime = 'nodejs';

// GET /api/ai/status — is the AI agent configured, and with what?
// Always 200 for authenticated users; `configured: false` is a normal,
// honest state, not an error. No secret is ever returned.
// With ?workspace_id= (member), also reports that workspace's training
// presence/count — additive only, the base shape is unchanged.
export async function GET(req: Request) {
  const {user, response} = await requireUser(req);
  if (response) return response;
  if (!user) return NextResponse.json({error: 'Unauthorized'}, {status: 401});
  const cfg = aiConfig();
  let training: {entries: number; has_profile: boolean; updated_at: string | null} | null = null;
  const workspaceId = new URL(req.url).searchParams.get('workspace_id');
  if (workspaceId && (await workspaceRole(user.id, workspaceId))) {
    const entries = await listTraining(workspaceId);
    training = {
      entries: entries.length,
      has_profile: entries.some((e) => e.kind === 'profile'),
      updated_at: entries.map((e) => e.updated_at).sort().at(-1) || null,
    };
  }
  return NextResponse.json({
    configured: cfg.configured,
    provider: cfg.provider,
    model: cfg.configured ? cfg.model : null,
    prompt_version: AI_PROMPT_VERSION,
    // Auto-send is LIVE: when the per-mailbox auto-reply toggle is ON
    // and the AI agent is configured, /api/inbound transmits the reply
    // automatically via the service-authenticated send path
    // (lib/ai.ts maybeAutoReply -> executeServiceSend). Max one
    // auto-reply per inbound message / thread.
    auto_send: true,
    auto_send_note:
      'When the per-mailbox auto-reply toggle is ON, incoming mail gets an AI reply transmitted automatically via the service send path (max one per inbound message/thread). With the toggle OFF, auto-replies are only drafted into the human-review queue.',
    reason: cfg.configured ? null : cfg.reason,
    // Business training for this workspace (null when no workspace_id
    // was given). Training is injected into drafts, replies, and
    // auto-replies; see docs/AI-AGENT.md "Training".
    training,
  });
}
