// Gmail backup mirror — OAuth (Phase 4, PRODUCTION-PLAN.md §7, decision D11).
//
// A SEPARATE OAuth flow from sign-in. Sign-in (lib/auth.ts) requests only
// `openid email profile` and is never touched by this module. This flow
// requests the restricted scopes `gmail.insert` + `gmail.labels` on the
// same GCP project (workmail-515413, consent screen already "In production",
// so refresh tokens do not expire after 7 days). The Gmail scopes are
// NEVER requested at sign-in.
//
// The refresh token is encrypted with lib/crypto.ts (AES-256-GCM, same as
// provider secrets) and stored in D1 (gmail_oauth_tokens), workspace-scoped,
// owner-only. It is never logged, never returned to the client, and never
// appears in any response body.
//
// Personal-use boundary (research §7.3 / plan §7.1 docs): the mirror is
// offered only to the workspace owner for their own Gmail. If Google ever
// requires OAuth verification / CASA for the shared client, the mirror is
// disabled with a notice — never silently.
import {randomBytes} from 'node:crypto';
import {dbOne, dbRun, nowIso} from '@/lib/db';
import {decryptSecret, encryptSecret} from '@/lib/crypto';

/** Restricted scopes for the mirror. `gmail.labels` lets the import create the WorkMail labels; `gmail.insert` is the import scope. */
export const GMAIL_MIRROR_SCOPES = [
  'https://www.googleapis.com/auth/gmail.insert',
  'https://www.googleapis.com/auth/gmail.labels',
];

export const GMAIL_MIRROR_STATE_COOKIE = 'wm_gmail_state';

function appUrl(): string {
  return process.env.NEXT_PUBLIC_APP_URL || '';
}

export function gmailMirrorRedirectUri(): string {
  return `${appUrl()}/api/gmail-mirror/callback`;
}

/** State payload: a random nonce (checked against the state cookie) plus the workspace the grant is for. */
export function buildGmailMirrorState(workspaceId: string): {state: string; nonce: string} {
  const nonce = randomBytes(16).toString('base64url');
  const state = Buffer.from(JSON.stringify({nonce, workspace_id: workspaceId}), 'utf8').toString('base64url');
  return {state, nonce};
}

export function parseGmailMirrorState(raw: string | null): {nonce: string; workspaceId: string} | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as {
      nonce?: unknown;
      workspace_id?: unknown;
    };
    if (typeof parsed.nonce !== 'string' || typeof parsed.workspace_id !== 'string') return null;
    return {nonce: parsed.nonce, workspaceId: parsed.workspace_id};
  } catch {
    return null;
  }
}

