import {NextResponse} from 'next/server';
import {dbOne, dbQuery, dbRun, jstr, newId, nowIso} from '@/lib/db';
import {requireUser, requirePlatformAdmin} from '@/lib/guards';

const LIMITS: Record<string, number> = {free: 300, pro: 5000, business: 25000, enterprise: 100000};

export async function GET(req: Request) {
  const {user, response} = await requireUser(req);
  if (response) return response;
  if (!user) return NextResponse.json({error: 'Unauthorized'}, {status: 401});
  if (!(await requirePlatformAdmin(user.id)))
    return NextResponse.json({error: 'Platform admin only'}, {status: 403});
  const rows = await dbQuery('SELECT id, name, owner_user_id, suspended_at, suspension_reason, created_at FROM workspaces ORDER BY created_at DESC LIMIT 500');
  const workspaces = [];
  for (const w of rows) {
    const settings = await dbOne('SELECT plan, monthly_send_limit FROM workspace_settings WHERE workspace_id = ?', [w.id]);
    const subscriptions = await dbQuery('SELECT status, plan_id FROM subscriptions WHERE workspace_id = ?', [w.id]);
    const usage = await dbQuery('SELECT period_start, sent_count, received_count FROM usage_counters WHERE workspace_id = ?', [w.id]);
    workspaces.push({...w, workspace_settings: settings || null, subscriptions, usage_counters: usage});
  }
  return NextResponse.json({workspaces});
}

export async function PATCH(req: Request) {
  const {user, response} = await requireUser(req);
  if (response) return response;
  if (!user) return NextResponse.json({error: 'Unauthorized'}, {status: 401});
  if (!(await requirePlatformAdmin(user.id)))
    return NextResponse.json({error: 'Platform admin only'}, {status: 403});
  const b = await req.json().catch(() => null);
  if (!b?.workspace_id || !['free', 'pro', 'business', 'enterprise'].includes(b.plan))
    return NextResponse.json({error: 'workspace_id and valid plan required'}, {status: 400});
  const before = await dbOne('SELECT plan, monthly_send_limit FROM workspace_settings WHERE workspace_id = ?', [b.workspace_id]);
  const now = nowIso();
  try {
    await dbRun(
      `INSERT INTO workspace_settings (workspace_id, plan, monthly_send_limit, created_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(workspace_id) DO UPDATE SET plan = excluded.plan, monthly_send_limit = excluded.monthly_send_limit`,
      [b.workspace_id, b.plan, LIMITS[b.plan], now],
    );
  } catch (e) {
    return NextResponse.json({error: e instanceof Error ? e.message : 'Could not change plan'}, {status: 400});
  }
  const after = {plan: b.plan, monthly_send_limit: LIMITS[b.plan]};
  await dbRun(
    'INSERT INTO plan_change_log (id, workspace_id, plan_id, changed_by, before_state, after_state, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [newId(), b.workspace_id, b.plan, user.id, before ? jstr(before) : null, jstr(after), now],
  );
  await dbRun(
    'INSERT INTO admin_actions (id, admin_user_id, action, target_workspace_id, details, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    [newId(), user.id, 'workspace.plan_changed', b.workspace_id, jstr({plan: b.plan}), now],
  );
  return NextResponse.json({success: true, plan: b.plan, monthly_send_limit: LIMITS[b.plan]});
}
