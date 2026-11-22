import {NextResponse} from 'next/server';
import {dbQuery} from '@/lib/db';

export async function GET() {
  const t = Date.now();
  try {
    await dbQuery('SELECT 1 AS ok');
    return NextResponse.json({app: 'ok', d1: 'ok', latency_ms: Date.now() - t});
  } catch (e) {
    // G-08: generic 'down' only — the D1 error text never leaves the
    // server (it can name the database, the account, or internals).
    return NextResponse.json(
      {app: 'ok', d1: 'down', latency_ms: Date.now() - t},
      {status: 503},
    );
  }
}