/** Google consent URL for the mirror. `prompt=consent` forces a fresh refresh token on every connect (Google only returns one on the first grant otherwise). */
export function gmailMirrorAuthUrl(state: string): string {
  const q = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID || '',
    redirect_uri: gmailMirrorRedirectUri(),
    response_type: 'code',
    scope: GMAIL_MIRROR_SCOPES.join(' '),
    access_type: 'offline',
    prompt: 'consent',
    state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${q.toString()}`;
}

export function gmailMirrorStateCookie(nonce: string): string {
  return `${GMAIL_MIRROR_STATE_COOKIE}=${encodeURIComponent(nonce)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=600; Secure`;
}

export function clearGmailMirrorStateCookie(): string {
  return `${GMAIL_MIRROR_STATE_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0; Secure`;
}

async function postForm(url: string, params: Record<string, string>): Promise<any> {
  const r = await fetch(url, {
    method: 'POST',
    headers: {'Content-Type': 'application/x-www-form-urlencoded'},
    body: new URLSearchParams(params),
    signal: AbortSignal.timeout(15000),
  });
  const j = await r.json().catch(() => null);
  if (!r.ok) {
    const err = j?.error_description || j?.error || `Google token request failed (HTTP ${r.status})`;
    throw new Error(err);
  }
  return j;
}

/** Exchange the callback code for tokens. Returns the refresh token (caller stores it encrypted) and the Google account email. */
export async function exchangeGmailMirrorCode(code: string): Promise<{refreshToken: string; email: string | null}> {
  const tokens = await postForm('https://oauth2.googleapis.com/token', {
    code,
    client_id: process.env.GOOGLE_CLIENT_ID || '',
    client_secret: process.env.GOOGLE_CLIENT_SECRET || '',
    redirect_uri: gmailMirrorRedirectUri(),
    grant_type: 'authorization_code',
  });
  if (!tokens.refresh_token) throw new Error('Google did not return a refresh token — reconnect and approve again.');
  let email: string | null = null;
  if (tokens.access_token) {
    try {
      const profile = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/profile', {
        headers: {Authorization: `Bearer ${tokens.access_token}`},
        signal: AbortSignal.timeout(15000),
      });
      const pj = await profile.json().catch(() => null);
      if (pj?.emailAddress) email = String(pj.emailAddress);
    } catch {
      email = null;
    }
  }
  return {refreshToken: String(tokens.refresh_token), email};
}

export async function storeGmailMirrorToken(
  workspaceId: string,
  userId: string,
  refreshToken: string,
  googleEmail: string | null,
): Promise<void> {
  const cipher = encryptSecret(refreshToken);
  const now = nowIso();
  await dbRun(
    `INSERT INTO gmail_oauth_tokens (workspace_id, user_id, refresh_token_ciphertext, google_email, auto_mirror, created_at, updated_at)
     VALUES (?, ?, ?, ?, 0, ?, ?)
     ON CONFLICT(workspace_id) DO UPDATE SET user_id = excluded.user_id, refresh_token_ciphertext = excluded.refresh_token_ciphertext,
       google_email = excluded.google_email, updated_at = excluded.updated_at`,
    [workspaceId, userId, cipher, googleEmail, now, now],
  );
}

export interface GmailMirrorTokenRow {
  workspaceId: string;
  userId: string;
  googleEmail: string | null;
  autoMirror: boolean;
}

/** Stored-token metadata only — the refresh token itself never leaves this module. */
export async function getGmailMirrorTokenRow(workspaceId: string): Promise<GmailMirrorTokenRow | null> {
  const row = await dbOne(
    'SELECT workspace_id, user_id, google_email, auto_mirror FROM gmail_oauth_tokens WHERE workspace_id = ?',
    [workspaceId],
  );
  if (!row) return null;
  return {
    workspaceId: String(row.workspace_id),
    userId: String(row.user_id),
    googleEmail: row.google_email ? String(row.google_email) : null,
    autoMirror: row.auto_mirror === 1,
  };
}

/** Mint a short-lived access token from the stored refresh token. Returns null when no token is stored or Google rejects the refresh grant (revoked / password-change revocation) — the caller surfaces "reconnect Gmail backup". The refresh token value is never logged. */
export async function getGmailAccessToken(workspaceId: string): Promise<string | null> {
  const row = await dbOne('SELECT refresh_token_ciphertext FROM gmail_oauth_tokens WHERE workspace_id = ?', [workspaceId]);
  if (!row) return null;
  let refreshToken: string;
  try {
    refreshToken = decryptSecret(String(row.refresh_token_ciphertext));
  } catch {
    return null;
  }
  try {
    const tokens = await postForm('https://oauth2.googleapis.com/token', {
      client_id: process.env.GOOGLE_CLIENT_ID || '',
      client_secret: process.env.GOOGLE_CLIENT_SECRET || '',
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    });
    if (!tokens.access_token) return null;
    return String(tokens.access_token);
  } catch {
    return null;
  }
}

export async function setGmailAutoMirror(workspaceId: string, on: boolean): Promise<void> {
  await dbRun('UPDATE gmail_oauth_tokens SET auto_mirror = ?, updated_at = ? WHERE workspace_id = ?', [
    on ? 1 : 0,
    nowIso(),
    workspaceId,
  ]);
}

/** Revoke the stored grant at Google (best-effort) and delete the D1 row. The row is deleted even if the revoke call fails — a stale ciphertext must not linger. */
export async function revokeGmailMirrorToken(workspaceId: string): Promise<void> {
  const row = await dbOne('SELECT refresh_token_ciphertext FROM gmail_oauth_tokens WHERE workspace_id = ?', [workspaceId]);
  if (row) {
    try {
      const refreshToken = decryptSecret(String(row.refresh_token_ciphertext));
      await postForm('https://oauth2.googleapis.com/revoke', {token: refreshToken});
    } catch {
      // Revoke is best-effort; the local delete below is what disconnects.
    }
  }
  await dbRun('DELETE FROM gmail_oauth_tokens WHERE workspace_id = ?', [workspaceId]);
}
