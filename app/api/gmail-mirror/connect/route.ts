// Gmail backup mirror — connect (Phase 4, PRODUCTION-PLAN.md §7).
// Owner-only. Redirects the workspace owner to Google consent for the
// restricted mirror scopes (gmail.insert + gmail.labels). This is a
// SEPARATE flow from sign-in: the sign-in flow never requests Gmail scopes.
import {NextResponse} from 'next/server';
import {requireUser, workspaceRole} from '@/lib/guards';
import {buildGmailMirrorState, gmailMirrorAuthUrl, gmailMirrorStateCookie} from '@/lib/gmail-oauth';

export const runtime = 'nodejs';

export async function GET(req: Request) {
  const {user, response} = await requireUser(req);
  if (response) return response;
  if (!user) return NextResponse.json({error: 'Unauthorized'}, {status: 401});
  const workspaceId = new URL(req.url).searchParams.get('workspace_id') || '';
  if (!workspaceId) return NextResponse.json({error: 'workspace_id is required'}, {status: 400});
  const role = await workspaceRole(user.id, workspaceId);
  if (role !== 'owner')
    return NextResponse.json({error: 'Gmail backup is available to the workspace owner only.'}, {status: 403});
  const {state, nonce} = buildGmailMirrorState(workspaceId);
  const res = NextResponse.redirect(gmailMirrorAuthUrl(state));
  res.headers.set('Set-Cookie', gmailMirrorStateCookie(nonce));
  return res;
}
