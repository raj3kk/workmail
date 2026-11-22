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
//      fallback is used ONLY when workspace_settings.allow_host_provider_fallback
//      is 1 (G-14; the live owner workspace keeps 1, new workspaces default
//      to 0). A provider with neither is skipped cleanly and
//      logged as `unconfigured` — it is never an error.
//   6. Every attempt is logged as one structured JSON line (provider,
//      result, latency, cap state). Secrets are never logged.
//   7. Attachments (see "Attachments" below) travel with the send:
//      every provider in the chain receives the same resolved files in
//      its own encoding. Attachment bytes / base64 are NEVER logged and
//      NEVER appear in error responses — only filename + size.
//
// NOTE: this module never touches the old database/object-storage stack.
// It reads/writes D1 only. Attachments are stored in Cloudflare KV
// (lib/kv.ts, key `att/<workspace>/<mailbox>/<uuid>-<safeName>`); the
// card-gated object-storage service is NOT used.
import {dbOne, dbRun, jstr, newId, nowIso} from '@/lib/db';

export type ProviderName = 'sendpulse' | 'brevo' | 'mailjet' | 'resend';

export const PROVIDER_CHAIN: ProviderName[] = ['sendpulse', 'brevo', 'mailjet', 'resend'];

/**
 * True only for the four exact provider strings. Route/service agents
 * use this to validate a manual-pick `provider` input before calling
 * sendWithFallback — anything else is not a provider and must be
 * rejected, never attempted.
 */
export function isKnownProvider(v: unknown): v is ProviderName {
  return v === 'sendpulse' || v === 'brevo' || v === 'mailjet' || v === 'resend';
}

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
  // 12,000/month and 400/day (published free plan); the 50/hour ceiling
  // is the binding constraint at burst.
  sendpulse: {hourly: 50, daily: 400, monthly: 12000},
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
 * host env fallback second (only when `allowHostFallback` is true — the
 * per-workspace gate in workspace_settings.allow_host_provider_fallback,
 * G-14; default false for new workspaces). Returns null when the provider
 * is unconfigured (caller skips it cleanly). Never throws for a missing
 * credential.
 */
