// WorkMail outbound provider fallback engine.
//
// Chain order (fixed — do not reorder without a coordinator decision):
//   SendPulse -> Brevo -> Mailjet -> Resend
//
// Rules enforced here (see docs/FREE-PROVIDER-QUOTAS.md for the numbers):
//   1. Per-provider hourly/daily/monthly caps, counted from D1
//      (accepted sends recorded in `messages`; no new table is required,
//      so no schema change is needed. A dedicated counter table would
//      only be needed if counting accepted rows ever becomes too slow.)
//      A provider at (or over) any of its caps is skipped, never sent to.
//   2. A send timeout is outcome "unknown" — NEVER "failed". The caller
//      must mark the idempotency key `unknown` and must NOT blindly resend;
//      reconciliation happens via the delivery webhook or
//      POST /api/ops/reconcile, which flags `unknown` outbound jobs.
//   3. No blind resend: one idempotency key per message travels with the
//      send across every provider in the chain. A provider that definitely
//      rejected the send (an HTTP response was received) is followed by the
//      next provider with the SAME key; a provider whose outcome is unknown
//      stops the chain immediately.
//   4. Bounce/complaint suppression is checked before EVERY provider
//      attempt, not just once per message.
//   5. Credentials come from the workspace's encrypted-at-rest
//      `provider_secrets` rows (AES-256-GCM, lib/crypto.ts) first. If a
//      workspace has no stored secret for a provider, the host-level env
//      fallback is used (SENDPULSE_API_KEY / SENDPULSE_API_SECRET,
//      BREVO_API_KEY, MAILJET_API_KEY / MAILJET_API_SECRET,
//      RESEND_API_KEY). A provider with neither is skipped cleanly and
//      logged as `unconfigured` — it is never an error.
//   6. Every attempt is logged as one structured JSON line (provider,
//      result, latency, cap state). Secrets are never logged.
//
// NOTE: this module never touches the old database/object-storage stack.
// It reads/writes D1 only.
import {dbOne, dbRun, jstr, newId, nowIso} from '@/lib/db';

export type ProviderName = 'sendpulse' | 'brevo' | 'mailjet' | 'resend';

export const PROVIDER_CHAIN: ProviderName[] = ['sendpulse', 'brevo', 'mailjet', 'resend'];

/** Default priority written when a workspace connects a provider without one. */
export const PROVIDER_DEFAULT_PRIORITY: Record<ProviderName, number> = {
  sendpulse: 10,
  brevo: 20,
  mailjet: 30,
  resend: 40,
};

/**
 * Free-tier caps. `null` = no cap of that granularity.
 * Sources: docs/FREE-PROVIDER-QUOTAS.md (per-provider free tiers as
 * reported 2026-11-20/21). Caps are enforced conservatively: hitting a cap
 * exactly means "stop, do not send one more".
 */
export interface ProviderCaps {
  hourly: number | null;
  daily: number | null;
  monthly: number | null;
}
export const PROVIDER_CAPS: Record<ProviderName, ProviderCaps> = {
  // 12,000/month; the 50/hour ceiling is the binding constraint at burst.
  sendpulse: {hourly: 50, daily: null, monthly: 12000},
  // 300/day is the only published free-tier ceiling.
  brevo: {hourly: null, daily: 300, monthly: null},
  // 6,000/month and 200/day.
  mailjet: {hourly: null, daily: 200, monthly: 6000},
  // 3,000/month and 100/day.
  resend: {hourly: null, daily: 100, monthly: 3000},
};

/** Host-level env fallback credential names (values are never logged). */
export const PROVIDER_ENV_VARS: Record<ProviderName, {key: string; secret?: string}> = {
  sendpulse: {key: 'SENDPULSE_API_KEY', secret: 'SENDPULSE_API_SECRET'},
  brevo: {key: 'BREVO_API_KEY'},
  mailjet: {key: 'MAILJET_API_KEY', secret: 'MAILJET_API_SECRET'},
  resend: {key: 'RESEND_API_KEY'},
};

/** True when the host env fallback for this provider is present (names only). */
export function hasEnvCredentials(provider: ProviderName): boolean {
  const vars = PROVIDER_ENV_VARS[provider];
  const key = process.env[vars.key];
  if (!key) return false;
  if (vars.secret && !process.env[vars.secret]) return false;
  return true;
}

