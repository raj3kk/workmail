import {NextResponse} from 'next/server';
import {dbOne, dbQuery, dbRun, jstr, newId, nowIso} from '@/lib/db';
import {requireUser, requirePlatformAdmin} from '@/lib/guards';

export async function GET(req: Request) {
  const {user, response} = await requireUser(req);
  if (response) return response;
  if (!user) return NextResponse.json({error: 'Unauthorized'}, {status: 401});
  if (!(await requirePlatformAdmin(user.id)))
    return NextResponse.json({error: 'Platform admin only'}, {status: 403});
  const plans = await dbQuery('SELECT * FROM plan_catalog ORDER BY monthly_price_minor ASC');
  return NextResponse.json({plans});
}

export async function POST(req: Request) {
  const {user, response} = await requireUser(req);
  if (response) return response;
  if (!user) return NextResponse.json({error: 'Unauthorized'}, {status: 401});
  if (!(await requirePlatformAdmin(user.id)))
    return NextResponse.json({error: 'Platform admin only'}, {status: 403});
  const b = await req.json().catch(() => null);
  if (
    !b?.id ||
    !b?.name ||
    !Number.isInteger(b.monthly_price_minor) ||
    b.monthly_price_minor < 0 ||
    !Number.isInteger(b.monthly_send_limit) ||
    b.monthly_send_limit < 0 ||
    !Number.isInteger(b.storage_limit_bytes) ||
    b.storage_limit_bytes < 0
  )
    return NextResponse.json({error: 'Invalid plan fields'}, {status: 400});
  const id = String(b.id).toLowerCase().replace(/[^a-z0-9_-]/g, '');
  const before = await dbOne('SELECT * FROM plan_catalog WHERE id = ?', [id]);
  const payload = {
    id,
    name: String(b.name).slice(0, 80),
    monthly_price_minor: b.monthly_price_minor,
    currency: String(b.currency || 'INR').slice(0, 3).toUpperCase(),
    monthly_send_limit: b.monthly_send_limit,
    storage_limit_bytes: b.storage_limit_bytes,
    features: b.features || {},
    is_active: b.is_active !== false ? 1 : 0,
  };
  const now = nowIso();
  try {
    await dbRun(
      `INSERT INTO plan_catalog (id, name, monthly_price_minor, currency, monthly_send_limit, storage_limit_bytes, features, is_active, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET name = excluded.name, monthly_price_minor = excluded.monthly_price_minor,
         currency = excluded.currency, monthly_send_limit = excluded.monthly_send_limit,
         storage_limit_bytes = excluded.storage_limit_bytes, features = excluded.features, is_active = excluded.is_active`,
      [payload.id, payload.name, payload.monthly_price_minor, payload.currency, payload.monthly_send_limit, payload.storage_limit_bytes, jstr(payload.features), payload.is_active, now],
    );
  } catch (e) {
    return NextResponse.json({error: 'Could not save plan'}, {status: 400});
  }
  await dbRun(
    'INSERT INTO plan_change_log (id, plan_id, changed_by, before_state, after_state, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    [newId(), id, user.id, before ? jstr(before) : null, jstr(payload), now],
  );
  await dbRun(
    'INSERT INTO admin_actions (id, admin_user_id, action, details, created_at) VALUES (?, ?, ?, ?, ?)',
    [newId(), user.id, 'plan.upserted', jstr({plan_id: id}), now],
  );
  const plan = await dbOne('SELECT * FROM plan_catalog WHERE id = ?', [id]);
  return NextResponse.json({plan});
}
