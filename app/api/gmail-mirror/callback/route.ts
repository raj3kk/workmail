// Gmail backup mirror — OAuth callback (Phase 4, PRODUCTION-PLAN.md §7).
// Verifies the state nonce against the state cookie (same pattern as the
// sign-in callback), exchanges the code for tokens, and stores ONLY the
// refresh token — encrypted with lib/crypto.ts — in D1 (gmail_oauth_tokens).
// The refresh token is never logged and never returned to the client.
// On success the owner lands back on Settings with a confirmation flag.
import {NextResponse} from 'next/server';
import {getSessionUser} from '@/lib/auth';
import {workspaceRole} from '@/lib/guards';
import {
  GMAIL_MIRROR_STATE_COOKIE,
  clearGmailMirrorStateCookie,
  exchangeGmailMirrorCode,
  parseGmailMirrorState,
  storeGmailMirrorToken,
} from '@/lib/gmail-oauth';

export const runtime = 'nodejs';

function redirectToSettings(req: Request, params: Record<string, string>): NextResponse {
  const dest = new URL('/settings', new URL(req.url).origin);
  for (const [k, v] of Object.entries(params)) dest.searchParams.set(k, v);
  const res = NextResponse.redirect(dest);
  res.headers.append('Set-Cookie', clearGmailMirrorStateCookie());
  return res;
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const code = url.searchParams.get('code');
  const stateRaw = url.searchParams.get('state');
  const error = url.searchParams.get('error');
  if (error || !code) return redirectToSettings(req, {gmail_mirror: 'error'});
  const parsed = parseGmailMirrorState(stateRaw);
  if (!parsed) return redirectToSettings(req, {gmail_mirror: 'error'});
  const cookie = req.headers.get('cookie') || '';
  const m = cookie.match(new RegExp(`(?:^|;\\s*)${GMAIL_MIRROR_STATE_COOKIE}=([^;]+)`));
  const storedNonce = m ? decodeURIComponent(m[1]) : null;
  if (!storedNonce || storedNonce !== parsed.nonce) return redirectToSettings(req, {gmail_mirror: 'error'});
  const {user} = await getSessionUser(req);
  if (!user) return redirectToSettings(req, {gmail_mirror: 'error'});
  const role = await workspaceRole(user.id, parsed.workspaceId);
  if (role !== 'owner') return redirectToSettings(req, {gmail_mirror: 'error'});
  try {
    const {refreshToken, email} = await exchangeGmailMirrorCode(code);
    await storeGmailMirrorToken(parsed.workspaceId, user.id, refreshToken, email);
    return redirectToSettings(req, {gmail_mirror: 'connected'});
  } catch {
    return redirectToSettings(req, {gmail_mirror: 'error'});
  }
}