export interface ProviderSecret {
  api_key: string;
  api_secret?: string;
}

/**
 * Resolve a provider's credentials: workspace encrypted secret first,
 * host env fallback second. Returns null when the provider is unconfigured
 * (caller skips it cleanly). Never throws for a missing credential.
 */
export function resolveProviderSecret(
  provider: ProviderName,
  workspaceSecret: ProviderSecret | null,
): ProviderSecret | null {
  if (workspaceSecret?.api_key) return workspaceSecret;
  const vars = PROVIDER_ENV_VARS[provider];
  const key = process.env[vars.key];
  if (!key) return null;
  const secret = vars.secret ? process.env[vars.secret] : undefined;
  if (vars.secret && !secret) return null;
  return {api_key: key, api_secret: secret};
}

// ---------------------------------------------------------------------------
// Cap state (D1-backed, derived from accepted sends in `messages`)
// ---------------------------------------------------------------------------

export interface CapState {
  provider: ProviderName;
  hourly: {used: number; limit: number | null; remaining: number | null};
  daily: {used: number; limit: number | null; remaining: number | null};
  monthly: {used: number; limit: number | null; remaining: number | null};
  /** True when any applicable cap is reached (used >= limit). */
  exhausted: boolean;
  /** Which cap is exhausted, if any. */
  exhaustedBy: 'hourly' | 'daily' | 'monthly' | null;
}

function windowStarts(now: Date): {hour: string; day: string; month: string} {
  const hour = new Date(now);
  hour.setUTCMinutes(0, 0, 0);
  const day = new Date(now);
  day.setUTCHours(0, 0, 0, 0);
  const month = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  return {hour: hour.toISOString(), day: day.toISOString(), month: month.toISOString()};
}

async function countAccepted(
  workspaceId: string,
  provider: ProviderName,
  sinceIso: string,
): Promise<number> {
  // messages.created_at is ISO-8601 text, so a lexicographic >= works.
  // Only 'accepted' rows count: a provider only bills/counts quota for
  // sends it accepted. Rejected attempts and unknown outcomes do not
  // consume quota in our ledger; the provider's own counter is the
  // authority if the two ever disagree (reconcile then).
  const row = await dbOne(
    "SELECT COUNT(*) AS n FROM messages WHERE workspace_id = ? AND provider = ? AND folder = 'sent' AND delivery_state IN ('accepted','sent','delivered','opened','clicked','deferred') AND created_at >= ?",
    [workspaceId, provider, sinceIso],
  );
  return Number(row?.n || 0);
}

export async function getCapState(workspaceId: string, provider: ProviderName): Promise<CapState> {
  const caps = PROVIDER_CAPS[provider];
  const starts = windowStarts(new Date());
  const [hourUsed, dayUsed, monthUsed] = await Promise.all([
    caps.hourly !== null ? countAccepted(workspaceId, provider, starts.hour) : Promise.resolve(0),
    caps.daily !== null ? countAccepted(workspaceId, provider, starts.day) : Promise.resolve(0),
    caps.monthly !== null ? countAccepted(workspaceId, provider, starts.month) : Promise.resolve(0),
  ]);
  const rem = (used: number, limit: number | null): number | null =>
    limit === null ? null : Math.max(0, limit - used);
  const exhaustedBy: CapState['exhaustedBy'] =
    caps.hourly !== null && hourUsed >= caps.hourly
      ? 'hourly'
      : caps.daily !== null && dayUsed >= caps.daily
        ? 'daily'
        : caps.monthly !== null && monthUsed >= caps.monthly
          ? 'monthly'
          : null;
  return {
    provider,
    hourly: {used: hourUsed, limit: caps.hourly, remaining: rem(hourUsed, caps.hourly)},
    daily: {used: dayUsed, limit: caps.daily, remaining: rem(dayUsed, caps.daily)},
    monthly: {used: monthUsed, limit: caps.monthly, remaining: rem(monthUsed, caps.monthly)},
    exhausted: exhaustedBy !== null,
    exhaustedBy,
  };
}

// ---------------------------------------------------------------------------
// Suppression
// ---------------------------------------------------------------------------

