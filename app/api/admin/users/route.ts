import {NextResponse} from 'next/server';
import {dbQuery, dbRun, jstr, newId, nowIso} from '@/lib/db';
import {requireUser, requirePlatformAdmin} from '@/lib/guards';

export async function GET(req: Request) {
  const {user, response} = await requireUser(req);
  if (response) return response;
  if (!user) return NextResponse.json({error: 'Unauthorized'}, {status: 401});
  if (!(await requirePlatformAdmin(user.id)))
    return NextResponse.json({error: 'Platform admin only'}, {status: 403});
  const users = await dbQuery('SELECT * FROM platform_user_controls ORDER BY updated_at DESC LIMIT 500');
  return NextResponse.json({users});
}

export async function PATCH(req: Request) {
  const {user, response} = await requireUser(req);
  if (response) return response;
  if (!user) return NextResponse.json({error: 'Unauthorized'}, {status: 401});
  if (!(await requirePlatformAdmin(user.id)))
    return NextResponse.json({error: 'Platform admin only'}, {status: 403});
  const b = await req.json().catch(() => null);
  if (!b?.user_id || typeof b.suspended !== 'boolean')
    return NextResponse.json({error: 'user_id and suspended required'}, {status: 400});
  const now = nowIso();
  const suspendedAt = b.suspended ? now : null;
  const reason = b.suspended ? String(b.reason || 'Policy review').slice(0, 500) : null;
  try {
    await dbRun(
      `INSERT INTO platform_user_controls (user_id, suspended_at, suspension_reason, mfa_required, updated_by, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET suspended_at = excluded.suspended_at,
         suspension_reason = excluded.suspension_reason, mfa_required = excluded.mfa_required,
         updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
      [b.user_id, suspendedAt, reason, b.mfa_required !== false ? 1 : 0, user.id, now],
    );
  } catch (e) {
    return NextResponse.json({error: e instanceof Error ? e.message : 'Could not update user controls'}, {status: 400});
  }
  // The auth guard enforces users.suspended_at, so mirror the suspension
  // there too; the old route only wrote platform_user_controls, which the
  // guard never read, so a suspension never actually took effect.
  await dbRun('UPDATE users SET suspended_at = ?, suspension_reason = ?, updated_at = ? WHERE id = ?', [
    suspendedAt,
    reason,
    now,
    b.user_id,
  ]);
  await dbRun(
    'INSERT INTO admin_actions (id, admin_user_id, action, details, created_at) VALUES (?, ?, ?, ?, ?)',
    [newId(), user.id, b.suspended ? 'user.suspended' : 'user.reinstated', jstr({target_user_id: b.user_id, reason}), now],
  );
  return NextResponse.json({success: true});
}
