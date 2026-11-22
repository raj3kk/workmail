// D1-backed rate limiting (lib/rate-limit.ts).
//
// Decision D7: the limiter is D1-backed, not KV-backed (KV writes cap
// at 1,000/day — a limiter that writes per request could exhaust it
// under attack) and not in-memory-only (per-instance counters are
// approximate on serverless). One row per (scope, subject, window) in
// `api_key_rate_limits` (migration 0002); ~1 D1 write per request.
//
// Phase 2 defines this interface and uses it for the v1 API routes
// (scopes v1_send / v1_messages / api_keys_manage / ai_draft —
// PRESERVED, do not rename). Phase 3a extends it with the scopes
// auth / mfa / send / v1 / write, a shared `withRateLimit` wrapper for
// mutating routes, and failure-count helpers for the MFA lockout
// (G-03/G-04). If the D1 write/read fails, the limiter FAILS OPEN
// (allows the request): a limiter outage must never take down sending
// or reading for legitimate keys. The failure is logged, never thrown.
import {dbOne, dbRun} from '@/lib/db';

export type RateLimitScope =
  | 'v1_send'
  | 'v1_messages'
  | 'api_keys_manage'
  | 'ai_draft'
  | 'auth'
  | 'mfa'
  | 'send'
  | 'v1'
  | 'write';

export interface RateLimitOptions {
  scope: RateLimitScope;
  /** Per-key subject for v1 routes (the api_keys row id); per-user or per-IP for other scopes. */
  subject: string;
  /** Max requests in the window. */
  limit: number;
  /** Window length in seconds. */
  windowSeconds: number;
}

export interface RateLimitResult {
  allowed: boolean;
  /** Requests remaining in the current window (0 when blocked). */
  remaining: number;
  /** Seconds until the window resets (0 when allowed and window is fresh). */
  retryAfterSeconds: number;
  limit: number;
}

/** Per-scope defaults for the v1 API. Agents polling for replies stay
 *  well under these; a burst above them gets a 429 with Retry-After. */
export const V1_RATE_LIMITS: Record<'v1_send' | 'v1_messages', {limit: number; windowSeconds: number}> = {
  v1_send: {limit: 30, windowSeconds: 60},
  v1_messages: {limit: 120, windowSeconds: 60},
};

/** Per-scope defaults for the Phase 3a scopes (G-03). */
export const RATE_LIMIT_DEFAULTS: Record<'auth' | 'mfa' | 'send' | 'v1' | 'write', {limit: number; windowSeconds: number}> = {
  // Login callback / OAuth entry points, per client IP.
  auth: {limit: 30, windowSeconds: 60},
  // MFA verify, per user (coarse cap; the 5-failures/15-min lockout in
  // recordFailure is the real brute-force control).
  mfa: {limit: 10, windowSeconds: 60},
  // Session send path, per user.
  send: {limit: 30, windowSeconds: 60},
  // Generic v1 fallback (the v1 routes keep their own v1_send /
  // v1_messages scopes; this is for future v1 routes).
  v1: {limit: 120, windowSeconds: 60},
  // Mutating session routes, per user.
  write: {limit: 60, windowSeconds: 60},
};

export async function checkRateLimit(opts: RateLimitOptions): Promise<RateLimitResult> {
  const {scope, subject, limit, windowSeconds} = opts;
  const nowSec = Math.floor(Date.now() / 1000);
  const windowStart = Math.floor(nowSec / windowSeconds) * windowSeconds;
  const resetIn = windowStart + windowSeconds - nowSec;
  try {
    await dbRun(
      `INSERT INTO api_key_rate_limits (scope, subject_key, window_start, count) VALUES (?, ?, ?, 1)
       ON CONFLICT(scope, subject_key, window_start) DO UPDATE SET count = api_key_rate_limits.count + 1`,
      [scope, subject, windowStart],
    );
    const row = await dbOne(
      'SELECT count FROM api_key_rate_limits WHERE scope = ? AND subject_key = ? AND window_start = ?',
      [scope, subject, windowStart],
    );
    const count = Number(row?.count || 1);
    if (count > limit)
      return {allowed: false, remaining: 0, retryAfterSeconds: Math.max(resetIn, 1), limit};
    return {allowed: true, remaining: Math.max(limit - count, 0), retryAfterSeconds: 0, limit};
  } catch (e) {
    // Fail open (see module header): log and allow.
    console.log(
      JSON.stringify({
        event: 'rate_limit_error',
        scope,
        error: e instanceof Error ? e.message : 'unknown error',
      }),
    );
    return {allowed: true, remaining: limit, retryAfterSeconds: 0, limit};
  }
}

