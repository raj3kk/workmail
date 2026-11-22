import {NextResponse} from 'next/server';
import {createSession, exchangeGoogleCode, sessionCookie, upsertGoogleUser, revokeAllSessions} from '@/lib/auth';
import {clientIp, withRateLimit, RATE_LIMIT_DEFAULTS} from '@/lib/rate-limit';

function errorRedirect(url: URL): NextResponse {
  const dest = new URL('/', url.origin);
  dest.searchParams.set('auth', 'error');
  return NextResponse.redirect(dest);
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  if (!code) return errorRedirect(url);
  // CSRF check against the state cookie set by /api/auth/login.
  const cookie = request.headers.get('cookie') || '';
  const m = cookie.match(/(?:^|;\s*)wm_oauth_state=([^;]+)/);
  const stored = m ? decodeURIComponent(m[1]) : null;
  if (!state || !stored || state !== stored) return errorRedirect(url);
  // G-03: the callback is a GET that mints a session, so it gets the
  // D1-backed auth limiter (per client IP). A burst of code-exchange
  // attempts is throttled instead of hammering Google + D1.
  const limited = await withRateLimit({
    scope: 'auth',
    subject: clientIp(request),
    limit: RATE_LIMIT_DEFAULTS.auth.limit,
    windowSeconds: RATE_LIMIT_DEFAULTS.auth.windowSeconds,
  });
  if (limited) return errorRedirect(url);
  try {
    const profile = await exchangeGoogleCode(code);
    const user = await upsertGoogleUser(profile);
    // G-10 session rotation: every prior session of this user is
    // destroyed before the fresh one is created, so a login is always
    // a rotation to exactly one live session. (Other devices are
    // signed out on the next login — that is the point of rotation;
    // see docs/SECURITY.md.)
    await revokeAllSessions(user.id);
    const token = await createSession(user.id);
    const res = NextResponse.redirect(new URL('/', url.origin));
    res.headers.set('Set-Cookie', sessionCookie(token));
    res.headers.append(
      'Set-Cookie',
      'wm_oauth_state=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0; Secure',
    );
    return res;
  } catch {
    return errorRedirect(url);
  }
}
