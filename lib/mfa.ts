import {randomBytes, createHash, createHmac, timingSafeEqual} from 'node:crypto';

// TOTP (RFC 6238, SHA-1, 30s step, ±1 window) — no dependency, no paid service.
// Secrets are base32; the otpauth:// URL is shown to the user, who scans it
// with any authenticator app (Google/Microsoft Authenticator, Authy, ...).
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function generateTotpSecret(bytes = 20): string {
  const buf = randomBytes(bytes);
  let bits = 0, value = 0, out = '';
  for (const b of buf) {
    value = (value << 8) | b; bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(s: string): Buffer {
  const clean = s.replace(/=+$/g, '').toUpperCase();
  let bits = 0, value = 0; const bytes: number[] = [];
  for (const ch of clean) {
    const idx = B32.indexOf(ch);
    if (idx < 0) throw new Error('Invalid base32 secret');
    value = (value << 5) | idx; bits += 5;
    if (bits >= 8) { bytes.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(bytes);
}

function hotp(secret: string, counter: number): string {
  const key = base32Decode(secret);
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const hmac = createHmac('sha1', key).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0xf;
  const code = ((hmac[offset] & 0x7f) << 24) | ((hmac[offset + 1] & 0xff) << 16) | ((hmac[offset + 2] & 0xff) << 8) | (hmac[offset + 3] & 0xff);
  return String(code % 1_000_000).padStart(6, '0');
}

export function totpVerify(secret: string, code: string, window = 1): boolean {
  const clean = String(code).replace(/\s/g, '');
  if (!/^\d{6}$/.test(clean)) return false;
  const step = Math.floor(Date.now() / 30000);
  for (let i = -window; i <= window; i++) {
    const expected = hotp(secret, step + i);
    const a = Buffer.from(expected), b = Buffer.from(clean);
    if (a.length === b.length && timingSafeEqual(a, b)) return true;
  }
  return false;
}

export function totpAuthUrl(secret: string, email: string, issuer = 'WorkMail'): string {
  return `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(email)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

// --- MFA recovery codes (G-28) ---------------------------------------------
// Single-use codes, shown once at enrolment (or on explicit regeneration),
// stored ONLY as SHA-256 hashes. Plain codes are never logged, never
// persisted, and never returned again after the one response that creates
// them. Format: 3 groups of 4 unambiguous characters (no 0/O, 1/I/L),
// e.g. "7KQ2-9XFM-4D8Z". Verification strips separators and case.
export const RECOVERY_CODE_COUNT = 10;
const RECOVERY_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

export function generateRecoveryCodes(count: number = RECOVERY_CODE_COUNT): string[] {
  const codes: string[] = [];
  for (let i = 0; i < count; i++) {
    const bytes = randomBytes(12);
    let raw = '';
    for (const b of bytes) raw += RECOVERY_ALPHABET[b % RECOVERY_ALPHABET.length];
    codes.push(`${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8, 12)}`);
  }
  return codes;
}

/** Canonical form for hashing/comparison: separators and case removed. */
export function normalizeRecoveryCode(code: string): string {
  return String(code || '').replace(/[^A-Za-z0-9]/g, '').toUpperCase();
}

/** SHA-256 of the canonical form — the only representation ever stored. */
export function hashRecoveryCode(code: string): string {
  return createHash('sha256').update(normalizeRecoveryCode(code)).digest('hex');
}

/** True when the value looks like a recovery code (12 alphanumerics). */
export function looksLikeRecoveryCode(code: string): boolean {
  return /^[A-Za-z0-9]{12}$/.test(normalizeRecoveryCode(code));
}

export function newSessionToken(): string {
  return randomBytes(32).toString('base64url');
}

export {timingSafeEqual, createHash};

// --- MFA secrets at rest (G-09) --------------------------------------------
// `users.mfa_secret` and `users.pending_mfa_secret` are encrypted with
// the same AES-256-GCM envelope as provider credentials
// (lib/crypto.ts, key PROVIDER_CREDENTIAL_ENCRYPTION_KEY) — never
// plaintext in D1. The enrolled secret was plaintext before this
// change, so reads tolerate legacy rows: decryptMfaSecret returns a
// legacy plaintext value as-is, and callers re-encrypt it on the next
// successful verification (migrate-on-use; see
// app/api/auth/mfa/verify/route.ts). A stored value is recognisably
// encrypted when it has the three-part iv.tag.data shape; base32
// secrets never contain '.', so the test cannot misfire.
import {decryptSecret, encryptSecret} from '@/lib/crypto';

export function encryptMfaSecret(secret: string): string {
  return encryptSecret(secret);
}

export function isEncryptedMfaSecret(stored: string): boolean {
  return stored.split('.').length === 3;
}

export function decryptMfaSecret(stored: string | null): string | null {
  if (!stored) return null;
  if (!isEncryptedMfaSecret(stored)) return stored; // legacy plaintext row
  try {
    return decryptSecret(stored);
  } catch {
    // Corrupt ciphertext: treat as unusable, never crash the caller.
    return null;
  }
}