/** 429 response helper: same shape on every v1 route. */
export function rateLimitResponse(result: RateLimitResult): Response {
  return new Response(JSON.stringify({error: 'Too many requests. Try again shortly.'}), {
    status: 429,
    headers: {'Content-Type': 'application/json', 'Retry-After': String(result.retryAfterSeconds)},
  });
}

/**
 * Shared wrapper (G-03) for mutating routes: returns a 429 Response
 * when the caller is over the limit, or null when the request may
 * proceed. Usage at the top of a route handler:
 *
 *   const limited = await withRateLimit({scope: 'write', subject: user.id, ...RATE_LIMIT_DEFAULTS.write});
 *   if (limited) return limited;
 */
export async function withRateLimit(opts: RateLimitOptions): Promise<Response | null> {
  const result = await checkRateLimit(opts);
  if (!result.allowed) return rateLimitResponse(result);
  return null;
}

/** Client IP for per-IP scopes (auth, edge-adjacent callers). */
export function clientIp(req: Request): string {
  const fwd = req.headers.get('x-forwarded-for');
  return (fwd ? fwd.split(',')[0].trim() : '') || 'unknown';
}

// --- Failure counting for lockouts (G-04, MFA) ---------------------------
// Unlike checkRateLimit (which counts every attempt), these count ONLY
// failures, in the same table and the same fixed windows. The MFA
// verify route records a failure after each bad code, checks the count
// BEFORE verifying (5 failures in 15 minutes -> locked out), and
// clears the count on success. A D1 error fails open here as well:
// the count helpers return 0 / swallow, so a limiter outage never
// locks a legitimate user out — and never lets a brute-force run
// silently either (the per-minute 'mfa' cap + edge throttle still apply).
function windowStartFor(windowSeconds: number): number {
  const nowSec = Math.floor(Date.now() / 1000);
  return Math.floor(nowSec / windowSeconds) * windowSeconds;
}

/** Count failures for (scope, subject) in the current window. */
export async function failureCount(
  scope: RateLimitScope,
  subject: string,
  windowSeconds: number,
): Promise<number> {
  try {
    const row = await dbOne(
      'SELECT count FROM api_key_rate_limits WHERE scope = ? AND subject_key = ? AND window_start = ?',
      [scope, subject, windowStartFor(windowSeconds)],
    );
    return Number(row?.count || 0);
  } catch {
    return 0;
  }
}

/** Record one failure; returns the new count in the current window. */
export async function recordFailure(
  scope: RateLimitScope,
  subject: string,
  windowSeconds: number,
): Promise<number> {
  try {
    await dbRun(
      `INSERT INTO api_key_rate_limits (scope, subject_key, window_start, count) VALUES (?, ?, ?, 1)
       ON CONFLICT(scope, subject_key, window_start) DO UPDATE SET count = api_key_rate_limits.count + 1`,
      [scope, subject, windowStartFor(windowSeconds)],
    );
    return failureCount(scope, subject, windowSeconds);
  } catch {
    return 0;
  }
}

/** Clear all failure rows for (scope, subject) — called on success. */
export async function clearFailures(scope: RateLimitScope, subject: string): Promise<void> {
  try {
    await dbRun('DELETE FROM api_key_rate_limits WHERE scope = ? AND subject_key = ?', [scope, subject]);
  } catch {
    // Best-effort: a stale counter expires with its window anyway.
  }
}
