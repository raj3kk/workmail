import {NextResponse} from 'next/server';
import {requireUser, isValidOrigin} from '@/lib/guards';
import {revokeAllSessions} from '@/lib/auth';
import {withRateLimit, RATE_LIMIT_DEFAULTS} from '@/lib/rate-limit';

export const runtime = 'nodejs';

// POST /api/auth/sessions/revoke-all — destroy every session of the
// calling user EXCEPT the current one (G-10). Used after a suspected
// session theft, or to sign out of all other devices. The current
// session is identified by the session row requireUser() resolved, so
// the caller stays signed in on this device. Returns the number of
// sessions destroyed.
export async function POST(req: Request) {
  if (!isValidOrigin(req))
    return NextResponse.json({error: 'Invalid origin'}, {status: 403});
  const {user, session, response} = await requireUser(req);
  if (response) return response;
  if (!user || !session) return NextResponse.json({error: 'Unauthorized'}, {status: 401});
  const limited = await withRateLimit({
    scope: 'write',
    subject: user.id,
    limit: RATE_LIMIT_DEFAULTS.write.limit,
    windowSeconds: RATE_LIMIT_DEFAULTS.write.windowSeconds,
  });
  if (limited) return limited;
  const revoked = await revokeAllSessions(user.id, String(session.id));
  return NextResponse.json({revoked, current_session_kept: true});
}