export function resolveProviderSecret(
  provider: ProviderName,
  workspaceSecret: ProviderSecret | null,
  allowHostFallback = true,
): ProviderSecret | null {
  if (workspaceSecret?.api_key) return workspaceSecret;
  if (!allowHostFallback) return null;
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

/** Best-effort durable copy of an attempt in delivery_events. Never throws.
 * `recipient` is the To address (input.to) — the dashboard's Recent events
 * table shows it; before this fix it was stored as '' so every row showed
 * "—". The message row does not exist yet at attempt time, so messageId
 * stays null here (as before). */
async function recordAttemptEvent(
  workspaceId: string,
  messageId: string | null,
  recipient: string,
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
          : result === 'unconfigured'
            ? 'unconfigured'
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
        recipient,
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
// Attachments
// ---------------------------------------------------------------------------

/** Max total attachment bytes in one message (sum of all files). Enforced
 *  at resolve time in lib/service-send.ts; larger sends are rejected 413
 *  before any provider is called. Documented in
 *  docs/FREE-PROVIDER-QUOTAS.md ("Attachments"). */
export const MAX_TOTAL_ATTACHMENT_BYTES = 10 * 1024 * 1024;
/** Max files attached to one message. */
export const MAX_ATTACHMENT_COUNT = 10;
/** Max bytes for a single file. Matches the KV 25 MB value cap enforced
 *  at upload (POST /api/attachments); re-checked defensively at resolve. */
export const MAX_ATTACHMENT_FILE_BYTES = 25 * 1024 * 1024;

/**
 * One resolved attachment, ready to encode into a provider payload.
 * `base64` is computed exactly once, at resolve time; the raw bytes are
 * never logged and never appear in an error response — only `filename`
 * and `sizeBytes` are safe to log. `objectKey` is the KV key the bytes
 * were read from (needed to record the sent-message attachment rows).
 */
export interface SendAttachment {
  filename: string;
  contentType: string;
  sizeBytes: number;
  base64: string;
  objectKey: string;
}

/**
 * Pure per-provider attachment encodings (exported so they can be
 * unit-checked without any network call). Each takes already-resolved
 * attachments and returns exactly the fragment that provider's send
 * endpoint expects. Callers omit the fragment entirely when the list
 * is empty, so no-attachment sends keep their previous payload shape.
 *
 *   Resend    `attachments: [{filename, content (base64), content_type}]`
 *   Mailjet   `Attachments: [{ContentType, Filename, Base64Content}]`
 *             inside Messages[0]
 *   Brevo     `attachment: [{name, content (base64)}]`
 *   SendPulse `attachments_binary: {<filename>: <base64>}` inside the
 *             `email` object of POST /smtp/emails. (SendPulse's plain
 *             `attachments` field takes URLs, NOT file bytes — binary
 *             content must go in `attachments_binary`, or the file is
 *             silently dropped.) All four providers carry attachments,
 *             so no provider is skipped for messages with attachments.
 */
export function buildResendAttachments(atts: SendAttachment[]): Array<{
  filename: string;
  content: string;
  content_type: string;
}> {
  return atts.map((a) => ({filename: a.filename, content: a.base64, content_type: a.contentType}));
}

export function buildMailjetAttachments(atts: SendAttachment[]): Array<{
  ContentType: string;
  Filename: string;
  Base64Content: string;
}> {
  return atts.map((a) => ({ContentType: a.contentType, Filename: a.filename, Base64Content: a.base64}));
}

export function buildBrevoAttachments(atts: SendAttachment[]): Array<{name: string; content: string}> {
  return atts.map((a) => ({name: a.filename, content: a.base64}));
}

export function buildSendpulseAttachmentsBinary(atts: SendAttachment[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const a of atts) out[a.filename] = a.base64;
  return out;
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
  /** Resolved attachments (see "Attachments" above). The SAME list is
   *  passed to every provider attempt in the chain, so failover never
   *  drops a file; the per-provider encoding is applied in
   *  sendViaProvider. Empty/undefined = no attachments. */
  attachments?: SendAttachment[];
  /** Extra mail headers for this send (e.g. List-Unsubscribe). Passed
   *  verbatim to each provider's headers field. */
  headers?: Record<string, string>;
}

/** Read a bounded, whitespace-collapsed slice of a failed provider response.
 *  Provider validation messages (e.g. SendPulse's 422 "sender not verified")
 *  live ONLY in the body — without this, D1 records a bare status code and the
 *  real reason is unrecoverable. Never throws; returns '' when unreadable. */
async function providerErrorDetail(r: Response): Promise<string> {
  try {
    const t = (await r.text()).replace(/\s+/g, ' ').trim().slice(0, 500);
    return t ? `: ${t}` : '';
  } catch {
    return '';
  }
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
            ...(d.headers ? {headers: d.headers} : {}),
            // Binary attachments go in `attachments_binary` (filename ->
            // base64). The plain `attachments` field takes URLs only and
            // would silently drop file bytes. Omitted when empty.
            ...(d.attachments?.length
              ? {attachments_binary: buildSendpulseAttachmentsBinary(d.attachments)}
              : {}),
          },
        }),
      });
    } catch (e) {
      if (classifySendError(e) === 'unknown')
        throw new UnknownOutcomeError('SendPulse send timed out or connection dropped; outcome unknown');
      throw e;
    }
    if (!r.ok) throw new Error(`SendPulse HTTP ${r.status}${await providerErrorDetail(r)}`);
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
          ...(d.headers ? {headers: d.headers} : {}),
          ...(d.attachments?.length ? {attachment: buildBrevoAttachments(d.attachments)} : {}),
        }),
      });
    } catch (e) {
      if (classifySendError(e) === 'unknown')
        throw new UnknownOutcomeError('Brevo send timed out or connection dropped; outcome unknown');
      throw e;
    }
    if (!r.ok) throw new Error(`Brevo HTTP ${r.status}${await providerErrorDetail(r)}`);
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
              ...(d.headers ? {Headers: d.headers} : {}),
              ...(d.attachments?.length ? {Attachments: buildMailjetAttachments(d.attachments)} : {}),
            },
          ],
        }),
      });
    } catch (e) {
      if (classifySendError(e) === 'unknown')
        throw new UnknownOutcomeError('Mailjet send timed out or connection dropped; outcome unknown');
      throw e;
    }
    if (!r.ok) throw new Error(`Mailjet HTTP ${r.status}${await providerErrorDetail(r)}`);
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
        ...(d.headers ? {headers: d.headers} : {}),
        ...(d.attachments?.length ? {attachments: buildResendAttachments(d.attachments)} : {}),
      }),
    });
  } catch (e) {
    if (classifySendError(e) === 'unknown')
      throw new UnknownOutcomeError('Resend send timed out or connection dropped; outcome unknown');
    throw e;
  }
  if (!r.ok) throw new Error(`Resend HTTP ${r.status}${await providerErrorDetail(r)}`);
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
  /** Provider-confirmed sender (G-25 "Verify now" server check). */
  senderVerified: boolean;
  /** User-asserted sender (G-25: "I verified sender in provider").
   *  Sending accepts attested OR verified — attestation is the current
   *  behaviour and stays eligible; the UI shows the two states honestly. */
  senderAttested: boolean;
}

