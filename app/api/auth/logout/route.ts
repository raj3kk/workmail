import {NextResponse} from 'next/server';
import {destroySession, clearSessionCookie} from '@/lib/auth';

export async function POST(req: Request) {
  await destroySession(req);
  return NextResponse.json({success: true}, {headers: {'Set-Cookie': clearSessionCookie()}});
}
