import {NextResponse} from 'next/server';
import {randomBytes} from 'node:crypto';
import {googleAuthUrl} from '@/lib/auth';

export async function GET() {
  const state = randomBytes(16).toString('base64url');
  const res = NextResponse.redirect(googleAuthUrl(state));
  // Max-Age 1800 (30 min), not 600: Google's phone challenges ("tap
  // Yes" + number matching) can take minutes, and a user who fumbles
  // the challenge can easily exceed 10 min between this redirect and
  // the callback — then the state cookie is gone and the callback fails
  // its state check (BUGFIX 2026-11-22, rajraj3kk repro). The state is
  // a 128-bit random checked once and cleared on success, so the CSRF
  // protection is unchanged by the longer window.
  res.headers.set(
    'Set-Cookie',
    `wm_oauth_state=${encodeURIComponent(state)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=1800; Secure`,
  );
  return res;
}