export async function isSuppressed(
  workspaceId: string,
  email: string,
): Promise<{suppressed: boolean; reason?: string}> {
  const row = await dbOne('SELECT reason FROM suppressions WHERE workspace_id = ? AND email = ?', [
    workspaceId,
    email.toLowerCase(),
  ]);
  return row ? {suppressed: true, reason: String(row.reason)} : {suppressed: false};
}

// ---------------------------------------------------------------------------
// Structured logging (no secrets, ever)
// ---------------------------------------------------------------------------

export type AttemptResult =
  | 'accepted'
  | 'rejected'
  | 'unknown'
  | 'cap_exhausted'
  | 'unconfigured'
  | 'suppressed'
  | 'decrypt_error';

export interface AttemptLog {
  workspace_id: string;
  idempotency_key: string;
  provider: ProviderName;
  result: AttemptResult;
  latency_ms: number;
  cap: CapState | null;
  /** HTTP status when a response was received; null when none was. */
  http_status: number | null;
  /** Short, secret-free reason (error message with any credential material stripped). */
  reason?: string;
}

export function logAttempt(a: AttemptLog): void {
  // One JSON line per attempt; Vercel log drains can parse it. The
  // idempotency key is safe to log (it is a caller-supplied opaque UUID,
  // not a credential). No api keys, secrets, tokens or bodies are logged.
  console.log(JSON.stringify({event: 'provider_attempt', ...a}));
}

/** Best-effort durable copy of an attempt in delivery_events. Never throws. */
async function recordAttemptEvent(
  workspaceId: string,
  messageId: string | null,
  provider: ProviderName,
  idempotencyKey: string,
  result: AttemptResult,
  latencyMs: number,
  cap: CapState | null,
  reason?: string,
): Promise<void> {
  try {
    const eventType =
      result === 'accepted'
        ? 'accepted'
        : result === 'rejected'
          ? 'rejected'
          : 'unknown';
    await dbRun(
      `INSERT INTO delivery_events (id, workspace_id, message_id, provider, provider_event_id, event_type, recipient, details, occurred_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(provider, provider_event_id) DO NOTHING`,
      [
        newId(),
        workspaceId,
        messageId,
        provider,
        `attempt:${idempotencyKey}:${provider}`,
        eventType,
        '',
        jstr({result, latency_ms: latencyMs, cap, reason: reason || null, idempotency_key: idempotencyKey}),
        nowIso(),
        nowIso(),
      ],
    );
  } catch {
    // Logging must never fail a send.
  }
}

// ---------------------------------------------------------------------------
// Provider adapters
// ---------------------------------------------------------------------------

export const SEND_TIMEOUT_MS = 10000;

async function timedFetch(url: string, init: RequestInit): Promise<Response> {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), SEND_TIMEOUT_MS);
  try {
    return await fetch(url, {...init, signal: c.signal, cache: 'no-store'});
  } finally {
    clearTimeout(t);
  }
}

/** Error thrown when a provider call's outcome cannot be known. */
export class UnknownOutcomeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnknownOutcomeError';
  }
}

/**
 * Classify a thrown error. A timeout / aborted request / dropped socket
 * means the request may already have reached the provider — outcome
 * UNKNOWN, stop the chain, never blindly resend. A DNS failure means the
 * request never left the host — outcome is a definite rejection and the
 * chain may continue to the next provider.
 */
export function classifySendError(e: unknown): 'unknown' | 'rejected' {
  if (e instanceof UnknownOutcomeError) return 'unknown';
  const err = e as {name?: string; message?: string; code?: string; cause?: {code?: string}};
  const code = err?.code || err?.cause?.code || '';
  const msg = `${err?.name || ''} ${err?.message || ''}`.toLowerCase();
  // Never connected: safe to fail over.
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN' || msg.includes('getaddrinfo')) return 'rejected';
  if (
    err?.name === 'AbortError' ||
    err?.name === 'TimeoutError' ||
    msg.includes('abort') ||
    msg.includes('timeout') ||
    msg.includes('timed out') ||
    code === 'ETIMEDOUT' ||
    code === 'ECONNRESET' ||
    code === 'EPIPE' ||
    msg.includes('socket hang up') ||
    msg.includes('network')
  ) {
    return 'unknown';
  }
  return 'rejected';
}

