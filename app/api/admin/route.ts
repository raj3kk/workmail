import {NextResponse} from 'next/server';
import {dbOne, dbQuery} from '@/lib/db';
import {requireUser, requirePlatformAdmin} from '@/lib/guards';

export async function GET(req: Request) {
  const {user, response} = await requireUser(req);
  if (response) return response;
  if (!user) return NextResponse.json({error: 'Unauthorized'}, {status: 401});
  if (!(await requirePlatformAdmin(user.id)))
    return NextResponse.json({error: 'Platform admin access required'}, {status: 403});
  const [u, w, d, b, m] = await Promise.all([
    dbOne('SELECT COUNT(*) AS c FROM users'),
    dbOne('SELECT COUNT(*) AS c FROM workspaces'),
    dbOne('SELECT COUNT(*) AS c FROM domains'),
    dbOne('SELECT COUNT(*) AS c FROM mailboxes'),
    dbOne('SELECT COUNT(*) AS c FROM messages'),
  ]);
  const events = await dbQuery(
    'SELECT id, workspace_id, event_type, severity, created_at FROM security_events ORDER BY created_at DESC LIMIT 20',
  );
  return NextResponse.json({
    metrics: {
      users: Number(u?.c || 0),
      workspaces: Number(w?.c || 0),
      domains: Number(d?.c || 0),
      mailboxes: Number(b?.c || 0),
      messages: Number(m?.c || 0),
    },
    security_events: events,
  });
}
