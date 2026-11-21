import {NextResponse} from 'next/server';
import {timingSafeEqual} from 'node:crypto';
import {dbOne, dbQuery, dbRun, newId, nowIso} from '@/lib/db';
import {getSessionUser, markSessionMfaVerified} from '@/lib/auth';
import {
  totpVerify,
  generateRecoveryCodes,
  hashRecoveryCode,
  looksLikeRecoveryCode,
  RECOVERY_CODE_COUNT,
} from '@/lib/mfa';

export const runtime = 'nodejs';

// Defensive migration for databases created from a schema revision before
// the recovery_codes table existed; harmless if the table already exists.
async function ensureRecoveryCodesTable(): Promise<void> {
  await dbRun(
    `CREATE TABLE IF NOT EXISTS recovery_codes (
       id TEXT PRIMARY KEY,
       user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
       code_hash TEXT NOT NULL,
       used_at TEXT,
       created_at TEXT NOT NULL DEFAULT (datetime('now')),
       UNIQUE (user_id, code_hash)
     )`,
  );
  await dbRun('CREATE INDEX IF NOT EXISTS recovery_codes_user_idx ON recovery_codes(user_id, used_at)');
}

/** Issue a fresh set of recovery codes (hashed at rest) and return the
 *  plain codes ONCE. Callers must return them to the user immediately and
 *  never log or store them. */
async function issueRecoveryCodes(userId: string): Promise<string[]> {
  await ensureRecoveryCodesTable();
  const codes = generateRecoveryCodes();
  await dbRun('DELETE FROM recovery_codes WHERE user_id = ? AND used_at IS NULL', [userId]);
  for (const code of codes) {
    await dbRun('INSERT INTO recovery_codes (id, user_id, code_hash, created_at) VALUES (?, ?, ?, ?)', [
      newId(),
      userId,
      hashRecoveryCode(code),
      nowIso(),
    ]);
  }
  return codes;
}

/** Try to burn a recovery code. Returns the number of unused codes left,
 *  or null when the value is not a valid unused recovery code. */
async function burnRecoveryCode(userId: string, code: string): Promise<number | null> {
  if (!looksLikeRecoveryCode(code)) return null;
  await ensureRecoveryCodesTable();
  const hash = hashRecoveryCode(code);
  const rows = await dbQuery('SELECT id, code_hash FROM recovery_codes WHERE user_id = ? AND used_at IS NULL', [userId]);
  for (const row of rows) {
    const a = Buffer.from(String(row.code_hash));
    const b = Buffer.from(hash);
    if (a.length === b.length && timingSafeEqual(a, b)) {
      const burned = await dbRun(
        'UPDATE recovery_codes SET used_at = ? WHERE id = ? AND used_at IS NULL',
        [nowIso(), row.id],
      );
      if (burned.changes === 0) return null; // raced with another use
      const remaining = await dbOne('SELECT COUNT(*) AS n FROM recovery_codes WHERE user_id = ? AND used_at IS NULL', [
        userId,
      ]);
      return Number(remaining?.n || 0);
    }
  }
  return null;
}

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
    // G-28: enrolment completes here — issue the one-time recovery codes.
    const recoveryCodes = await issueRecoveryCodes(user.id);
    return NextResponse.json({
      success: true,
      enrolled: true,
      recovery_codes: recoveryCodes,
      recovery_codes_warning:
        'Store these recovery codes somewhere safe NOW. Each code works once, as a replacement for your authenticator. They are shown only in this response and cannot be retrieved again.',
    });
  }
  const enrolled = row.mfa_secret ? String(row.mfa_secret) : null;
  if (enrolled && totpVerify(enrolled, code)) {
    await markSessionMfaVerified(String(session.id));
    return NextResponse.json({success: true, enrolled: false});
  }
  // G-28: recovery-code login. A valid unused code burns itself and
  // verifies the session exactly like a TOTP code. The code value is
  // never logged; only its hash is compared.
  if (enrolled) {
    const remaining = await burnRecoveryCode(user.id, code);
    if (remaining !== null) {
      await markSessionMfaVerified(String(session.id));
      return NextResponse.json({
        success: true,
        enrolled: false,
        recovery_code_used: true,
        recovery_codes_remaining: remaining,
        recovery_codes_warning:
          remaining === 0
            ? 'You have used your last recovery code. Regenerate a new set from Settings while you still have authenticator access.'
            : undefined,
      });
    }
  }
  return NextResponse.json({error: 'Invalid verification code'}, {status: 400});
}
