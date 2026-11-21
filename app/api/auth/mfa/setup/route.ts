import {NextResponse} from 'next/server';
import {dbRun} from '@/lib/db';
import {requireUser} from '@/lib/guards';
import {generateTotpSecret, totpAuthUrl} from '@/lib/mfa';

export async function POST(req: Request) {
  const {user, response} = await requireUser(req);
  if (response) return response;
  if (!user) return NextResponse.json({error: 'Unauthorized'}, {status: 401});
  const secret = generateTotpSecret();
  // Defensive migration for databases created from an early schema revision
  // before pending_mfa_secret was added to db/schema.sql; harmless if the
  // column already exists.
  try {
    await dbRun('ALTER TABLE users ADD COLUMN pending_mfa_secret TEXT');
  } catch {
    // Column already exists.
  }
  await dbRun('UPDATE users SET pending_mfa_secret = ? WHERE id = ?', [secret, user.id]);
  return NextResponse.json({otpauth_url: totpAuthUrl(secret, user.email), secret});
}