/** SendPulse free-tier message-size limit: 1 MB (G5d). Messages over
 *  this are never attempted on SendPulse — the chain skips it with a
 *  logged reason and falls through to the next provider. */
export const SENDPULSE_MAX_MESSAGE_BYTES = 1 * 1024 * 1024;

/** Approximate wire size of a send: bodies (UTF-8) + attachment bytes. */
export function messageSizeBytes(d: SendInput): number {
  let n = Buffer.byteLength(d.text || '') + Buffer.byteLength(d.html || '');
  for (const a of d.attachments || []) n += a.sizeBytes;
  return n;
}

/** Host provider-fallback flag for a workspace (G-14). Missing row or
 *  missing column (pre-migration) reads as false — the safe default. */
export async function getHostFallbackAllowed(workspaceId: string): Promise<boolean> {
  try {
    const row = await dbOne(
      'SELECT allow_host_provider_fallback FROM workspace_settings WHERE workspace_id = ?',
      [workspaceId],
    );
    return row ? Number(row.allow_host_provider_fallback) === 1 : false;
  } catch {
    return false;
  }
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

export interface SendWithFallbackOptions {
  /**
   * Manual single-provider send (F1/F2): attempt ONLY this provider,
   * never fall through to another one. A failure — disabled, sender
   * not verified, cap exhausted, unconfigured, or a definite rejection
   * — is reported honestly as `failed` with exactly one entry in
   * `attempts` naming the provider and the reason. An unknown outcome
   * (timeout) is reported as `unknown`, same as the auto path: stop,
   * never blind-resend.
   */
  onlyProvider?: ProviderName;
  /**
   * Providers the workspace has a row for with enabled = 0 (supplied by
   * the caller, which reads `provider_secrets`). In auto mode such a
   * provider is skipped ENTIRELY — no logAttempt, no recordAttemptEvent,
   * no cap check, no env-fallback attempt, no entry in `attempts` — as
   * if it were never in the chain (B-e). In manual mode a disabled pick
   * returns `failed` with one skip-reason entry in `attempts` and no
   * provider call.
   */
  disabledProviders?: ProviderName[];
  /**
   * Host env fallback gate (G-14): when false (default), a provider the
   * workspace has no row for is NOT tried via host env keys — it is
   * unconfigured. The caller (lib/service-send.ts) reads
   * workspace_settings.allow_host_provider_fallback; the live owner
   * workspace keeps true, new workspaces default to false.
   */
  allowHostProviderFallback?: boolean;
}

/**
 * Try the chain in order with ONE idempotency key. Stops on the first
 * acceptance, on the first unknown outcome, or on suppression. Definite
 * rejections (and cap-exhausted / unconfigured providers) fall through to
 * the next provider. Never sends to a suppressed recipient, never exceeds
 * a cap, never resends after an unknown outcome.
 *
 * `configs` is the workspace's enabled provider rows in chain order (the
 * caller reads `provider_secrets` and decrypts them; rows with
 * enabled = 0 are NOT in `configs` — they arrive via
 * `opts.disabledProviders` instead). Providers absent from `configs` are
 * still tried via the host env fallback when one exists — the chain order
 * is fixed regardless of workspace priority values — EXCEPT providers
 * listed in `opts.disabledProviders`, which are never attempted at all.
 *
 * `opts.onlyProvider` switches to manual mode: exactly one attempt of
 * exactly that provider. Pre-call failures (disabled / sender not
 * verified / cap exhausted / unconfigured) return `failed` with a single
 * skip-reason entry in `attempts` and NO provider call, NO durable
 * attempt event — the entry itself is the honest report. A definite
 * rejection is recorded and returned as `failed`; a timeout is
 * `unknown`. Nothing ever falls through to another provider.
 *
 * RULE 0: a skipped/disabled provider leaves no attempt trace; a manual
 * pick that fails reports the failure with the provider named. The
 * `unconfigured` attempt event is kept ONLY for providers that were
 * never connected AND have no env fallback (genuinely unconfigured).
 */
export async function sendWithFallback(
  workspaceId: string,
  input: SendInput,
  configs: ConfiguredProvider[],
  opts?: SendWithFallbackOptions,
): Promise<FallbackOutcome> {
  const attempts: FallbackAttempt[] = [];
  const byName = new Map(configs.map((c) => [c.provider, c]));
  const disabled = new Set<ProviderName>(opts?.disabledProviders ?? []);
  const onlyProvider = opts?.onlyProvider;
  const manual = onlyProvider !== undefined;
  const allowHostFallback = opts?.allowHostProviderFallback ?? false;
  const totalSizeBytes = messageSizeBytes(input);
  // Manual pick: exactly one attempt, in that provider's chain position.
  const chain: ProviderName[] = manual ? [onlyProvider] : PROVIDER_CHAIN;

  // Attachment metadata, once per send — filename + size only. Bytes and
  // base64 content are NEVER logged, and never appear in error responses.
  if (input.attachments?.length) {
    console.log(
      JSON.stringify({
        event: 'send_attachments',
        workspace_id: workspaceId,
        idempotency_key: input.idempotencyKey,
        count: input.attachments.length,
        total_bytes: input.attachments.reduce((n, a) => n + a.sizeBytes, 0),
        files: input.attachments.map((a) => ({filename: a.filename, size_bytes: a.sizeBytes})),
      }),
    );
  }

  for (const provider of chain) {
    // RULE 0 / B-e: a disabled provider is skipped ENTIRELY in auto mode
    // — no logAttempt, no recordAttemptEvent, no cap check, no
    // env-fallback attempt, no entry in `attempts`. It must be as if it
    // were never in the chain. In manual mode the pick itself is the
    // report: one skip-reason entry, no provider call, no durable
    // attempt event.
    if (disabled.has(provider)) {
      if (manual) {
        attempts.push({
          provider,
          result: 'unconfigured',
          latency_ms: 0,
          http_status: null,
          reason: 'provider is disabled for this workspace',
          cap: null,
        });
        return {outcome: 'failed', attempts};
      }
      continue;
    }
    const configured = byName.get(provider);
    // Workspace rows whose sender is neither provider-verified nor
    // user-attested are not eligible; the env fallback is only used when
    // the workspace has no row at all AND the host-fallback gate allows
    // it, so a workspace that connected a provider but has not verified
    // its sender does not silently fall back to a host key.
    if (configured && !configured.senderVerified && !configured.senderAttested) {
      const attempt: FallbackAttempt = {
        provider,
        result: 'unconfigured',
        latency_ms: 0,
        http_status: null,
        reason: 'provider connected but sender neither verified nor attested',
        cap: null,
      };
      attempts.push(attempt);
      // Manual pick: report honestly and stop — never fall through to
      // another provider, never call this one. The skip-reason entry in
      // `attempts` is the report; no durable attempt event is recorded
      // for a provider that was never called.
      if (manual) return {outcome: 'failed', attempts};
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
    const secret = resolveProviderSecret(
      provider,
      configured ? configured.secret : null,
      configured ? true : allowHostFallback,
    );
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
      // Manual pick: honest failure, no call, no durable attempt event
      // (nothing was attempted). Auto mode keeps the `unconfigured`
      // attempt event — but only here, i.e. only for a provider that was
      // never connected AND has no env fallback (genuinely unconfigured).
      // A disabled provider never reaches this branch (skipped above).
      if (manual) return {outcome: 'failed', attempts};
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
      await recordAttemptEvent(workspaceId, null, input.to, provider, input.idempotencyKey, 'unconfigured', 0, null, attempt.reason);
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
      // Manual pick: honest failure, no call, no durable attempt event.
      if (manual) return {outcome: 'failed', attempts};
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
      await recordAttemptEvent(workspaceId, null, input.to, provider, input.idempotencyKey, 'cap_exhausted', 0, cap, reason);
      continue;
    }

    // SendPulse free-tier 1 MB message-size limit (G5d): never attempt
    // SendPulse for a message over 1 MB — skip it with a logged reason
    // and fall through to the next provider. Do not attempt-and-fail.
    if (provider === 'sendpulse' && totalSizeBytes > SENDPULSE_MAX_MESSAGE_BYTES) {
      const reason = `SendPulse free-tier 1 MB message-size limit exceeded (${totalSizeBytes} bytes); skipped`;
      const attempt: FallbackAttempt = {
        provider,
        result: 'cap_exhausted',
        latency_ms: 0,
        http_status: null,
        reason,
        cap,
      };
      attempts.push(attempt);
      if (manual) return {outcome: 'failed', attempts};
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
      await recordAttemptEvent(workspaceId, null, input.to, provider, input.idempotencyKey, 'cap_exhausted', 0, cap, reason);
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
      await recordAttemptEvent(workspaceId, null, input.to, provider, input.idempotencyKey, 'accepted', latency, cap);
      return {outcome: 'accepted', provider, providerMessageId: result.providerMessageId, attempts};
    } catch (e) {
      const latency = Date.now() - started;
      const kind = classifySendError(e);
      const reason = e instanceof Error ? e.message.slice(0, 500) : 'Provider error';
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
        await recordAttemptEvent(workspaceId, null, input.to, provider, input.idempotencyKey, 'unknown', latency, cap, reason);
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
      await recordAttemptEvent(workspaceId, null, input.to, provider, input.idempotencyKey, 'rejected', latency, cap, reason);
      // Definite rejection (provider answered): fall through to next provider.
    }
  }
  return {outcome: 'failed', attempts};
}
