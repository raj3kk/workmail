import {NextResponse} from 'next/server';
import {createHash, timingSafeEqual} from 'node:crypto';
import {dbOne, dbRun, jstr, newId, nowIso} from '@/lib/db';

export const runtime = 'nodejs';

const ALLOWED = ['accepted', 'sent', 'delivered', 'deferred', 'bounced', 'complained', 'rejected', 'opened', 'clicked', 'unknown'];

export async function POST(req: Request) {
  const secret = process.env.DELIVERY_WEBHOOK_TOKEN;
  if (!secret) return NextResponse.json({error: 'Webhook is not configured'}, {status: 503});
  const auth = req.headers.get('authorization') || '';
  const supplied = auth.replace(/^Bearer\s+/i, '');
  const a = createHash('sha256').update(supplied).digest();
  const b = createHash('sha256').update(secret).digest();
  if (!timingSafeEqual(a, b)) return NextResponse.json({error: 'Unauthorized'}, {status: 401});
  const body = await req.json().catch(() => null);
  if (!body || !body.workspace_id || !body.provider || !body.event_type || !body.recipient)
    return NextResponse.json({error: 'workspace_id, provider, event_type and recipient required'}, {status: 400});
  if (!ALLOWED.includes(body.event_type))
    return NextResponse.json({error: 'Unsupported event type'}, {status: 400});
  const member = await dbOne('SELECT id FROM workspaces WHERE id = ?', [body.workspace_id]);
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
        body.workspace_id,
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
    return NextResponse.json({error: e instanceof Error ? e.message : 'Could not record delivery event'}, {status: 500});
  }
  if (['bounced', 'complained'].includes(body.event_type)) {
    await dbRun(
      `INSERT INTO suppressions (id, workspace_id, email, reason, source, created_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(workspace_id, email) DO UPDATE SET reason = excluded.reason, source = excluded.source`,
      [
        newId(),
        body.workspace_id,
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
      body.workspace_id,
    ]);
  }
  return NextResponse.json({success: true});
}
