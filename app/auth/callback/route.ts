import {NextResponse} from 'next/server';
import {createSession, exchangeGoogleCode, sessionCookie, upsertGoogleUser, revokeAllSessions} from '@/lib/auth';
import {clientIp, withRateLimit, RATE_LIMIT_DEFAULTS} from '@/lib/rate-limit';

// Sign-in failure reasons (BUGFIX 2026-11-22: the old code sent EVERY
// failure to /?auth=error and no page ever read it, so a user whose
// sign-in failed saw a bare login screen with zero explanation.
// The reason now travels as ?auth=error&reason=<reason> and the login
// page (app/page.tsx) shows the plain-words message for it. The reason
// is also logged server-side (reason only — no code, state, or email —
// so the NEXT failure is diagnosable from Vercel function logs).
const REASONS = new Set([
  'access_denied',
  'google_error',
  'no_code',
  'state_mismatch',
  'rate_limited',
  'token_failed',
  'userinfo_failed',
  'email_not_verified',
  'account_failed',
]);

function logAuthFail(reason: string): void {
  console.log(JSON.stringify({event: 'auth_callback_failed', reason}));
}

function errorRedirect(url: URL, reason: string): NextResponse {
  const safe = REASONS.has(reason) ? reason : 'account_failed';
  logAuthFail(safe);
  const dest = new URL('/', url.origin);
  dest.searchParams.set('auth', 'error');
  dest.searchParams.set('reason', safe);
  return NextResponse.redirect(dest);
}

function reasonFromError(e: unknown): string {
  const msg = e instanceof Error ? e.message : '';
  if (msg.includes('token exchange')) return 'token_failed';
  if (msg.includes('userinfo') || msg.includes('missing sub/email')) return 'userinfo_failed';
  if (msg.includes('not verified')) return 'email_not_verified';
  return 'account_failed';
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  // Google sends ?error=access_denied when the user cancels at Google
  // or backs out of the "unverified app" warning screen (consent screen
  // not yet verified by Google). That used to look identical to every
  // other failure — a bare login screen. Surface it distinctly.
  const googleError = url.searchParams.get('error');
  if (googleError) return errorRedirect(url, googleError === 'access_denied' ? 'access_denied' : 'google_error');
  if (!code) return errorRedirect(url, 'no_code');
  // CSRF check against the state cookie set by /api/auth/login.
  const cookie = request.headers.get('cookie') || '';
  const m = cookie.match(/(?:^|;\s*)wm_oauth_state=([^;]+)/);
  const stored = m ? decodeURIComponent(m[1]) : null;
  if (!state || !stored || state !== stored) return errorRedirect(url, 'state_mismatch');
  // G-03: the callback is a GET that mints a session, so it gets the
  // D1-backed auth limiter (per client IP). A burst of code-exchange
  // attempts is throttled instead of hammering Google + D1.
  const limited = await withRateLimit({
    scope: 'auth',
    subject: clientIp(request),
    limit: RATE_LIMIT_DEFAULTS.auth.limit,
    windowSeconds: RATE_LIMIT_DEFAULTS.auth.windowSeconds,
  });
  if (limited) return errorRedirect(url, 'rate_limited');
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
  } catch (e) {
    return errorRedirect(url, reasonFromError(e));
  }
}
