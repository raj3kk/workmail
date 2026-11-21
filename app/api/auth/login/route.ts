import {NextResponse} from 'next/server';
import {randomBytes} from 'node:crypto';
import {googleAuthUrl} from '@/lib/auth';

export async function GET() {
  const state = randomBytes(16).toString('base64url');
  const res = NextResponse.redirect(googleAuthUrl(state));
  res.headers.set(
    'Set-Cookie',
    `wm_oauth_state=${encodeURIComponent(state)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=600; Secure`,
  );
  return res;
}
