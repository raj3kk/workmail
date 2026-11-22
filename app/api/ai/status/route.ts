import {NextResponse} from 'next/server';
import {requireUser, workspaceRole} from '@/lib/guards';
import {aiConfig, AI_PROMPT_VERSION} from '@/lib/ai';
import {listTraining} from '@/lib/ai-training';

export const runtime = 'nodejs';

// GET /api/ai/status — is the AI agent configured, and with what?
// Always 200 for authenticated users; `configured: false` is a normal,
// honest state, not an error. No secret is ever returned.
// G-19: `workspace_id` is REQUIRED, always. Without it the response
// used to leak host config (provider/model) to any logged-in user
// with no workspace membership. Now the caller must name a workspace
// they belong to; otherwise 400 (no workspace_id) or 403 (not a
// member). NOTE: app/page.tsx calls this endpoint without
// workspace_id today — its owner must pass
// `?workspace_id=<current>` (one-line fix) or the inbox AI status
// stops loading. See docs/SECURITY.md.
export async function GET(req: Request) {
  const {user, response} = await requireUser(req);
  if (response) return response;
  if (!user) return NextResponse.json({error: 'Unauthorized'}, {status: 401});
  const workspaceId = new URL(req.url).searchParams.get('workspace_id');
  if (!workspaceId) return NextResponse.json({error: 'workspace_id required'}, {status: 400});
  if (!(await workspaceRole(user.id, workspaceId)))
    return NextResponse.json({error: 'Workspace access denied'}, {status: 403});
  const cfg = aiConfig();
  const entries = await listTraining(workspaceId);
  const training = {
    entries: entries.length,
    has_profile: entries.some((e) => e.kind === 'profile'),
    updated_at: entries.map((e) => e.updated_at).sort().at(-1) || null,
  };
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
    // Business training for this workspace (workspace_id is always
    // given now — see G-19 above). Training is injected into drafts,
    // replies, and auto-replies; see docs/AI-AGENT.md "Training".
    training,
  });
}
