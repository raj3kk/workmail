import {NextResponse} from 'next/server';
import {dbOne, dbQuery, dbRun, jstr, newId, nowIso} from '@/lib/db';
import {requireUser, requirePlatformAdmin} from '@/lib/guards';

export async function GET(req: Request) {
  const {user, response} = await requireUser(req);
  if (response) return response;
  if (!user) return NextResponse.json({error: 'Unauthorized'}, {status: 401});
  if (!(await requirePlatformAdmin(user.id)))
    return NextResponse.json({error: 'Platform admin only'}, {status: 403});
  const payments = await dbQuery('SELECT * FROM payment_events ORDER BY created_at DESC LIMIT 500');
  return NextResponse.json({payments});
}

export async function POST(req: Request) {
  const {user, response} = await requireUser(req);
  if (response) return response;
  if (!user) return NextResponse.json({error: 'Unauthorized'}, {status: 401});
  if (!(await requirePlatformAdmin(user.id)))
    return NextResponse.json({error: 'Platform admin only'}, {status: 403});
  const b = await req.json().catch(() => null);
  if (!b?.invoice_id || !b?.event_type)
    return NextResponse.json({error: 'invoice_id and event_type required'}, {status: 400});
  const inv = await dbOne('SELECT * FROM invoices WHERE id = ?', [b.invoice_id]);
  if (!inv) return NextResponse.json({error: 'Invoice not found'}, {status: 404});
  const eventId = newId();
  const now = nowIso();
  try {
    await dbRun(
      'INSERT INTO payment_events (id, invoice_id, workspace_id, provider, provider_event_id, event_type, amount_minor, currency, verified, payload, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [
        eventId,
        inv.id,
        inv.workspace_id,
        String(b.provider || 'manual'),
        b.provider_event_id || null,
        String(b.event_type).slice(0, 80),
        inv.amount_minor,
        inv.currency,
        b.verified === true ? 1 : 0,
        jstr({reference: b.reference || null}),
        now,
      ],
    );
  } catch (e) {
    return NextResponse.json({error: 'Could not record payment event'}, {status: 400});
  }
  if (b.verified === true && b.event_type === 'payment_succeeded') {
    await dbRun('UPDATE invoices SET status = ?, payment_reference = ?, paid_at = ? WHERE id = ?', [
      'paid',
      String(b.reference || 'verified-manual').slice(0, 200),
      now,
      inv.id,
    ]);
    if (inv.subscription_id)
      await dbRun('UPDATE subscriptions SET status = ?, updated_at = ? WHERE id = ?', ['active', now, inv.subscription_id]);
  }
  await dbRun(
    'INSERT INTO admin_actions (id, admin_user_id, action, target_workspace_id, details, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    [newId(), user.id, 'payment.event_recorded', inv.workspace_id, jstr({invoice_id: inv.id, event_type: b.event_type, verified: b.verified === true}), now],
  );
  const event = await dbOne('SELECT * FROM payment_events WHERE id = ?', [eventId]);
  return NextResponse.json({success: true, event});
}
