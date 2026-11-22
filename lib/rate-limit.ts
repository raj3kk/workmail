// D1-backed rate limiting (lib/rate-limit.ts).
//
// Decision D7: the limiter is D1-backed, not KV-backed (KV writes cap
// at 1,000/day — a limiter that writes per request could exhaust it
// under attack) and not in-memory-only (per-instance counters are
// approximate on serverless). One row per (scope, subject, window) in
// `api_key_rate_limits` (migration 0002); ~1 D1 write per request.
//
// Phase 2 defines this interface and uses it for the v1 API routes.
// Phase 3a extends it to other scopes (auth, mfa, send, write) —
// extend `RateLimitScope` and add call sites; do not change the
// `checkRateLimit` signature or the table shape without updating the
// v1 callers. If the D1 write/read fails, the limiter FAILS OPEN
// (allows the request): a limiter outage must never take down sending
// or reading for legitimate keys. The failure is logged, never thrown.
import {dbOne, dbRun} from '@/lib/db';

export type RateLimitScope = 'v1_send' | 'v1_messages' | 'api_keys_manage' | 'ai_draft';

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
