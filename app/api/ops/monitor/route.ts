import {NextResponse} from 'next/server';
import {timingSafeEqual, createHash} from 'node:crypto';
import {dbRun, jstr, newId, nowIso} from '@/lib/db';

function tokenMatches(supplied: string, expected: string): boolean {
  if (!supplied || !expected) return false;
  const a = createHash('sha256').update(supplied).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

export async function GET(req: Request) {
  const tok = req.headers.get('authorization')?.replace(/^Bearer /i, '');
  if (!tokenMatches(tok || '', process.env.OPS_CRON_TOKEN || ''))
    return NextResponse.json({error: 'Unauthorized'}, {status: 401});
  const t = Date.now();
  let status = 'ok';
  const details: Record<string, unknown> = {};
  try {
    const r = await fetch(new URL('/api/health', req.url), {cache: 'no-store', signal: AbortSignal.timeout(8000)});
    details.health_status = r.status;
    details.health = await r.json().catch(() => null);
    if (!r.ok) status = 'degraded';
  } catch (e) {
    status = 'down';
    details.error = String(e);
  }
  const now = nowIso();
  await dbRun(
    'INSERT INTO monitor_checks (id, check_name, status, latency_ms, details, checked_at) VALUES (?, ?, ?, ?, ?, ?)',
    [newId(), 'application_health', status, Date.now() - t, jstr(details), now],
  );
  if (status !== 'ok' && process.env.ALERT_WEBHOOK_URL)
    await fetch(process.env.ALERT_WEBHOOK_URL, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({text: 'WorkMail health ' + status, details}),
    }).catch(() => {});
  return NextResponse.json({status, details});
}
