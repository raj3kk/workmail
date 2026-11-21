import {NextResponse} from 'next/server';
import {createSession, exchangeGoogleCode, sessionCookie, upsertGoogleUser} from '@/lib/auth';

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
  try {
    const profile = await exchangeGoogleCode(code);
    const user = await upsertGoogleUser(profile);
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