export interface SendInput {
  from: string;
  fromName: string;
  to: string;
  subject: string;
  text?: string;
  html?: string;
  idempotencyKey: string;
}

async function sendViaProvider(
  provider: ProviderName,
  secret: ProviderSecret,
  d: SendInput,
): Promise<{providerMessageId: string | null; httpStatus: number}> {
  const key = secret.api_key;
  const sec = secret.api_secret || '';
  if (provider === 'sendpulse') {
    let tokenRes: Response;
    try {
      tokenRes = await timedFetch('https://api.sendpulse.com/oauth/access_token', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({grant_type: 'client_credentials', client_id: key, client_secret: sec}),
      });
    } catch (e) {
      if (classifySendError(e) === 'unknown')
        throw new UnknownOutcomeError('SendPulse token request timed out or connection dropped; outcome unknown');
      throw e;
    }
    if (!tokenRes.ok) throw new Error(`SendPulse auth HTTP ${tokenRes.status}`);
    const token = (await tokenRes.json()) as {access_token?: string};
    if (!token.access_token) throw new Error('SendPulse auth returned no access token');
    let r: Response;
    try {
      r = await timedFetch('https://api.sendpulse.com/smtp/emails', {
        method: 'POST',
        headers: {Authorization: `Bearer ${token.access_token}`, 'Content-Type': 'application/json'},
        body: JSON.stringify({
          email: {
            subject: d.subject,
            from: {name: d.fromName, email: d.from},
            to: [{email: d.to}],
            text: d.text,
            html: d.html,
          },
        }),
      });
    } catch (e) {
      if (classifySendError(e) === 'unknown')
        throw new UnknownOutcomeError('SendPulse send timed out or connection dropped; outcome unknown');
      throw e;
    }
    if (!r.ok) throw new Error(`SendPulse HTTP ${r.status}`);
    const body = (await r.json().catch(() => null)) as {id?: string; messageId?: string} | null;
    return {providerMessageId: body?.id || body?.messageId || null, httpStatus: r.status};
  }
  if (provider === 'brevo') {
    let r: Response;
    try {
      r = await timedFetch('https://api.brevo.com/v3/smtp/email', {
        method: 'POST',
        headers: {'api-key': key, 'Content-Type': 'application/json'},
        body: JSON.stringify({
          sender: {name: d.fromName, email: d.from},
          to: [{email: d.to}],
          subject: d.subject,
          textContent: d.text,
          htmlContent: d.html,
        }),
      });
    } catch (e) {
      if (classifySendError(e) === 'unknown')
        throw new UnknownOutcomeError('Brevo send timed out or connection dropped; outcome unknown');
      throw e;
    }
    if (!r.ok) throw new Error(`Brevo HTTP ${r.status}`);
    const body = (await r.json().catch(() => null)) as {messageId?: string} | null;
    return {providerMessageId: body?.messageId || null, httpStatus: r.status};
  }
  if (provider === 'mailjet') {
    const auth = Buffer.from(key + ':' + sec).toString('base64');
    let r: Response;
    try {
      r = await timedFetch('https://api.mailjet.com/v3.1/send', {
        method: 'POST',
        headers: {Authorization: 'Basic ' + auth, 'Content-Type': 'application/json'},
        body: JSON.stringify({
          Messages: [
            {
              From: {Email: d.from, Name: d.fromName},
              To: [{Email: d.to}],
              Subject: d.subject,
              TextPart: d.text,
              HTMLPart: d.html,
              CustomID: d.idempotencyKey,
            },
          ],
        }),
      });
    } catch (e) {
      if (classifySendError(e) === 'unknown')
        throw new UnknownOutcomeError('Mailjet send timed out or connection dropped; outcome unknown');
      throw e;
    }
    if (!r.ok) throw new Error(`Mailjet HTTP ${r.status}`);
    const body = (await r.json().catch(() => null)) as {
      Messages?: Array<{To?: Array<{MessageID?: number}>}>;
    } | null;
    const mid = body?.Messages?.[0]?.To?.[0]?.MessageID;
    return {providerMessageId: mid !== undefined ? String(mid) : null, httpStatus: r.status};
  }
  // resend
  let r: Response;
  try {
    r = await timedFetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + key,
        'Content-Type': 'application/json',
        'Idempotency-Key': d.idempotencyKey,
      },
      body: JSON.stringify({
        from: `${d.fromName} <${d.from}>`,
        to: [d.to],
        subject: d.subject,
        text: d.text,
        html: d.html,
      }),
    });
  } catch (e) {
    if (classifySendError(e) === 'unknown')
      throw new UnknownOutcomeError('Resend send timed out or connection dropped; outcome unknown');
    throw e;
  }
  if (!r.ok) throw new Error(`Resend HTTP ${r.status}`);
  const body = (await r.json().catch(() => null)) as {id?: string} | null;
  return {providerMessageId: body?.id || null, httpStatus: r.status};
}

