import {NextResponse, type NextRequest} from 'next/server';

// Best-effort, per-instance (in-memory) rate limiting for abuse-prone routes.
// This is NOT a substitute for a distributed limiter or a WAF on a
// multi-instance deployment: each serverless instance keeps its own
// counters, so limits are approximate under load. See docs/SECURITY.md.
// The D1-backed limiter (lib/rate-limit.ts) is the second line, applied
// inside handlers. Auth, suspension and MFA are enforced per-route by
// lib/guards.ts requireUser() (session cookies + D1) — middleware does
// not authenticate.
const WINDOW_MS = 60_000;
const LIMITS: Array<{match: (p: string) => boolean; limit: number}> = [
  {match: (p) => p === '/api/send', limit: 20},
  {match: (p) => p.startsWith('/api/inbound'), limit: 60},
  {match: (p) => p.startsWith('/api/delivery/webhook'), limit: 120},
  {match: (p) => p.startsWith('/api/ops/'), limit: 30},
  {match: (p) => p.startsWith('/auth/callback'), limit: 30},
  // G-04 first line: MFA verify gets a coarse per-IP cap here; the
  // per-user 5-failures/15-min lockout lives in the route itself.
  {match: (p) => p === '/api/auth/mfa/verify', limit: 10},
];
const buckets = new Map<string, {count: number; reset: number}>();
function rateLimited(ip: string, path: string): boolean {
  const rule = LIMITS.find((r) => r.match(path));
  if (!rule) return false;
  const now = Date.now();
  const key = ip + ':' + path.split('/').slice(0, 3).join('/');
  const b = buckets.get(key);
  if (!b || now > b.reset) {
    buckets.set(key, {count: 1, reset: now + WINDOW_MS});
    return false;
  }
  b.count += 1;
  if (b.count > rule.limit) return true;
  return false;
}
function clientIp(req: NextRequest): string {
  const fwd = req.headers.get('x-forwarded-for');
  return (fwd ? fwd.split(',')[0].trim() : '') || 'unknown';
}

export function middleware(req: NextRequest){
  const path = req.nextUrl.pathname;
  if (req.method === 'POST' && rateLimited(clientIp(req), path)) {
    return NextResponse.json({error: 'Too many requests. Try again shortly.'}, {status: 429});
  }
  return NextResponse.next();
}
export const config = {matcher: ['/api/:path*', '/auth/:path*']};

// NOTE (G-17, decision D13): a nonce-based CSP was ATTEMPTED here and
// REVERTED — see docs/SECURITY.md "Content-Security-Policy" for the
// evidence. In short: this app's pages are statically prerendered at
// build time, so a per-request nonce can never be stamped onto their
// inline scripts, and a nonce policy would block the RSC payload and
// kill hydration. The CSP therefore stays static in next.config.mjs
// with script-src 'unsafe-inline'. Do not re-add a nonce here without
// first making the pages render per-request.
