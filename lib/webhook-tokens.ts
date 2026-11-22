// WorkMail delivery-webhook tokens (lib/webhook-tokens.ts).
//
// Per-workspace delivery-webhook tokens (G-01, decision D6), stored in
// `webhook_tokens` (migration 0003) — a SEPARATE table from `api_keys`
// so the v1 key surface stays clean:
//   - Format: `wm_hook_<43 base64url chars>` (32 random bytes).
//     The full token is shown ONCE at creation; only its SHA-256 hash
//     is stored in `webhook_tokens.token_hash`. No GET ever returns a
//     token value.
//   - One token belongs to exactly one workspace. The delivery
//     webhook derives the workspace from the token and REJECTS a
//     mismatched `workspace_id` in the body, so a token from workspace
//     A can never write delivery events or suppressions for workspace B.
//   - Comparison is constant-time (timingSafeEqual over the SHA-256
//     digests); 401 responses never leak workspace details.
//   - `last_used_at` is updated best-effort and failure-isolated.
//   - The old shared DELIVERY_WEBHOOK_TOKEN env var is retired: the
//     webhook no longer reads it. Provider-native signature
//     verification (Brevo/Mailjet/Resend/SendPulse) is a recorded
//     follow-up, not wired today (see docs/SECURITY.md).
import {createHash, randomBytes, timingSafeEqual} from 'node:crypto';
import {dbOne, dbRun, newId, nowIso} from '@/lib/db';

export const WEBHOOK_TOKEN_PREFIX = 'wm_hook_';

export interface WebhookTokenAuth {
  tokenId: string;
  workspaceId: string;
  createdBy: string;
  label: string;
}

export type WebhookAuthResult =
  | {ok: true; auth: WebhookTokenAuth}
  | {ok: false; status: 401; error: string};

/** SHA-256 hex of a plaintext webhook token. Stored in `webhook_tokens.token_hash`. */
export function hashWebhookToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Generate a new plaintext token. The caller must store only its hash. */
export function generateWebhookToken(): {token: string; prefix: string; hash: string} {
  const token = WEBHOOK_TOKEN_PREFIX + randomBytes(32).toString('base64url');
  return {token, prefix: token.slice(0, 12), hash: hashWebhookToken(token)};
}

function hashesEqual(aHex: string, bHex: string): boolean {
  const a = Buffer.from(aHex, 'hex');
  const b = Buffer.from(bHex, 'hex');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Authenticate a delivery-webhook request from its Authorization header.
 * Returns 401 for a missing / malformed / unknown / revoked / expired
 * token. The workspace comes from the token row — never from the body.
 */
export async function authenticateWebhookToken(req: Request): Promise<WebhookAuthResult> {
  const header = req.headers.get('authorization') || '';
  const supplied = header.replace(/^Bearer\s+/i, '').trim();
  if (!header || !/^Bearer\s+/i.test(header) || !supplied)
    return {ok: false, status: 401, error: 'Unauthorized'};
  if (!supplied.startsWith(WEBHOOK_TOKEN_PREFIX))
    return {ok: false, status: 401, error: 'Unauthorized'};

  const computedHash = hashWebhookToken(supplied);
  let row;
  try {
    row = await dbOne(
      'SELECT id, workspace_id, label, token_hash, created_by, expires_at, revoked_at FROM webhook_tokens WHERE token_hash = ?',
      [computedHash],
    );
  } catch {
    return {ok: false, status: 401, error: 'Unauthorized'};
  }
  if (!row || !hashesEqual(String(row.token_hash), computedHash))
    return {ok: false, status: 401, error: 'Unauthorized'};
  if (row.revoked_at) return {ok: false, status: 401, error: 'Unauthorized'};
  if (row.expires_at && String(row.expires_at) <= nowIso())
    return {ok: false, status: 401, error: 'Unauthorized'};

  const auth: WebhookTokenAuth = {
    tokenId: String(row.id),
    workspaceId: String(row.workspace_id),
    createdBy: String(row.created_by),
    label: String(row.label || ''),
  };
  // Best-effort, failure-isolated: never let this write fail the call.
  dbRun('UPDATE webhook_tokens SET last_used_at = ? WHERE id = ?', [nowIso(), auth.tokenId]).catch(() => {});
  return {ok: true, auth};
}

/** Create the DB row for a new token. Returns the row id (never the token). */
export async function insertWebhookToken(input: {
  workspaceId: string;
  label: string;
  prefix: string;
  hash: string;
  createdBy: string;
  expiresAt: string | null;
}): Promise<string> {
  const id = newId();
  await dbRun(
    'INSERT INTO webhook_tokens (id, workspace_id, label, token_prefix, token_hash, created_by, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [id, input.workspaceId, input.label, input.prefix, input.hash, input.createdBy, input.expiresAt, nowIso()],
  );
  return id;
}