// ---------------------------------------------------------------------------
// Fallback engine
// ---------------------------------------------------------------------------

export interface ConfiguredProvider {
  provider: ProviderName;
  /** Decrypted workspace secret, or null to use the host env fallback. */
  secret: ProviderSecret | null;
  senderVerified: boolean;
}

export interface FallbackAttempt {
  provider: ProviderName;
  result: AttemptResult;
  latency_ms: number;
  http_status: number | null;
  reason?: string;
  cap?: CapState | null;
}

export type FallbackOutcome =
  | {outcome: 'accepted'; provider: ProviderName; providerMessageId: string | null; attempts: FallbackAttempt[]}
  | {outcome: 'unknown'; provider: ProviderName; attempts: FallbackAttempt[]}
  | {outcome: 'suppressed'; reason: string; attempts: FallbackAttempt[]}
  | {outcome: 'failed'; attempts: FallbackAttempt[]};

/**
 * Try the chain in order with ONE idempotency key. Stops on the first
 * acceptance, on the first unknown outcome, or on suppression. Definite
 * rejections (and cap-exhausted / unconfigured providers) fall through to
 * the next provider. Never sends to a suppressed recipient, never exceeds
 * a cap, never resends after an unknown outcome.
 *
 * `configs` is the workspace's enabled, sender-verified provider rows in
 * chain order (the caller reads `provider_secrets` and decrypts them).
 * Providers absent from `configs` are still tried via the host env
 * fallback when one exists — the chain order is fixed regardless of
 * workspace priority values.
 */
