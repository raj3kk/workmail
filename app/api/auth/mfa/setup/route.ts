import {NextResponse} from 'next/server';
import {dbOne, dbRun, newId, nowIso} from '@/lib/db';
import {requireUser, isValidOrigin} from '@/lib/guards';
import {generateTotpSecret, totpAuthUrl, generateRecoveryCodes, hashRecoveryCode, encryptMfaSecret, RECOVERY_CODE_COUNT} from '@/lib/mfa';

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

// POST /api/auth/mfa/setup — two actions:
//   1. (default) Stage a fresh TOTP secret for enrolment. Returns the
//      otpauth URL + secret; the user completes enrolment by verifying a
//      code at /api/auth/mfa/verify, which is when recovery codes are
//      issued (shown once, see verify route).
//   2. {action: 'recovery_codes'} — regenerate recovery codes for an
//      already-enrolled user. Requires a fully MFA-verified session
//      (requireUser enforces it). Old unused codes are revoked; the new
//      codes are returned ONCE in this response — they are stored only as
//      SHA-256 hashes and can never be retrieved again. Never logged.
export async function POST(req: Request) {
  if (!isValidOrigin(req))
    return NextResponse.json({error: 'Invalid origin'}, {status: 403});
  const {user, response} = await requireUser(req);
  if (response) return response;
  if (!user) return NextResponse.json({error: 'Unauthorized'}, {status: 401});
  const body = await req.json().catch(() => null);
  if (body?.action === 'recovery_codes') {
    const row = await dbOne('SELECT mfa_secret FROM users WHERE id = ?', [user.id]);
    if (!row?.mfa_secret)
      return NextResponse.json({error: 'MFA is not enrolled yet. Enroll an authenticator first.'}, {status: 409});
    await ensureRecoveryCodesTable();
    const codes = generateRecoveryCodes();
    // Revoke all previous unused codes, then store only hashes of the new ones.
    await dbRun('DELETE FROM recovery_codes WHERE user_id = ? AND used_at IS NULL', [user.id]);
    for (const code of codes) {
      await dbRun('INSERT INTO recovery_codes (id, user_id, code_hash, created_at) VALUES (?, ?, ?, ?)', [
        newId(),
        user.id,
        hashRecoveryCode(code),
        nowIso(),
      ]);
    }
    return NextResponse.json({
      recovery_codes: codes,
      count: RECOVERY_CODE_COUNT,
      warning:
        'Store these recovery codes somewhere safe NOW. Each code works once. They are shown only in this response and cannot be retrieved again.',
    });
  }
  const secret = generateTotpSecret();
  // Defensive migration for databases created from an early schema revision
  // before pending_mfa_secret was added to db/schema.sql; harmless if the
  // column already exists.
  try {
    await dbRun('ALTER TABLE users ADD COLUMN pending_mfa_secret TEXT');
  } catch {
    // Column already exists.
  }
  // G-09: the staged secret is AES-256-GCM encrypted at rest
  // (lib/crypto.ts), never plaintext. If the host encryption key is
  // not configured, setup fails cleanly here instead of storing a
  // plaintext secret.
  let encrypted: string;
  try {
    encrypted = encryptMfaSecret(secret);
  } catch {
    return NextResponse.json({error: 'MFA setup is not available right now'}, {status: 503});
  }
  await dbRun('UPDATE users SET pending_mfa_secret = ? WHERE id = ?', [encrypted, user.id]);
  return NextResponse.json({otpauth_url: totpAuthUrl(secret, user.email), secret});
}
