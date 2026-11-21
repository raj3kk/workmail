import {NextResponse} from 'next/server';
import {dbOne, dbRun} from '@/lib/db';
import {getSessionUser, markSessionMfaVerified} from '@/lib/auth';
import {totpVerify} from '@/lib/mfa';

export async function POST(req: Request) {
  // Deliberately NOT requireUser() here: requireUser() returns 403
  // MFA_REQUIRED whenever an enrolled secret exists and the session is not
  // yet MFA-verified — which is exactly the state this endpoint must clear.
  // We still enforce a valid, non-suspended session via getSessionUser().
  const {user, session} = await getSessionUser(req);
  if (!user || !session) return NextResponse.json({error: 'Unauthorized'}, {status: 401});
  if (user.suspended_at) return NextResponse.json({error: 'Account suspended'}, {status: 403});
  const b = await req.json().catch(() => null);
  const code = String(b?.code || '');
  if (!code) return NextResponse.json({error: 'code required'}, {status: 400});
  const row = await dbOne('SELECT mfa_secret, pending_mfa_secret FROM users WHERE id = ?', [user.id]);
  if (!row) return NextResponse.json({error: 'User not found'}, {status: 404});
  const pending = row.pending_mfa_secret ? String(row.pending_mfa_secret) : null;
  if (pending && totpVerify(pending, code)) {
    await dbRun('UPDATE users SET mfa_secret = ?, pending_mfa_secret = NULL WHERE id = ?', [pending, user.id]);
    await markSessionMfaVerified(String(session.id));
    return NextResponse.json({success: true, enrolled: true});
  }
  const enrolled = row.mfa_secret ? String(row.mfa_secret) : null;
  if (enrolled && totpVerify(enrolled, code)) {
    await markSessionMfaVerified(String(session.id));
    return NextResponse.json({success: true, enrolled: false});
  }
  return NextResponse.json({error: 'Invalid verification code'}, {status: 400});
}
