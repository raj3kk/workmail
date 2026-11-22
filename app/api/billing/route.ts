import {NextResponse} from 'next/server';
import {dbOne, dbQuery, dbRun, jstr, newId, nowIso} from '@/lib/db';
import {requireUser, requirePlatformAdmin} from '@/lib/guards';

function inList(ids: string[]): string {
  return `(${ids.map(() => '?').join(',')})`;
}

export async function GET(req: Request) {
  const {user, response} = await requireUser(req);
  if (response) return response;
  if (!user) return NextResponse.json({error: 'Unauthorized'}, {status: 401});
  const roles = await dbQuery(
    "SELECT workspace_id, role FROM memberships WHERE user_id = ? AND role IN ('owner','admin')",
    [user.id],
  );
  if (!roles.length) return NextResponse.json({error: 'Workspace owner/admin required'}, {status: 403});
  const ids = roles.map((r) => String(r.workspace_id));
  const [plans, subs, invoices] = await Promise.all([
    dbQuery('SELECT * FROM plan_catalog WHERE is_active = 1'),
    dbQuery(`SELECT * FROM subscriptions WHERE workspace_id IN ${inList(ids)}`, ids),
    dbQuery(
      `SELECT * FROM invoices WHERE workspace_id IN ${inList(ids)} ORDER BY issued_at DESC LIMIT 100`,
      ids,
    ),
  ]);
  return NextResponse.json({plans, subscriptions: subs, invoices});
}

export async function POST(req: Request) {
  const {user, response} = await requireUser(req);
  if (response) return response;
  if (!user) return NextResponse.json({error: 'Unauthorized'}, {status: 401});
  const b = await req.json().catch(() => null);
  if (!b?.workspace_id || !b?.plan_id)
    return NextResponse.json({error: 'workspace_id and plan_id required'}, {status: 400});
  const role = await dbOne('SELECT role FROM memberships WHERE workspace_id = ? AND user_id = ?', [b.workspace_id, user.id]);
  if (!role || !['owner', 'admin'].includes(String(role.role)))
    return NextResponse.json({error: 'Workspace owner/admin required'}, {status: 403});
  const plan = await dbOne('SELECT * FROM plan_catalog WHERE id = ? AND is_active = 1', [b.plan_id]);
  if (!plan) return NextResponse.json({error: 'Plan unavailable'}, {status: 404});
  const now = nowIso();
  const subId = newId();
  try {
    await dbRun(
      'INSERT INTO subscriptions (id, workspace_id, plan_id, status, billing_provider, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [subId, b.workspace_id, plan.id, 'pending', 'manual', now, now],
    );
  } catch {
    return NextResponse.json({error: 'A pending or active subscription already exists.'}, {status: 409});
  }
  const invoiceId = newId();
  try {
    await dbRun(
      'INSERT INTO invoices (id, workspace_id, subscription_id, amount_minor, currency, status, issued_at, metadata) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [invoiceId, b.workspace_id, subId, plan.monthly_price_minor, plan.currency, 'pending', now, jstr({})],
    );
  } catch (e) {
    return NextResponse.json({error: 'Could not create invoice'}, {status: 500});
  }
  const sub = await dbOne('SELECT * FROM subscriptions WHERE id = ?', [subId]);
  const invoice = await dbOne('SELECT * FROM invoices WHERE id = ?', [invoiceId]);
  return NextResponse.json({
    success: true,
    subscription: sub,
    invoice,
    notice: 'Payment must be verified by platform admin before plan activation.',
  });
}

export async function PATCH(req: Request) {
  const {user, response} = await requireUser(req);
  if (response) return response;
  if (!user) return NextResponse.json({error: 'Unauthorized'}, {status: 401});
  const b = await req.json().catch(() => null);
  if (!b?.invoice_id || !b?.payment_reference)
    return NextResponse.json({error: 'invoice_id and payment_reference required'}, {status: 400});
  if (!(await requirePlatformAdmin(user.id)))
    return NextResponse.json({error: 'Platform admin only'}, {status: 403});
  const invoice = await dbOne('SELECT id, subscription_id, workspace_id, status, metadata FROM invoices WHERE id = ?', [b.invoice_id]);
  if (!invoice || invoice.status !== 'pending')
    return NextResponse.json({error: 'Pending invoice not found'}, {status: 404});
  // G-16: evidence/notes for the payment (e.g. UPI reference, receipt
  // note). Stored on the invoice metadata and written into the
  // admin_actions detail so the confirmation is auditable.
  const evidence = typeof b.evidence === 'string' ? b.evidence.trim().slice(0, 2000) : typeof b.notes === 'string' ? b.notes.trim().slice(0, 2000) : '';
  const now = nowIso();
  const existingMeta = (() => {
    try {
      return JSON.parse(String(invoice.metadata || '{}')) as Record<string, unknown>;
    } catch {
      return {};
    }
  })();
  if (evidence) existingMeta.evidence = evidence;
  await dbRun('UPDATE invoices SET status = ?, payment_reference = ?, paid_at = ?, metadata = ? WHERE id = ?', [
    'paid',
    String(b.payment_reference).slice(0, 200),
    now,
    jstr(existingMeta),
    invoice.id,
  ]);
  if (invoice.subscription_id)
    await dbRun('UPDATE subscriptions SET status = ?, updated_at = ? WHERE id = ?', ['active', now, invoice.subscription_id]);
  const sub = invoice.subscription_id
    ? await dbOne('SELECT plan_id FROM subscriptions WHERE id = ?', [invoice.subscription_id])
    : null;
  if (sub) {
    const plan = await dbOne('SELECT monthly_send_limit FROM plan_catalog WHERE id = ?', [sub.plan_id]);
    const limit = plan ? Number(plan.monthly_send_limit) : null;
    if (limit)
      await dbRun(
        `INSERT INTO workspace_settings (workspace_id, plan, monthly_send_limit, created_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(workspace_id) DO UPDATE SET plan = excluded.plan, monthly_send_limit = excluded.monthly_send_limit`,
        [invoice.workspace_id, sub.plan_id, limit, now],
      );
  }
  await dbRun(
    'INSERT INTO admin_actions (id, admin_user_id, action, target_workspace_id, details, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    [newId(), user.id, 'billing.invoice_paid', invoice.workspace_id, jstr({invoice_id: invoice.id, payment_reference: b.payment_reference, ...(evidence ? {evidence} : {})}), now],
  );
  return NextResponse.json({success: true, activated: true});
}
