import {NextResponse} from 'next/server';
import {dbOne, dbRun, jstr, newId, nowIso} from '@/lib/db';
import {authenticateWebhookToken} from '@/lib/webhook-tokens';
import {withRateLimit} from '@/lib/rate-limit';

export const runtime = 'nodejs';

// POST /api/delivery/webhook — record a provider delivery event
// (accepted / delivered / bounced / complained / ...) and apply its
// side effects (suppressions, message delivery_state).
//
// G-01 (closed): authentication is a PER-WORKSPACE token
// (`wm_hook_...`, table `webhook_tokens`, migration 0003). The
// workspace is derived from the token — NEVER from the body. A
// `workspace_id` in the body that does not match the token's
// workspace is rejected (403), so a token from workspace A can never
// inject bounces/suppressions for workspace B. The old single shared
// DELIVERY_WEBHOOK_TOKEN is retired and no longer read here; the env
// var can be removed from the host. Provider-native signature
// verification is a recorded follow-up (see docs/SECURITY.md).
//
// NOTE: the rate limit runs AFTER authentication, keyed by the
// token's workspace, so one workspace's webhook burst cannot
// consume another workspace's budget.

const ALLOWED = ['accepted', 'sent', 'delivered', 'deferred', 'bounced', 'complained', 'rejected', 'opened', 'clicked', 'unknown'];

export async function POST(req: Request) {
  const auth = await authenticateWebhookToken(req);
  if (!auth.ok) return NextResponse.json({error: auth.error}, {status: auth.status});
  const workspaceId = auth.auth.workspaceId;
  const limited = await withRateLimit({
    scope: 'write',
    subject: `webhook:${workspaceId}`,
    limit: 120,
    windowSeconds: 60,
  });
  if (limited) return limited;
  const body = await req.json().catch(() => null);
  if (!body || !body.workspace_id || !body.provider || !body.event_type || !body.recipient)
    return NextResponse.json({error: 'workspace_id, provider, event_type and recipient required'}, {status: 400});
  if (String(body.workspace_id) !== workspaceId)
    return NextResponse.json({error: 'workspace_id does not match the webhook token'}, {status: 403});
  if (!ALLOWED.includes(body.event_type))
    return NextResponse.json({error: 'Unsupported event type'}, {status: 400});
  const member = await dbOne('SELECT id FROM workspaces WHERE id = ?', [workspaceId]);
  if (!member) return NextResponse.json({error: 'Unknown workspace'}, {status: 404});
  const providerEventId = String(
    body.event_id || `${body.provider}:${body.message_id || ''}:${body.event_type}:${body.recipient}:${body.occurred_at || ''}`,
  ).slice(0, 200);
  const now = nowIso();
  try {
    await dbRun(
      `INSERT INTO delivery_events (id, workspace_id, message_id, provider, provider_event_id, event_type, recipient, details, occurred_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(provider, provider_event_id) DO UPDATE SET workspace_id = excluded.workspace_id,
         message_id = excluded.message_id, event_type = excluded.event_type, recipient = excluded.recipient,
         details = excluded.details, occurred_at = excluded.occurred_at`,
      [
        newId(),
        workspaceId,
        body.message_id || null,
        String(body.provider).slice(0, 40),
        providerEventId,
        body.event_type,
        String(body.recipient).toLowerCase().slice(0, 320),
        jstr(body.details || {}),
        body.occurred_at || now,
        now,
      ],
    );
  } catch (e) {
    return NextResponse.json({error: 'Could not record delivery event'}, {status: 500});
  }
  if (['bounced', 'complained'].includes(body.event_type)) {
    await dbRun(
      `INSERT INTO suppressions (id, workspace_id, email, reason, source, created_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(workspace_id, email) DO UPDATE SET reason = excluded.reason, source = excluded.source`,
      [
        newId(),
        workspaceId,
        String(body.recipient).toLowerCase(),
        body.event_type === 'bounced' ? 'hard_bounce' : 'complaint',
        String(body.provider).slice(0, 40),
        now,
      ],
    );
  }
  if (body.message_id) {
    const state =
      body.event_type === 'delivered'
        ? 'delivered'
        : body.event_type === 'bounced'
          ? 'bounced'
          : body.event_type === 'complained'
            ? 'complained'
            : body.event_type;
    await dbRun('UPDATE messages SET delivery_state = ?, updated_at = ? WHERE id = ? AND workspace_id = ?', [
      state,
      now,
      body.message_id,
      workspaceId,
    ]);
  }
  return NextResponse.json({success: true});
}