export async function sendWithFallback(
  workspaceId: string,
  input: SendInput,
  configs: ConfiguredProvider[],
): Promise<FallbackOutcome> {
  const attempts: FallbackAttempt[] = [];
  const byName = new Map(configs.map((c) => [c.provider, c]));

  for (const provider of PROVIDER_CHAIN) {
    const configured = byName.get(provider);
    // Workspace rows that are not sender-verified are not eligible; the
    // env fallback is only used when the workspace has no row at all, so a
    // workspace that connected a provider but has not verified its sender
    // does not silently fall back to a host key.
    if (configured && !configured.senderVerified) {
      const attempt: FallbackAttempt = {
        provider,
        result: 'unconfigured',
        latency_ms: 0,
        http_status: null,
        reason: 'provider connected but sender not verified',
        cap: null,
      };
      attempts.push(attempt);
      logAttempt({
        workspace_id: workspaceId,
        idempotency_key: input.idempotencyKey,
        provider,
        result: 'unconfigured',
        latency_ms: 0,
        cap: null,
        http_status: null,
        reason: attempt.reason,
      });
      continue;
    }
    const secret = resolveProviderSecret(provider, configured ? configured.secret : null);
    if (!secret) {
      const attempt: FallbackAttempt = {
        provider,
        result: 'unconfigured',
        latency_ms: 0,
        http_status: null,
        reason: 'no workspace secret and no host env credentials',
        cap: null,
      };
      attempts.push(attempt);
      logAttempt({
        workspace_id: workspaceId,
        idempotency_key: input.idempotencyKey,
        provider,
        result: 'unconfigured',
        latency_ms: 0,
        cap: null,
        http_status: null,
        reason: attempt.reason,
      });
      await recordAttemptEvent(workspaceId, null, provider, input.idempotencyKey, 'unconfigured', 0, null, attempt.reason);
      continue;
    }

    // Suppression is re-checked before EVERY provider attempt.
    const suppression = await isSuppressed(workspaceId, input.to);
    if (suppression.suppressed) {
      const reason = suppression.reason || 'suppressed';
      const attempt: FallbackAttempt = {
        provider,
        result: 'suppressed',
        latency_ms: 0,
        http_status: null,
        reason,
        cap: null,
      };
      attempts.push(attempt);
      logAttempt({
        workspace_id: workspaceId,
        idempotency_key: input.idempotencyKey,
        provider,
        result: 'suppressed',
        latency_ms: 0,
        cap: null,
        http_status: null,
        reason,
      });
      return {outcome: 'suppressed', reason, attempts};
    }

    // Cap check before every attempt — never exceed a cap.
    const cap = await getCapState(workspaceId, provider);
    if (cap.exhausted) {
      const reason = `cap exhausted (${cap.exhaustedBy})`;
      const attempt: FallbackAttempt = {
        provider,
        result: 'cap_exhausted',
        latency_ms: 0,
        http_status: null,
        reason,
        cap,
      };
      attempts.push(attempt);
      logAttempt({
        workspace_id: workspaceId,
        idempotency_key: input.idempotencyKey,
        provider,
        result: 'cap_exhausted',
        latency_ms: 0,
        cap,
        http_status: null,
        reason,
      });
      await recordAttemptEvent(workspaceId, null, provider, input.idempotencyKey, 'cap_exhausted', 0, cap, reason);
      continue;
    }

    const started = Date.now();
    try {
      const result = await sendViaProvider(provider, secret, input);
      const latency = Date.now() - started;
      const attempt: FallbackAttempt = {
        provider,
        result: 'accepted',
        latency_ms: latency,
        http_status: result.httpStatus,
        cap,
      };
      attempts.push(attempt);
      logAttempt({
        workspace_id: workspaceId,
        idempotency_key: input.idempotencyKey,
        provider,
        result: 'accepted',
        latency_ms: latency,
        cap,
        http_status: result.httpStatus,
      });
      await recordAttemptEvent(workspaceId, null, provider, input.idempotencyKey, 'accepted', latency, cap);
      return {outcome: 'accepted', provider, providerMessageId: result.providerMessageId, attempts};
    } catch (e) {
      const latency = Date.now() - started;
      const kind = classifySendError(e);
      const reason = e instanceof Error ? e.message.slice(0, 200) : 'Provider error';
      if (kind === 'unknown') {
        // TIMEOUT / DROPPED CONNECTION: outcome unknown. Stop the chain
        // NOW. Do not try the next provider, do not mark failed, do not
        // resend. The caller marks the idempotency key `unknown` and the
        // delivery webhook / /api/ops/reconcile resolves it later.
        const attempt: FallbackAttempt = {
          provider,
          result: 'unknown',
          latency_ms: latency,
          http_status: null,
          reason,
          cap,
        };
        attempts.push(attempt);
        logAttempt({
          workspace_id: workspaceId,
          idempotency_key: input.idempotencyKey,
          provider,
          result: 'unknown',
          latency_ms: latency,
          cap,
          http_status: null,
          reason,
        });
        await recordAttemptEvent(workspaceId, null, provider, input.idempotencyKey, 'unknown', latency, cap, reason);
        return {outcome: 'unknown', provider, attempts};
      }
      const httpStatus =
        /HTTP (\d{3})/.exec(reason)?.[1] !== undefined
          ? Number(/HTTP (\d{3})/.exec(reason)![1])
          : null;
      const attempt: FallbackAttempt = {
        provider,
        result: 'rejected',
        latency_ms: latency,
        http_status: httpStatus,
        reason,
        cap,
      };
      attempts.push(attempt);
      logAttempt({
        workspace_id: workspaceId,
        idempotency_key: input.idempotencyKey,
        provider,
        result: 'rejected',
        latency_ms: latency,
        cap,
        http_status: httpStatus,
        reason,
      });
      await recordAttemptEvent(workspaceId, null, provider, input.idempotencyKey, 'rejected', latency, cap, reason);
      // Definite rejection (provider answered): fall through to next provider.
    }
  }
  return {outcome: 'failed', attempts};
}
