import {NextResponse} from 'next/server';
import {dbQuery} from '@/lib/db';

export async function GET() {
  const t = Date.now();
  try {
    await dbQuery('SELECT 1 AS ok');
    return NextResponse.json({app: 'ok', d1: 'ok', latency_ms: Date.now() - t});
  } catch (e) {
    return NextResponse.json(
      {app: 'ok', d1: 'down', latency_ms: Date.now() - t, error: e instanceof Error ? e.message : 'D1 unreachable'},
      {status: 503},
    );
  }
}
