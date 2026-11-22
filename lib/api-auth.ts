// WorkMail v1 API authentication (lib/api-auth.ts).
//
// API keys are per-workspace, hashed, scoped, revocable (decision D4):
//   - Format: `wm_live_<43 base64url chars>` (32 random bytes).
//     The full key is shown ONCE at creation; only its SHA-256 hash is
//     stored in `api_keys.key_hash`. No GET ever returns a key value.
//   - Scopes: `send` (POST /api/v1/send), `messages:read`
//     (GET /api/v1/messages). A key can only touch its own workspace.
//   - The v1 API NEVER accepts OPS_CRON_TOKEN and NEVER accepts a
//     session cookie: this module reads only the Authorization header,
//     and a token that is not a stored `wm_live_` key hash is a 401.
//     (The OPS token is not even compared here — it simply has no
//     matching row, so it cannot authenticate. An explicit guard below
//     rejects it before the lookup so it can never be confused with a
//     key, even if a future code path hashed it.)
//   - Comparison is constant-time (timingSafeEqual over the SHA-256
//     digests); 401/403 responses never leak workspace details.
//   - `last_used_at` is updated best-effort and failure-isolated: a
//     failing bookkeeping write must never fail an authenticated call.
import {createHash, randomBytes, timingSafeEqual} from 'node:crypto';
import {dbOne, dbRun, jparse, newId, nowIso} from '@/lib/db';

export const API_KEY_PREFIX = 'wm_live_';
export type ApiScope = 'send' | 'messages:read';
export const API_SCOPES: ApiScope[] = ['send', 'messages:read'];

export interface ApiKeyAuth {
  keyId: string;
  workspaceId: string;
  createdBy: string;
  scopes: ApiScope[];
  label: string;
}

export type ApiAuthResult =
  | {ok: true; auth: ApiKeyAuth}
  | {ok: false; status: 401 | 403; error: string};

/** SHA-256 hex of a plaintext API key. Stored in `api_keys.key_hash`. */
export function hashApiKey(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

/** Generate a new plaintext key. The caller must store only its hash. */
export function generateApiKey(): {key: string; prefix: string; hash: string} {
  const key = API_KEY_PREFIX + randomBytes(32).toString('base64url');
  return {key, prefix: key.slice(0, 12), hash: hashApiKey(key)};
}

function hashesEqual(aHex: string, bHex: string): boolean {
  const a = Buffer.from(aHex, 'hex');
  const b = Buffer.from(bHex, 'hex');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Authenticate a v1 request from its Authorization header.
 * Returns 401 for a missing / malformed / unknown / revoked / expired
 * key, and 403 (via `requireApiScope`) for a valid key without the
 * scope the route needs. Error strings are generic on purpose: they
 * never name a workspace, a key, or a reason that would let a caller
 * probe for another tenant's key.
 */
export async function authenticateApiKey(req: Request): Promise<ApiAuthResult> {
  const header = req.headers.get('authorization') || '';
  const supplied = header.replace(/^Bearer\s+/i, '').trim();
  if (!header || !/^Bearer\s+/i.test(header) || !supplied)
    return {ok: false, status: 401, error: 'Unauthorized'};
  // Never accept the ops/service token here, whatever it looks like.
  const opsToken = process.env.OPS_CRON_TOKEN || '';
  if (opsToken && supplied === opsToken)
    return {ok: false, status: 401, error: 'Unauthorized'};
  if (!supplied.startsWith(API_KEY_PREFIX))
    return {ok: false, status: 401, error: 'Unauthorized'};

  const computedHash = hashApiKey(supplied);
  let row;
  try {
    row = await dbOne(
      'SELECT id, workspace_id, label, key_hash, scopes, created_by, expires_at, revoked_at FROM api_keys WHERE key_hash = ?',
      [computedHash],
    );
  } catch {
    return {ok: false, status: 401, error: 'Unauthorized'};
  }
  if (!row || !hashesEqual(String(row.key_hash), computedHash))
    return {ok: false, status: 401, error: 'Unauthorized'};
  if (row.revoked_at) return {ok: false, status: 401, error: 'Unauthorized'};
  if (row.expires_at && String(row.expires_at) <= nowIso())
    return {ok: false, status: 401, error: 'Unauthorized'};

  const scopes = jparse<ApiScope[]>(String(row.scopes || '[]'), []).filter(
    (s): s is ApiScope => s === 'send' || s === 'messages:read',
  );
  const auth: ApiKeyAuth = {
    keyId: String(row.id),
    workspaceId: String(row.workspace_id),
    createdBy: String(row.created_by),
    scopes,
    label: String(row.label || ''),
  };
  // Best-effort, failure-isolated: never let this write fail the call.
  dbRun('UPDATE api_keys SET last_used_at = ? WHERE id = ?', [nowIso(), auth.keyId]).catch(() => {});
  return {ok: true, auth};
}

/** Scope gate: a valid key without the required scope gets a 403. */
export function requireApiScope(auth: ApiKeyAuth, scope: ApiScope): ApiAuthResult {
  if (!auth.scopes.includes(scope))
    return {ok: false, status: 403, error: 'This API key does not have the required scope.'};
  return {ok: true, auth};
}

/** Convenience: authenticate + scope-check in one call. */
export async function authenticateApiKeyWithScope(req: Request, scope: ApiScope): Promise<ApiAuthResult> {
  const result = await authenticateApiKey(req);
  if (!result.ok) return result;
  return requireApiScope(result.auth, scope);
}

/** Create the DB row for a new key. Returns the row id (never the key). */
export async function insertApiKey(input: {
  workspaceId: string;
  label: string;
  prefix: string;
  hash: string;
  scopes: ApiScope[];
  createdBy: string;
  expiresAt: string | null;
}): Promise<string> {
  const id = newId();
  await dbRun(
    'INSERT INTO api_keys (id, workspace_id, label, key_prefix, key_hash, scopes, created_by, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [id, input.workspaceId, input.label, input.prefix, input.hash, JSON.stringify(input.scopes), input.createdBy, input.expiresAt, nowIso()],
  );
  return id;
}
