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

export function newSessionToken(): string {
  return randomBytes(32).toString('base64url');
}

export {timingSafeEqual, createHash};
