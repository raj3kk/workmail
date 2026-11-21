import {NextResponse} from 'next/server';
import {requireUser} from '@/lib/guards';
import {aiConfig, AI_PROMPT_VERSION} from '@/lib/ai';

export const runtime = 'nodejs';

// GET /api/ai/status — is the AI agent configured, and with what?
// Always 200 for authenticated users; `configured: false` is a normal,
// honest state, not an error. No secret is ever returned.
export async function GET(req: Request) {
  const {user, response} = await requireUser(req);
  if (response) return response;
  if (!user) return NextResponse.json({error: 'Unauthorized'}, {status: 401});
  const cfg = aiConfig();
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
  });
}
